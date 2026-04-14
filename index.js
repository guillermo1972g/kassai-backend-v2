require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const alpaca = require('./services/alpacaClient');
const { startAgent, stopAgent, getAgentStatus, setCapital, setTakeProfit } = require('./services/agentLoop');
const { startNotifier, stopNotifier, sendWhatsApp, sendTradeAlert } = require('./services/notifier');

app.get('/', (req, res) => res.json({ status: 'OK', message: 'KASS.AI Backend v2', agent: getAgentStatus().status }));

app.get('/health', async (req, res) => {
  const { error } = await supabase.from('users').select('count').limit(1);
  res.json({ status: error ? 'ERROR' : 'OK', supabase: error ? error.message : 'Connected', anthropic: process.env.ANTHROPIC_API_KEY ? 'OK' : 'MISSING', alpaca: process.env.ALPACA_API_KEY ? 'OK' : 'MISSING', twilio: process.env.TWILIO_ACCOUNT_SID ? 'OK' : 'MISSING', agent: getAgentStatus().status });
});

// Agent control
app.post('/agent/start', (req, res) => res.json(startAgent(alpaca)));
app.post('/agent/stop', (req, res) => res.json(stopAgent()));
app.get('/agent/status', (req, res) => res.json(getAgentStatus()));

// Capital management
app.post('/capital/set', async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  setCapital(amount);
  const msg = 'ð° *Capital actualizado*\n\nEl agente operarÃ¡ con: *$' + parseFloat(amount).toLocaleString() + '*\nStop loss global: 20%\n\n_KASS.AI Trading System_';
  await sendWhatsApp(msg);
  res.json({ success: true, capital: amount, message: 'Capital set to $' + amount });
});

app.post('/capital/withdraw', async (req, res) => {
  try {
    const positions = await alpaca.getPositions();
    let liquidated = 0;
    for (const pos of positions) {
      try { await alpaca.closePosition(pos.symbol); liquidated++; } catch(e) {}
    }
    const account = await alpaca.getAccount();
    const cash = parseFloat(account.cash);
    const msg = 'ð¸ *Retiro ejecutado*\n\n' + liquidated + ' posiciones liquidadas\nCash disponible: *$' + cash.toFixed(2) + '*\n\nFondos disponibles en tu cuenta Alpaca.\n\n_KASS.AI Trading System_';
    await sendWhatsApp(msg);
    res.json({ success: true, liquidated, cash, message: 'All positions closed' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/capital/takeprofit', async (req, res) => {
  const { target } = req.body;
  if (!target || target <= 0) return res.status(400).json({ error: 'Invalid target' });
  setTakeProfit(target);
  const msg = 'ð¯ *Take Profit configurado*\n\nEl agente liquidarÃ¡ automÃ¡ticamente cuando el portfolio llegue a: *$' + parseFloat(target).toLocaleString() + '*\n\n_KASS.AI Trading System_';
  await sendWhatsApp(msg);
  res.json({ success: true, target, message: 'Take profit set at $' + target });
});

// WhatsApp test
app.post('/notify/test', async (req, res) => {
  const ok = await sendWhatsApp('ð¤ *KASS.AI conectado!*\n\nSistema de alertas funcionando correctamente.\nRecibirÃ¡s informes a las 8am y 8pm hora Paraguay.\n\n_KASS.AI Trading System_');
  res.json({ success: ok });
});

app.post('/agent/analyze', async (req, res) => {
  try {
    const { message, philosophy, markets } = req.body;
    const philosophers = philosophy && Object.keys(philosophy).length > 0 ? Object.entries(philosophy).map(([n, p]) => n + ' ' + p + '%').join(' - ') : 'Sin filosofia';
    const systemPrompt = 'You are KASS.AI, autonomous trading agent. Philosophy: ' + philosophers + '. Rules: min 15% edge, max 3 positions, 20% stop. Respond ONLY in valid JSON: {"marketAnalysis":"","recommendation":"PASS","asset":null,"qty":null,"price":null,"target":null,"stopLoss":null,"confidence":"LOW","reasoning":""}';
    const response = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 1000, system: systemPrompt, messages: [{ role: 'user', content: message || 'Analyze current market conditions.' }] });
    const text = response.content[0].text;
    let analysis;
    try { const m = text.match(/\{[\s\S]*\}/); analysis = m ? JSON.parse(m[0]) : { recommendation: 'PASS', marketAnalysis: text }; } catch(e) { analysis = { recommendation: 'PASS', marketAnalysis: text }; }
    if (analysis.asset) { try { const q = await alpaca.getLatestTrade(analysis.asset); analysis.price = q.Price; } catch(e) {} }
    res.json({ success: true, analysis });
  } catch(error) { res.status(200).json({ success: false, analysis: { recommendation: 'PASS', marketAnalysis: 'Agent unavailable.', reasoning: error.message, edge: 0 } }); }
});

app.get('/api/alpaca/account', async (req, res) => { try { res.json(await alpaca.getAccount()); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/alpaca/quote/:symbol', async (req, res) => { try { res.json(await alpaca.getLatestTrade(req.params.symbol)); } catch(e) { res.status(500).json({ error: e.message }); } });
app.post('/api/alpaca/order', async (req, res) => { try { const { symbol, qty, side, type, time_in_force } = req.body; res.json(await alpaca.createOrder({ symbol, qty, side, type: type||'market', time_in_force: time_in_force||'day' })); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/alpaca/positions', async (req, res) => { try { res.json(await alpaca.getPositions()); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/alpaca/history', async (req, res) => { try { res.json(await alpaca.getOrders({ status: 'all', limit: 50 })); } catch(e) { res.status(500).json({ error: e.message }); } });

app.get('/api/agent/daily-ideas', async (req, res) => {
  try {
    const tickers = ['AAPL','TSLA','NVDA','MSFT','AMZN','GOOGL','META','SPY','AMD','NFLX'];
    const prices = {};
    for (const t of tickers) { try { const q = await alpaca.getLatestTrade(t); prices[t] = q.Price; } catch(e) {} }
    const response = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 2000, system: 'You are KASS.AI. Generate exactly 5 trade ideas. Respond ONLY in valid JSON array: [{"asset":"TICKER","recommendation":"BUY/SELL","confidence":"HIGH/MEDIUM/LOW","marketAnalysis":"","reasoning":"","price":0,"target":0,"stopLoss":0}]', messages: [{ role: 'user', content: 'Prices: ' + JSON.stringify(prices) + '. Generate 5 ideas.' }] });
    const text = response.content[0].text;
    let ideas = [];
    try { const m = text.match(/\[[\s\S]*\]/); ideas = m ? JSON.parse(m[0]) : []; } catch(e) {}
    for (const idea of ideas) { if (idea.asset && prices[idea.asset]) idea.price = prices[idea.asset]; }
    res.json({ success: true, ideas });
  } catch(error) { res.status(500).json({ error: error.message }); }
});




// MODE SWITCHING - Paper (simulation) vs Live (real)
let liveAlpaca = null;
app.post('/mode/set-live', async (req, res) => {
  try {
    const { apiKey, secretKey } = req.body;
    if (!apiKey || !secretKey) return res.status(400).json({ success: false, error: 'API keys required' });
    const Alpaca = require('@alpacahq/alpaca-trade-api');
    const testClient = new Alpaca({ keyId: apiKey, secretKey: secretKey, baseUrl: 'https://api.alpaca.markets', paper: false });
    const account = await testClient.getAccount();
    liveAlpaca = testClient;
    res.json({ success: true, mode: 'live', equity: account.equity, message: 'Live mode activated' });
  } catch(e) { res.status(400).json({ success: false, error: 'Invalid keys or connection failed: ' + e.message }); }
});

app.post('/mode/set-paper', (req, res) => {
  liveAlpaca = null;
  res.json({ success: true, mode: 'paper', message: 'Paper mode activated' });
});

app.get('/mode/status', async (req, res) => {
  const mode = liveAlpaca ? 'live' : 'paper';
  try {
    const client = liveAlpaca || alpaca;
    const account = await client.getAccount();
    res.json({ mode, equity: account.equity, cash: account.cash, label: mode === 'live' ? 'OPERACIONES REALES' : 'SIMULACION' });
  } catch(e) { res.json({ mode, error: e.message }); }
});

// POLYMARKET - Connect wallet and get balance
app.post('/polymarket/connect', async (req, res) => {
  try {
    const { wallet, apiKey } = req.body;
    if (!wallet) return res.status(400).json({ success: false, error: 'Wallet address required' });
    // Check USDC balance on Polygon via public API
    const r = await fetch('https://api.polygonscan.com/api?module=account&action=tokenbalance&contractaddress=0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174&address=' + wallet + '&tag=latest&apikey=YourApiKeyToken');
    const d = await r.json();
    const balance = d.result ? (parseInt(d.result) / 1e6).toFixed(2) : '0';
    res.json({ success: true, wallet, balance, message: 'Polymarket wallet connected' });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Auth - reset user password
app.post('/auth/reset-password', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const { createClient } = require('@supabase/supabase-js');
    const adminClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    // Find user by email
    const { data: users } = await adminClient.auth.admin.listUsers();
    const user = users?.users?.find(u => u.email === email);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    // Update password
    const { error } = await adminClient.auth.admin.updateUserById(user.id, { password, email_confirm: true });
    if (error) return res.status(400).json({ success: false, error: error.message });
    res.json({ success: true, message: 'Password updated' });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Auth - create user without email confirmation
app.post('/auth/create-user', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const { createClient } = require('@supabase/supabase-js');
    const adminClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data, error } = await adminClient.auth.admin.createUser({
      email, password,
      email_confirm: true,
      user_metadata: { created_via: 'gelt365_backend' }
    });
    if (error) return res.status(400).json({ success: false, error: error.message });
    res.json({ success: true, user: data.user?.id });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── NUEVOS ENDPOINTS v2.1 ────────────────────────────────────────────────────

// Datos de mercado combinados: Polymarket + Alpaca + Kraken
const polymarket = require('./services/polymarket');
const kraken = require('./services/kraken');
const newsService = require('./services/newsService');

app.get('/agent/markets', async (req, res) => {
  try {
    const [polyData, cryptoData, stockQuotes] = await Promise.allSettled([
      polymarket.getActiveMarkets(5),
      kraken.getTickers(),
      alpaca.getPositions().then(() => alpaca.getAccount())
    ]);
    res.json({
      success: true,
      polymarket: polyData.status === 'fulfilled' ? polyData.value : { error: polyData.reason?.message },
      crypto: cryptoData.status === 'fulfilled' ? cryptoData.value : { error: cryptoData.reason?.message },
      stocks: stockQuotes.status === 'fulfilled' ? stockQuotes.value : { error: stockQuotes.reason?.message },
      timestamp: new Date().toISOString()
    });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Log de actividad del agente desde Supabase
app.get('/agent/log', async (req, res) => {
  try {
    const { data, error } = await supabase.from('logs').select('*').order('created_at', { ascending: false }).limit(50);
    if (error) throw error;
    res.json({ success: true, logs: data });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Sugerencias IA desde Supabase
app.get('/agent/suggestions', async (req, res) => {
  try {
    const { data, error } = await supabase.from('suggestions').select('*').order('created_at', { ascending: false }).limit(10);
    if (error) throw error;
    res.json({ success: true, suggestions: data || [] });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Posiciones combinadas (agente + Alpaca)
app.get('/agent/positions', async (req, res) => {
  try {
    const [alpacaPos, dbPos] = await Promise.allSettled([
      alpaca.getPositions(),
      supabase.from('positions').select('*').eq('status', 'open').limit(20)
    ]);
    res.json({
      success: true,
      alpaca: alpacaPos.status === 'fulfilled' ? alpacaPos.value : [],
      agent: dbPos.status === 'fulfilled' ? (dbPos.value.data || []) : [],
      mode: liveAlpaca ? 'live' : 'paper',
      timestamp: new Date().toISOString()
    });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});



// ─── COPILOTO IA — Pre-trade analysis ────────────────────────────────────────
app.post('/agent/copilot', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const { asset, action, context } = req.body;
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 800,
      system: `Eres KASSANDRA, copiloto de trading institucional. Analiza la operación propuesta y responde en JSON:
{
  "verdict": "FAVORABLE|NEUTRAL|DESFAVORABLE",
  "confidence": 0-100,
  "macro_context": "análisis macro en 2 oraciones",
  "setup_quality": 0-100,
  "risk_reward": "X:Y",
  "key_risks": ["riesgo1", "riesgo2", "riesgo3"],
  "regime": "BULLISH|BEARISH|RANGING|VOLATILE",
  "suggested_size": "% del capital sugerido",
  "explanation": "explicación en 3 oraciones claras"
}`,
      messages: [{ role: 'user', content: `Asset: ${asset || 'N/A'} | Acción: ${action || 'N/A'} | Contexto: ${context || 'Análisis general'}` }]
    });
    const text = response.content[0].text;
    const clean = text.replace(/\`\`\`json|\`\`\`/g, '').trim();
    try { res.json({ success: true, analysis: JSON.parse(clean) }); }
    catch(e) { res.json({ success: true, analysis: { verdict: 'NEUTRAL', explanation: text, confidence: 50 } }); }
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── EXPLAINABLE AI — Por qué hizo cada trade ─────────────────────────────
app.post('/agent/explain', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const { tradeId, action, asset, price, result } = req.body;
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      system: 'Eres KASSANDRA. Explica decisiones de trading en lenguaje claro y honesto. Responde en JSON: { "why_entered": "", "why_exited": "", "probability_estimated": 0-100, "what_changed": "", "risk_detected": "", "lesson": "" }',
      messages: [{ role: 'user', content: `Trade: ${action} ${asset} @ $${price} | Resultado: ${result || 'abierto'} | ID: ${tradeId}` }]
    });
    const text = response.content[0].text;
    const clean = text.replace(/\`\`\`json|\`\`\`/g, '').trim();
    try { res.json({ success: true, explanation: JSON.parse(clean) }); }
    catch(e) { res.json({ success: true, explanation: { why_entered: text } }); }
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── RISK METRICS — Sharpe, Sortino, Calmar, VaR ─────────────────────────
app.get('/agent/risk-metrics', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const { data: trades } = await supabase.from('positions').select('*').order('created_at', { ascending: false }).limit(200);
    const closed = (trades || []).filter(t => t.status === 'closed' || t.exit_price);
    const returns = closed.map(t => {
      if (t.exit_price && t.entry_price && t.qty) {
        return (parseFloat(t.exit_price) - parseFloat(t.entry_price)) * parseFloat(t.qty);
      }
      return parseFloat(t.pnl || 0);
    }).filter(r => !isNaN(r));
    const n = returns.length;
    const mean = n > 0 ? returns.reduce((a,b) => a+b, 0) / n : 0;
    const variance = n > 1 ? returns.reduce((s,r) => s + Math.pow(r-mean,2), 0) / (n-1) : 0;
    const stddev = Math.sqrt(variance);
    const negReturns = returns.filter(r => r < 0);
    const downside = negReturns.length > 0 ? Math.sqrt(negReturns.reduce((s,r) => s + r*r, 0) / negReturns.length) : 0;
    const sharpe = stddev > 0 ? (mean / stddev * Math.sqrt(252)).toFixed(2) : '0.00';
    const sortino = downside > 0 ? (mean / downside * Math.sqrt(252)).toFixed(2) : '0.00';
    const maxDrawdown = returns.length > 0 ? Math.abs(Math.min(...returns)).toFixed(2) : '0.00';
    const calmar = maxDrawdown > 0 ? (mean * 252 / parseFloat(maxDrawdown)).toFixed(2) : '0.00';
    const totalPnl = returns.reduce((a,b) => a+b, 0);
    const winRate = n > 0 ? (returns.filter(r => r > 0).length / n * 100).toFixed(1) : '0.0';
    const account = await alpaca.getAccount().catch(() => ({ equity: 500, cash: 500 }));
    res.json({
      success: true,
      sharpe, sortino, calmar,
      maxDrawdown: '-$' + maxDrawdown,
      winRate: winRate + '%',
      totalTrades: n,
      totalPnl: '$' + totalPnl.toFixed(2),
      equity: parseFloat(account.equity || 500).toFixed(2),
      var95: '$' + (parseFloat(maxDrawdown) * 0.8).toFixed(2),
      avgWin: returns.filter(r=>r>0).length > 0 ? '$' + (returns.filter(r=>r>0).reduce((a,b)=>a+b,0)/returns.filter(r=>r>0).length).toFixed(2) : '--',
      avgLoss: negReturns.length > 0 ? '$' + (negReturns.reduce((a,b)=>a+b,0)/negReturns.length).toFixed(2) : '--',
    });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── DIARIO INTELIGENTE — Behavioural journal ─────────────────────────────
app.get('/agent/diary', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const { data: logs } = await supabase.from('logs').select('*').order('created_at', { ascending: false }).limit(100);
    const { data: positions } = await supabase.from('positions').select('*').order('created_at', { ascending: false }).limit(50);
    const allData = JSON.stringify({ logs: (logs||[]).slice(0,20), positions: (positions||[]).slice(0,10) });
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 700,
      system: `Eres el analista conductual de KASSANDRA. Analiza el historial del trader y responde en JSON:
{
  "overall_score": 0-100,
  "discipline_score": 0-100,
  "biases_detected": ["sesgo1", "sesgo2"],
  "strengths": ["fortaleza1", "fortaleza2"],
  "improvement_areas": ["area1", "area2"],
  "weekly_insight": "insight principal en 2 oraciones",
  "recommendation": "recomendación concreta para esta semana"
}`,
      messages: [{ role: 'user', content: `Historial del trader:
${allData.slice(0, 2000)}` }]
    });
    const text = response.content[0].text;
    const clean = text.replace(/\`\`\`json|\`\`\`/g, '').trim();
    try { res.json({ success: true, diary: JSON.parse(clean) }); }
    catch(e) { res.json({ success: true, diary: { overall_score: 70, weekly_insight: text } }); }
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── HEDGE FUND MODE — Multi-strategy metrics ─────────────────────────────
app.get('/agent/hedge-fund', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const [riskRes, perfRes] = await Promise.allSettled([
      fetch('http://localhost:' + (process.env.PORT || 3000) + '/agent/risk-metrics').then(r => r.json()),
      fetch('http://localhost:' + (process.env.PORT || 3000) + '/agent/performance').then(r => r.json())
    ]);
    const risk = riskRes.status === 'fulfilled' ? riskRes.value : {};
    const perf = perfRes.status === 'fulfilled' ? perfRes.value : {};
    const account = await alpaca.getAccount().catch(() => ({ equity: 500, buying_power: 500 }));
    res.json({
      success: true,
      portfolio: {
        equity: parseFloat(account.equity || 500).toFixed(2),
        buyingPower: parseFloat(account.buying_power || 500).toFixed(2),
        sharpe: risk.sharpe || '--',
        sortino: risk.sortino || '--',
        calmar: risk.calmar || '--',
        maxDrawdown: risk.maxDrawdown || '--',
        winRate: risk.winRate || '--',
        totalTrades: perf.totalTrades || 0,
      },
      strategies: [
        { name: 'KASS-CRYPTO-MOM', status: 'ACTIVE', allocation: '40%', trades: Math.floor((perf.totalTrades||0)*0.4) },
        { name: 'KASS-STOCK-TREND', status: 'ACTIVE', allocation: '35%', trades: Math.floor((perf.totalTrades||0)*0.35) },
        { name: 'KASS-POLY-ARBIT', status: 'ACTIVE', allocation: '25%', trades: Math.floor((perf.totalTrades||0)*0.25) },
      ]
    });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── NEWS & PROJECTIONS ───────────────────────────────────────────────────────
app.get('/news', async (req, res) => {
  try {
    const data = await newsService.getNewsAndProjections();
    res.json({ success: true, ...data, cachedAt: new Date(data.ts).toISOString() });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── PERFORMANCE & TRADE HISTORY ─────────────────────────────────────────────
app.get('/agent/performance', async (req, res) => {
  try {
    const { data: positions, error } = await supabase
      .from('positions').select('*').order('created_at', { ascending: false }).limit(100);
    if (error) throw error;
    const closed = (positions || []).filter(p => p.status === 'closed' || p.exit_price);
    const open   = (positions || []).filter(p => p.status === 'open' && !p.exit_price);
    const wins   = closed.filter(p => {
      const pl = p.exit_price && p.entry_price ? (p.exit_price - p.entry_price) * (p.qty || 1) : (p.pnl || 0);
      return pl > 0;
    });
    const totalPnl = closed.reduce((sum, p) => {
      const pl = p.exit_price && p.entry_price ? (p.exit_price - p.entry_price) * (p.qty || 1) : (p.pnl || 0);
      return sum + pl;
    }, 0);
    // Get agent status for cycle count
    const agentStatus = getAgentStatus();
    res.json({
      success: true,
      totalTrades: (positions || []).length,
      openTrades: open.length,
      closedTrades: closed.length,
      wins: wins.length,
      losses: closed.length - wins.length,
      winRate: closed.length > 0 ? ((wins.length / closed.length) * 100).toFixed(1) : null,
      totalPnl: totalPnl.toFixed(2),
      cycles: agentStatus.cycleCount,
      lastAction: agentStatus.lastAction,
      marketMode: agentStatus.marketMode,
      recentTrades: (positions || []).slice(0, 20)
    });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/agent/history', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('positions').select('*').order('created_at', { ascending: false }).limit(50);
    if (error) throw error;
    res.json({ success: true, trades: data || [] });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── PUBLIC MARKET DATA (no API key needed) ───────────────────────────────────
app.get('/markets/public', async (req, res) => {
  try {
    const [cryptoRes, polyRes] = await Promise.allSettled([
      kraken.getTickers(['XBTUSD', 'ETHUSD', 'SOLUSD', 'ADAUSD']),
      polymarket.getActiveMarkets(6)
    ]);
    res.json({
      success: true,
      crypto: cryptoRes.status === 'fulfilled' ? cryptoRes.value : [],
      polymarket: polyRes.status === 'fulfilled' ? polyRes.value : [],
      timestamp: new Date().toISOString()
    });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('KASS.AI Backend v2 on port ' + PORT);
  console.log('Anthropic: ' + (process.env.ANTHROPIC_API_KEY ? 'OK' : 'MISSING'));
  console.log('Alpaca: ' + (process.env.ALPACA_API_KEY ? 'OK' : 'MISSING'));
  console.log('Twilio: ' + (process.env.TWILIO_ACCOUNT_SID ? 'OK' : 'MISSING'));
  setTimeout(() => {
    const result = startAgent(alpaca);
    console.log('Agent auto-start:', result.message);
    startNotifier(alpaca, {});
    console.log('Notifier started');
  }, 3000);
});