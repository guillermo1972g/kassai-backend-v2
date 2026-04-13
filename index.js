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
const { startAgent, stopAgent, getAgentStatus } = require('./services/agentLoop');
const { startNotifier, stopNotifier, sendWhatsApp, sendTradeAlert } = require('./services/notifier');

app.get('/', (req, res) => res.json({ status: 'OK', message: 'KASS.AI Backend v2', agent: getAgentStatus().status }));

app.get('/health', async (req, res) => {
  const { error } = await supabase.from('users').select('count').limit(1);
  res.json({ status: error ? 'ERROR' : 'OK', supabase: error ? error.message : 'Connected', anthropic: process.env.ANTHROPIC_API_KEY ? 'OK' : 'MISSING', alpaca: process.env.ALPACA_API_KEY ? 'OK' : 'MISSING', twilio: process.env.TWILIO_ACCOUNT_SID ? 'OK' : 'MISSING', agent: getAgentStatus().status });
});

app.post('/agent/start', (req, res) => res.json(startAgent(alpaca)));
app.post('/agent/stop', (req, res) => res.json(stopAgent()));
app.get('/agent/status', (req, res) => res.json(getAgentStatus()));

app.post('/notify/test', async (req, res) => {
  const ok = await sendWhatsApp('🤖 *KASS.AI conectado!*\n\nSistema de alertas funcionando correctamente.\nRecibirás informes a las 8am y 8pm hora Paraguay.\n\n_KASS.AI Trading System_');
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
    console.log('Notifier started - reports at 8am and 8pm PY time');
  }, 3000);
});