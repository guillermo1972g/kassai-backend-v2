// ============================================================
// KASS.AI — Autonomous Agent Loop
// Runs every 90 seconds, scans market, decides, executes
// Rules: min 15% edge, max 3 positions, 20% stop, $500 limit
// ============================================================

const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const CONFIG = {
  INTERVAL_MS: 90 * 1000,
  MAX_POSITIONS: 3,
  STOP_LOSS_PCT: 0.20,
  MIN_EDGE_PCT: 0.15,
  CAPITAL_LIMIT: 500,
  WATCHLIST: ['AAPL', 'TSLA', 'NVDA', 'MSFT', 'AMZN', 'GOOGL', 'META', 'AMD', 'SPY', 'QQQ'],
};

let agentState = {
  running: false,
  intervalId: null,
  cycleCount: 0,
  lastCycle: null,
  lastAction: 'NONE',
  status: 'STOPPED',
};

async function log(level, message, data = {}) {
  console.log(`[KASS.AI][${level}] ${message}`, data);
  try {
    await supabase.from('logs').insert({
      level, message,
      data: JSON.stringify(data),
      created_at: new Date().toISOString(),
      source: 'agent-loop'
    });
  } catch (e) {}
}

async function getMarketData(alpaca) {
  const prices = {};
  for (const ticker of CONFIG.WATCHLIST) {
    try {
      const quote = await alpaca.getLatestTrade(ticker);
      prices[ticker] = quote.Price;
    } catch (e) {}
  }
  return prices;
}

async function getAccountStatus(alpaca) {
  const account = await alpaca.getAccount();
  const positions = await alpaca.getPositions();
  return {
    equity: parseFloat(account.equity),
    cash: parseFloat(account.cash),
    buyingPower: parseFloat(account.buying_power),
    positionCount: positions.length,
    positions,
  };
}

async function checkStopLoss(alpaca, account) {
  const closed = [];
  for (const pos of account.positions) {
    const pct = parseFloat(pos.unrealized_plpc);
    if (pct <= -CONFIG.STOP_LOSS_PCT) {
      try {
        await alpaca.closePosition(pos.symbol);
        closed.push({ symbol: pos.symbol, pnl: pct });
        await log('WARN', `STOP LOSS: ${pos.symbol} at ${(pct*100).toFixed(1)}%`);
      } catch (e) {
        await log('ERROR', `Failed to close ${pos.symbol}: ${e.message}`);
      }
    }
  }
  return closed;
}

async function analyzeWithClaude(prices, account) {
  const systemPrompt = `You are KASS.AI, an elite autonomous trading agent.
Capital limit: $${CONFIG.CAPITAL_LIMIT}. Available cash: $${account.cash.toFixed(2)}.
Open positions: ${account.positionCount}/${CONFIG.MAX_POSITIONS}.
Rules: minimum ${CONFIG.MIN_EDGE_PCT*100}% expected edge, max ${CONFIG.MAX_POSITIONS} positions.
Only recommend a trade if edge > ${CONFIG.MIN_EDGE_PCT*100}%, positions < ${CONFIG.MAX_POSITIONS}, and risk/reward >= 1:2.
Respond ONLY in valid JSON:
{"recommendation":"BUY|SELL|PASS","asset":null,"qty":null,"price":null,"target":null,"stopLoss":null,"edge":0,"confidence":"HIGH|MEDIUM|LOW","reasoning":"","marketAnalysis":""}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    system: systemPrompt,
    messages: [{ role: 'user', content: `Prices: ${JSON.stringify(prices)}\nPositions: ${JSON.stringify(account.positions.map(p=>({symbol:p.symbol,qty:p.qty,pl:p.unrealized_plpc})))}\nMake your trading decision.` }]
  });

  const text = response.content[0].text;
  try {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : { recommendation: 'PASS', edge: 0 };
  } catch (e) {
    return { recommendation: 'PASS', edge: 0 };
  }
}

async function executeTrade(alpaca, analysis, account) {
  const { recommendation, asset, qty, price, target, stopLoss, edge, reasoning } = analysis;
  if (!asset || !qty) return null;
  if (edge < CONFIG.MIN_EDGE_PCT) { await log('INFO', `Edge ${(edge*100).toFixed(1)}% below minimum`); return null; }
  if (account.positionCount >= CONFIG.MAX_POSITIONS) { await log('INFO', 'Max positions reached'); return null; }
  const cost = (price || 0) * qty;
  if (cost > account.cash || cost > CONFIG.CAPITAL_LIMIT) { await log('WARN', `Insufficient funds: $${cost.toFixed(2)} needed`); return null; }

  try {
    const order = await alpaca.createOrder({ symbol: asset, qty, side: recommendation.toLowerCase(), type: 'market', time_in_force: 'day' });
    await supabase.from('positions').insert({ symbol: asset, qty, entry_price: price, target_price: target, stop_loss: stopLoss, edge, reasoning, order_id: order.id, status: 'open', created_at: new Date().toISOString() }).catch(()=>{});
    await log('INFO', `ORDER EXECUTED: ${recommendation} ${qty}x ${asset} @ ~$${price}`, { order_id: order.id });
    return order;
  } catch (e) {
    await log('ERROR', `Order failed: ${e.message}`);
    return null;
  }
}

async function runCycle(alpaca) {
  agentState.cycleCount++;
  agentState.lastCycle = new Date().toISOString();
  await log('INFO', `Cycle #${agentState.cycleCount} starting...`);
  try {
    const account = await getAccountStatus(alpaca);
    const stopped = await checkStopLoss(alpaca, account);
    if (stopped.length > 0) agentState.lastAction = `STOP_LOSS: ${stopped.map(s=>s.symbol).join(', ')}`;
    const prices = await getMarketData(alpaca);
    if (Object.keys(prices).length === 0) { await log('WARN', 'No market data — skipping'); return; }
    const analysis = await analyzeWithClaude(prices, account);
    await log('INFO', `Decision: ${analysis.recommendation} | Edge: ${((analysis.edge||0)*100).toFixed(1)}% | ${analysis.asset||'no asset'}`);
    if (analysis.recommendation === 'BUY' || analysis.recommendation === 'SELL') {
      const order = await executeTrade(alpaca, analysis, account);
      agentState.lastAction = order ? `${analysis.recommendation} ${analysis.asset}` : `${analysis.recommendation} BLOCKED`;
    } else {
      agentState.lastAction = `PASS — ${(analysis.reasoning||'').substring(0,80)}`;
    }
    agentState.status = 'RUNNING';
    await log('INFO', `Cycle #${agentState.cycleCount} complete. Action: ${agentState.lastAction}`);
  } catch (e) {
    agentState.status = 'ERROR';
    await log('ERROR', `Cycle failed: ${e.message}`);
  }
}

function startAgent(alpaca) {
  if (agentState.running) return { success: false, message: 'Already running' };
  agentState.running = true;
  agentState.status = 'RUNNING';
  agentState.cycleCount = 0;
  log('INFO', 'KASS.AI Agent started');
  runCycle(alpaca);
  agentState.intervalId = setInterval(() => runCycle(alpaca), CONFIG.INTERVAL_MS);
  return { success: true, message: 'Agent started', interval: CONFIG.INTERVAL_MS };
}

function stopAgent() {
  if (!agentState.running) return { success: false, message: 'Not running' };
  clearInterval(agentState.intervalId);
  agentState.running = false;
  agentState.status = 'STOPPED';
  agentState.intervalId = null;
  log('INFO', 'KASS.AI Agent stopped');
  return { success: true, message: 'Agent stopped' };
}

function getAgentStatus() {
  return { ...agentState, intervalId: agentState.intervalId ? 'ACTIVE' : null, config: CONFIG };
}

module.exports = { startAgent, stopAgent, getAgentStatus };