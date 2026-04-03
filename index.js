require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

app.get('/', (req, res) => {
  res.json({ status: 'OK', message: 'KASS.AI Backend running', version: '1.0.0' });
});

app.get('/health', async (req, res) => {
  const { error } = await supabase.from('users').select('count').limit(1);
  res.json({
    status: error ? 'ERROR' : 'OK',
    supabase: error ? error.message : 'Connected',
    anthropic: process.env.ANTHROPIC_API_KEY ? 'Key loaded' : 'Missing key'
  });
});

app.post('/agent/analyze', async (req, res) => {
  try {
    const { message, philosophy, markets } = req.body;
    const systemPrompt = `You are KASS.AI autonomous trading agent by William Dreifus.
Philosophy: Buffett ${philosophy?.b||40}% · Druckenmiller ${philosophy?.d||40}% · Munger ${philosophy?.m||10}% · Kassandra ${philosophy?.k||10}%
Active markets: ${JSON.stringify(markets)}
Rules: min 15% edge, max 3 positions, 20% global stop.
Always respond ONLY in valid JSON: {"marketAnalysis":"","opportunity":false,"recommendation":"PASS","asset":null,"market":"","edge":0,"confidence":0,"positionSizePct":0.1,"action":"","reasoning":"","inversion":"","kassandraScore":0,"lesson":""}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: message || 'Analyze current market conditions.' }]
    });

    const text = response.content[0].text;
    let analysis;
    try {
      const match = text.match(/\{[\s\S]*\}/);
      analysis = match ? JSON.parse(match[0]) : { recommendation: 'PASS', marketAnalysis: text };
    } catch(e) {
      analysis = { recommendation: 'PASS', marketAnalysis: text };
    }

    res.json({ success: true, analysis });
  } catch(error) {
    console.error('Agent error:', error.message);
    res.status(200).json({
      success: false,
      analysis: {
        recommendation: 'PASS',
        marketAnalysis: 'Agent temporarily unavailable. Try again.',
        reasoning: error.message,
        edge: 0,
        confidence: 0,
        kassandraScore: 0
      }
    });
  }
});
const alpaca = require('./services/alpacaClient');

app.get('/api/alpaca/account', async (req, res) => {
  try {
    const account = await alpaca.getAccount();
    res.json(account);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// Precio en tiempo real
app.get('/api/alpaca/quote/:symbol', async (req, res) => {
    try {
      const { symbol } = req.params;
      const quote = await alpaca.getLatestTrade(symbol);
      res.json(quote);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
  
  // Ejecutar orden simulada
  app.post('/api/alpaca/order', async (req, res) => {
    try {
      const { symbol, qty, side, type, time_in_force } = req.body;
      const order = await alpaca.createOrder({
        symbol,
        qty,
        side,
        type: type || 'market',
        time_in_force: time_in_force || 'day'
      });
      res.json(order);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
  
  // Ver posiciones abiertas
  app.get('/api/alpaca/positions', async (req, res) => {
    try {
      const positions = await alpaca.getPositions();
      res.json(positions);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
  
  // Historial de órdenes
  app.get('/api/alpaca/history', async (req, res) => {
    try {
      const orders = await alpaca.getOrders({ status: 'all', limit: 50 });
      res.json(orders);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`KASS.AI Backend running on port ${PORT}`);
  console.log(`Supabase: ${process.env.SUPABASE_URL}`);
  console.log(`Anthropic: ${process.env.ANTHROPIC_API_KEY ? 'OK' : 'MISSING'}`);
});