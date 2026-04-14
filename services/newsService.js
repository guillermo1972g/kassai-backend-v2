/**
 * KASS.AI - News Service
 * Real-time economic news via RSS + Claude AI projections
 */

const https = require('https');
const Anthropic = require('@anthropic-ai/sdk');
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// RSS feeds - all public, no key needed
const FEEDS = [
  { name: 'Reuters Markets', url: 'https://feeds.reuters.com/reuters/businessNews' },
  { name: 'Yahoo Finance',   url: 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=^GSPC,BTC-USD&region=US&lang=en-US' },
  { name: 'CNBC Markets',    url: 'https://search.cnbc.com/rs/search/combinedcombined/view/rss/section/15839069/edition/International/editiondetail/CNBC_TV18' },
];

// Cache: regenerate projections every 10 min
let _cache = { news: [], projections: '', ts: 0 };
const CACHE_MS = 10 * 60 * 1000;

function fetchRSS(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', () => resolve(''));
    req.setTimeout(5000, () => { req.destroy(); resolve(''); });
  });
}

function parseRSSItems(xml, sourceName) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title   = (block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ||
                     block.match(/<title>(.*?)<\/title>/))?.[1]?.trim();
    const pubDate = (block.match(/<pubDate>(.*?)<\/pubDate>/))?.[1]?.trim();
    const link    = (block.match(/<link>(.*?)<\/link>/)  ||
                     block.match(/<link\s[^>]*\/?>/))?.[1]?.trim();
    if (title && title.length > 10) {
      items.push({
        title,
        source: sourceName,
        pubDate: pubDate || new Date().toISOString(),
        link: link || '#',
        ts: pubDate ? new Date(pubDate).getTime() : Date.now()
      });
    }
    if (items.length >= 8) break;
  }
  return items;
}

async function fetchAllNews() {
  const results = await Promise.allSettled(
    FEEDS.map(f => fetchRSS(f.url).then(xml => parseRSSItems(xml, f.name)))
  );
  const allItems = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 20);
  return allItems;
}

async function generateProjections(newsItems) {
  if (!newsItems.length) return 'Sin noticias disponibles para análisis.';
  const headlines = newsItems.slice(0, 10).map(n => `- ${n.title} (${n.source})`).join('\n');
  const resp = await claude.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 400,
    system: `Eres KASS, analista de mercados financieros. Analiza los titulares y da:
1. SENTIMIENTO GLOBAL: Bullish/Bearish/Neutral con porcentaje de confianza
2. TOP 3 ACTIVOS IMPACTADOS: símbolo + dirección esperada + razón breve
3. PROYECCIÓN 24H: qué esperar en mercados globales

Responde en español, máximo 200 palabras, formato conciso.`,
    messages: [{ role: 'user', content: `Titulares actuales:\n${headlines}` }]
  });
  return resp.content[0]?.text || 'Sin proyección disponible.';
}

async function getNewsAndProjections() {
  const now = Date.now();
  if (now - _cache.ts < CACHE_MS && _cache.news.length > 0) {
    return _cache;
  }
  const news = await fetchAllNews();
  let projections = _cache.projections;
  try {
    projections = await generateProjections(news);
  } catch (e) {
    console.error('[News] Projection error:', e.message);
  }
  _cache = { news, projections, ts: now };
  return _cache;
}

module.exports = { getNewsAndProjections };
