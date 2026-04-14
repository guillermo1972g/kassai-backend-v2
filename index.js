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