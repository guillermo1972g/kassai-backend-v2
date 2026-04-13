// KASS.AI Agent Loop v2 - Capital management + Take profit
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const CONFIG = {
  INTERVAL_MS: 90 * 1000,
  MAX_POSITIONS: 3,
  STOP_LOSS_PCT: 0.20,
  MIN_EDGE_PCT: 0.15,
  STOCK_WATCHLIST: ['AAPL','TSLA','NVDA','MSFT','AMZN','GOOGL','META','AMD','SPY','QQQ'],
  CRYPTO_WATCHLIST: ['BTC/USD','ETH/USD','SOL/USD','DOGE/USD'],
};

let agentState = {
  running: false, intervalId: null, cycleCount: 0,
  lastCycle: null, lastAction: 'NONE', status: 'STOPPED', marketMode: 'UNKNOWN',
  capitalLimit: Infinity,
  takeProfitTarget: null,
};

function setCapital(amount) { agentState.capitalLimit = parseFloat(amount); console.log('[AGENT] Capital set to $' + amount); }
function setTakeProfit(target) { agentState.takeProfitTarget = parseFloat(target); console.log('[AGENT] Take profit set at $' + target); }

function isStockMarketOpen() {
  const ny = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = ny.getDay(); const t = ny.getHours() * 60 + ny.getMinutes();
  if (day === 0 || day === 6) return false;
  return t >= 570 && t < 960;
}
function getActiveMarkets() {
  const open = isStockMarketOpen();
  return { stocks: open, crypto: true, mode: open ? 'STOCKS+CRYPTO' : 'CRYPTO ONLY' };
}
async function log(level, message, data = {}) {
  console.log('[KASS.AI][' + level + '] ' + message);
  try { await supabase.from('logs').insert({ level, message, data: JSON.stringify(data), created_at: new Date().toISOString(), source: 'agent-loop' }); } catch (e) {}
}
async function getMarketData(alpaca, markets) {
  const prices = {};
  if (markets.stocks) { for (const t of CONFIG.STOCK_WATCHLIST) { try { const q = await alpaca.getLatestTrade(t); prices[t] = q.Price; } catch (e) {} } }
  for (const t of CONFIG.CRYPTO_WATCHLIST) { try { const q = await alpaca.getLatestCryptoBars(t, { timeframe: '1Min', limit: 1 }); const b = q[t]; if (b && b.length > 0) prices[t] = b[b.length-1].c; } catch (e) {} }
  return prices;
}
async function getAccountStatus(alpaca) {
  const account = await alpaca.getAccount(); const positions = await alpaca.getPositions();
  return { equity: parseFloat(account.equity), cash: parseFloat(account.cash), buyingPower: parseFloat(account.buying_power), positionCount: positions.length, positions };
}
async function checkStopLoss(alpaca, account) {
  for (const pos of account.positions) {
    if (parseFloat(pos.unrealized_plpc) <= -CONFIG.STOP_LOSS_PCT) {
      try { await alpaca.closePosition(pos.symbol); await log('WARN', 'STOP LOSS: ' + pos.symbol); } catch (e) {}
    }
  }
}
async function checkTakeProfit(alpaca, account, sendWhatsApp) {
  if (!agentState.takeProfitTarget) return;
  if (account.equity >= agentState.takeProfitTarget) {
    await log('INFO', 'TAKE PROFIT reached: $' + account.equity.toFixed(2));
    const positions = account.positions;
    for (const pos of positions) { try { await alpaca.closePosition(pos.symbol); } catch(e) {} }
    const msg = '🎯 *TAKE PROFIT ALCANZADO!*\n\nPortfolio: *$' + account.equity.toFixed(2) + '*\nObjetivo: *$' + agentState.takeProfitTarget.toFixed(2) + '*\n\n' + positions.length + ' posiciones liquidadas.\nFondos disponibles en tu cuenta.\n\n_KASS.AI Trading System_';
    if (sendWhatsApp) await sendWhatsApp(msg);
    agentState.takeProfitTarget = null;
    agentState.lastAction = 'TAKE PROFIT - todas las posiciones liquidadas';
  }
}
async function analyzeWithClaude(prices, account, markets) {
  const availableCash = Math.min(account.cash, agentState.capitalLimit);
  const maxPerTrade = Math.floor(availableCash / CONFIG.MAX_POSITIONS);
  const sys = 'You are KASS.AI, elite autonomous trading agent. ' +
    'Available for trading: $' + availableCash.toFixed(2) + '. Max per trade: $' + maxPerTrade + '. ' +
    'Open positions: ' + account.positionCount + '/' + CONFIG.MAX_POSITIONS + '. Mode: ' + markets.mode + '. ' +
    (markets.stocks ? '' : 'STOCK MARKET CLOSED - only trade crypto (BTC/USD,ETH/USD,SOL/USD,DOGE/USD). ') +
    'Min edge: ' + (CONFIG.MIN_EDGE_PCT*100) + '%. Calculate qty based on price and max budget $' + maxPerTrade + '. ' +
    'Respond ONLY in valid JSON: {"recommendation":"BUY|SELL|PASS","asset":null,"qty":null,"price":null,"target":null,"stopLoss":null,"edge":0,"confidence":"HIGH|MEDIUM|LOW","reasoning":"","marketAnalysis":"","assetType":"stock|crypto"}';
  const response = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 1000, system: sys, messages: [{ role: 'user', content: 'Prices: ' + JSON.stringify(prices) + ' Positions: ' + JSON.stringify(account.positions.map(p => ({symbol:p.symbol,qty:p.qty,pl:p.unrealized_plpc}))) }] });
  try { const m = response.content[0].text.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : { recommendation: 'PASS', edge: 0 }; } catch (e) { return { recommendation: 'PASS', edge: 0 }; }
}
async function executeTrade(alpaca, analysis, account) {
  const { recommendation, asset, qty, price, target, stopLoss, edge, reasoning, assetType } = analysis;
  if (!asset || !qty || edge < CONFIG.MIN_EDGE_PCT || account.positionCount >= CONFIG.MAX_POSITIONS) return null;
  const cost = (price || 0) * qty;
  const availableCash = Math.min(account.cash, agentState.capitalLimit);
  if (cost > availableCash) { await log('WARN', 'Insufficient budget: $' + cost.toFixed(2) + ' vs $' + availableCash.toFixed(2)); return null; }
  try {
    const order = await alpaca.createOrder({ symbol: asset, qty: assetType === 'crypto' ? qty : Math.floor(qty), side: recommendation.toLowerCase(), type: 'market', time_in_force: assetType === 'crypto' ? 'gtc' : 'day' });
    await supabase.from('positions').insert({ symbol: asset, qty, entry_price: price, target_price: target, stop_loss: stopLoss, edge, reasoning, order_id: order.id, status: 'open', asset_type: assetType || 'stock', created_at: new Date().toISOString() }).catch(() => {});
    await log('INFO', 'ORDER: ' + recommendation + ' ' + qty + 'x ' + asset + ' $' + cost.toFixed(2));
    return order;
  } catch (e) { await log('ERROR', 'Order failed: ' + e.message); return null; }
}
async function runCycle(alpaca, sendWhatsApp) {
  agentState.cycleCount++;
  agentState.lastCycle = new Date().toISOString();
  const markets = getActiveMarkets();
  agentState.marketMode = markets.mode;
  await log('INFO', 'Cycle #' + agentState.cycleCount + ' | ' + markets.mode);
  try {
    const account = await getAccountStatus(alpaca);
    await checkStopLoss(alpaca, account);
    await checkTakeProfit(alpaca, account, sendWhatsApp);
    const prices = await getMarketData(alpaca, markets);
    if (Object.keys(prices).length === 0) { agentState.status = 'WAITING'; agentState.lastAction = 'Esperando datos de mercado'; return; }
    const analysis = await analyzeWithClaude(prices, account, markets);
    if (analysis.recommendation === 'BUY' || analysis.recommendation === 'SELL') {
      const order = await executeTrade(alpaca, analysis, account);
      agentState.lastAction = order ? (analysis.recommendation + ' ' + analysis.asset) : (analysis.recommendation + ' BLOCKED');
    } else {
      agentState.lastAction = 'PASS — ' + (analysis.reasoning || '').substring(0, 80);
    }
    agentState.status = 'RUNNING';
  } catch (e) { agentState.status = 'ERROR'; await log('ERROR', 'Cycle failed: ' + e.message); }
}
let _sendWhatsApp = null;
function startAgent(alpaca, sendWA) {
  if (agentState.running) return { success: false, message: 'Already running' };
  if (sendWA) _sendWhatsApp = sendWA;
  agentState.running = true; agentState.status = 'RUNNING'; agentState.cycleCount = 0;
  log('INFO', 'KASS.AI v2 started - Capital: ' + (agentState.capitalLimit === Infinity ? 'unlimited' : '$' + agentState.capitalLimit));
  runCycle(alpaca, _sendWhatsApp);
  agentState.intervalId = setInterval(() => runCycle(alpaca, _sendWhatsApp), CONFIG.INTERVAL_MS);
  return { success: true, message: 'Agent started', interval: CONFIG.INTERVAL_MS };
}
function stopAgent() {
  if (!agentState.running) return { success: false, message: 'Not running' };
  clearInterval(agentState.intervalId); agentState.running = false; agentState.status = 'STOPPED'; agentState.intervalId = null;
  return { success: true, message: 'Agent stopped' };
}
function getAgentStatus() {
  return { ...agentState, intervalId: agentState.intervalId ? 'ACTIVE' : null, config: CONFIG, marketOpen: isStockMarketOpen() };
}
module.exports = { startAgent, stopAgent, getAgentStatus, setCapital, setTakeProfit };