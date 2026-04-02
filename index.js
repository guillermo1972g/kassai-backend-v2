require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json());

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// TEST ROUTE
app.get('/', (req, res) => {
  res.json({ 
    status: 'OK',
    message: 'KASS.AI Backend running',
    version: '1.0.0'
  });
});

// TEST SUPABASE
app.get('/health', async (req, res) => {
  const { data, error } = await supabase
    .from('users')
    .select('count')
    .limit(1);
  
  res.json({
    status: error ? 'ERROR' : 'OK',
    supabase: error ? error.message : 'Connected',
    anthropic: process.env.ANTHROPIC_API_KEY ? 'Key loaded' : 'Missing key'
  });
});

// AGENT ANALYZE ROUTE
app.post('/agent/analyze', async (req, res) => {
  const { message, philosophy, markets } = req.body;
  
  const systemPrompt = `You are KASS.AI autonomous trading agent by William Dreifus.
Philosophy: Buffett ${philosophy?.b||40}% · Druckenmiller ${philosophy?.d||40}% · Munger ${philosophy?.m||10}% · Kassandra ${philosophy?.k||10}%
Active markets: ${JSON.stringify(markets)}
Rules: min 15% edge, max 3 positions, 20% global stop.
Respond ONLY in JSON: {"marketAnalysis":"","opportunity":false,"recommendation":"PASS","asset":null,"market":"","edge":0,"confidence":0,"positionSizePct":0.1,"action":"","reasoning":"","inversion":"","kassandraScore":0,"lesson":""}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    system: systemPrompt,
    messages: [{ role: 'user', content: message }]
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
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`KASS.AI Backend running on port ${PORT}`);
  console.log(`Supabase: ${process.env.SUPABASE_URL}`);
  console.log(`Anthropic: ${process.env.ANTHROPIC_API_KEY ? 'OK' : 'MISSING'}`);
});