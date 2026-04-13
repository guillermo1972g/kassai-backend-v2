// KASS.AI Agent Loop v2 - Market hours + Crypto 24/7
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const CONFIG = {
  INTERVAL_MS: 90 * 1000,
  MAX_POSITIONS: 3,
  STOP_LOSS_PCT: 0.20,
  MIN_EDGE_PCT: 0.15,
  CAPITAL_LIMIT: Infinity,
  STOCK_WATCHLIST: ['AAPL','TSLA','NVDA','MSFT','AMZN','GOOGL','META','AMD','SPY','QQQ'],
  CRYPTO_WATCHLIST: ['BTC/USD','ETH/USD','SOL/USD','DOGE/USD'],
};
let agentState = { running: false, intervalId: null, cycleCount: 0, lastCycle: null, lastAction: 'NONE', status: 'STOPPED', marketMode: 'UNKNOWN' };

function isStockMarketOpen() {
  const now = new Date();
  const ny = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
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
  const closed = [];
  for (const pos of account.positions) {
    const pct = parseFloat(pos.unrealized_plpc);
    if (pct <= -CONFIG.STOP_LOSS_PCT) { try { await alpaca.closePosition(pos.symbol); closed.push({ symbol: pos.symbol, pnl: pct }); await log('WARN', 'STOP LOSS: ' + pos.symbol); } catch (e) {} }
  }
  return closed;
}
async function analyzeWithClaude(prices, account, markets) {
  const maxPerTrade = Math.floor(account.cash / CONFIG.MAX_POSITIONS);
  const sys = 'You are KASS.AI, elite autonomous trading agent. ' +
    'Available cash: $' + account.cash.toFixed(2) + '. Max per trade: $' + maxPerTrade + '. ' +
    'Positions: ' + account.positionCount + '/' + CONFIG.MAX_POSITIONS + '. Mode: ' + markets.mode + '. ' +
    (markets.stocks ? '' : 'STOCK MARKET CLOSED - trade crypto only (BTC/USD,ETH/USD,SOL/USD,DOGE/USD). ') +
    'Min edge: ' + (CONFIG.MIN_EDGE_PCT*100) + '%. Use up to $' + maxPerTrade + ' per trade. ' +
    'Calculate qty based on price and budget. Respond ONLY in valid JSON: ' +
    '{"recommendation":"BUY|SELL|PASS","asset":null,"qty":null,"price":null,"target":null,"stopLoss":null,"edge":0,"confidence":"HIGH|MEDIUM|LOW","reasoning":"","marketAnalysis":"","assetType":"stock|crypto"}';
  const response = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 1000, system: sys, messages: [{ role: 'user', content: 'Prices: ' + JSON.stringify(prices) + ' Positions: ' + JSON.stringify(account.positions.map(p => ({symbol:p.symbol,qty:p.qty,pl:p.unrealized_plpc}))) }] });
  try { const m = response.content[0].text.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : { recommendation: 'PASS', edge: 0 }; } catch (e) { return { recommendation: 'PASS', edge: 0 }; }
}
async function executeTrade(alpaca, analysis, account) {
  const { recommendation, asset, qty, price, target, stopLoss, edge, reasoning, assetType } = analysis;
  if (!asset || !qty || edge < CONFIG.MIN_EDGE_PCT || account.positionCount >= CONFIG.MAX_POSITIONS) return null;
  const cost = (price || 0) * qty;
  if (cost > account.cash) { await log('WARN', 'Insufficient funds: $' + cost.toFixed(2)); return null; }
  try {
    const order = await alpaca.createOrder({ symbol: asset, qty: assetType === 'crypto' ? qty : Math.floor(qty), side: recommendation.toLowerCase(), type: 'market', time_in_force: assetType === 'crypto' ? 'gtc' : 'day' });
    await supabase.from('positions').insert({ symbol: asset, qty, entry_price: price, target_price: target, stop_loss: stopLoss, edge, reasoning, order_id: order.id, status: 'open', asset_type: assetType || 'stock', created_at: new Date().toISOString() }).catch(() => {});
    await log('INFO', 'ORDER: ' + recommendation + ' ' + qty + 'x ' + asset + ' $' + cost.toFixed(2));
    return order;
  } catch (e) { await log('ERROR', 'Order failed: ' + e.message); return null; }
}
async function runCycle(alpaca) {
  agentState.cycleCount++;
  agentState.lastCycle = new Date().toISOString();
  const markets = getActiveMarkets();
  agentState.marketMode = markets.mode;
  await log('INFO', 'Cycle #' + agentState.cycleCount + ' | ' + markets.mode);
  try {
    const account = await getAccountStatus(alpaca);
    await checkStopLoss(alpaca, account);
    const prices = await getMarketData(alpaca, markets);
    if (Object.keys(prices).length === 0) { agentState.status = 'WAITING'; agentState.lastAction = 'Esperando datos'; return; }
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
function startAgent(alpaca) {
  if (agentState.running) return { success: false, message: 'Already running' };
  agentState.running = true; agentState.status = 'RUNNING'; agentState.cycleCount = 0;
  log('INFO', 'KASS.AI v2 started - capital ilimitado, max ' + CONFIG.MAX_POSITIONS + ' posiciones');
  runCycle(alpaca);
  agentState.intervalId = setInterval(() => runCycle(alpaca), CONFIG.INTERVAL_MS);
  return { success: true, message: 'Agent started', interval: CONFIG.INTERVAL_MS };
}
function stopAgent() {
  if (!agentState.running) return { success: false, message: 'Not running' };
  clearInterval(agentState.intervalId); agentState.running = false; agentState.status = 'STOPPED'; agentState.intervalId = null;
  log('INFO', 'KASS.AI stopped');
  return { success: true, message: 'Agent stopped' };
}
function getAgentStatus() {
  return { ...agentState, intervalId: agentState.intervalId ? 'ACTIVE' : null, config: CONFIG, marketOpen: isStockMarketOpen() };
}
module.exports = { startAgent, stopAgent, getAgentStatus };