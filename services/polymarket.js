/**
 * KASS.AI - Polymarket Service
 * Integración con Polymarket CLOB API (prediction markets)
 */

const https = require('https');

const POLYMARKET_BASE = 'https://clob.polymarket.com';
const GAMMA_BASE = 'https://gamma-api.polymarket.com';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${data.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

// ─── Market Data ─────────────────────────────────────────────────────────────

/**
 * Obtiene mercados activos con volumen y liquidez
 */
async function getActiveMarkets(limit = 20) {
  try {
    const data = await httpGet(
      `${GAMMA_BASE}/markets?active=true&closed=false&limit=${limit}&order=volume&ascending=false`
    );
    const markets = Array.isArray(data) ? data : (data.markets || []);
    return markets.map(m => ({
      id: m.id || m.conditionId,
      conditionId: m.conditionId,
      question: m.question,
      category: m.category || 'misc',
      volume: parseFloat(m.volume || 0),
      liquidity: parseFloat(m.liquidity || 0),
      outcomes: m.outcomes || [],
      outcomePrices: m.outcomePrices || [],
      endDate: m.endDate,
      active: m.active,
      clobTokenIds: m.clobTokenIds || []
    }));
  } catch (err) {
    console.error('[Polymarket] getActiveMarkets error:', err.message);
    return [];
  }
}

/**
 * Obtiene el orderbook de un token específico
 */
async function getOrderbook(tokenId) {
  try {
    const data = await httpGet(`${POLYMARKET_BASE}/book?token_id=${tokenId}`);
    return {
      tokenId,
      bids: (data.bids || []).slice(0, 5).map(b => ({
        price: parseFloat(b.price),
        size: parseFloat(b.size)
      })),
      asks: (data.asks || []).slice(0, 5).map(a => ({
        price: parseFloat(a.price),
        size: parseFloat(a.size)
      })),
      spread: data.asks?.[0] && data.bids?.[0]
        ? parseFloat(data.asks[0].price) - parseFloat(data.bids[0].price)
        : null
    };
  } catch (err) {
    console.error('[Polymarket] getOrderbook error:', err.message);
    return { tokenId, bids: [], asks: [], spread: null };
  }
}

/**
 * Obtiene datos enriquecidos de mercados para análisis de agente
 */
async function getMarketsForAgent(limit = 10) {
  const markets = await getActiveMarkets(limit * 2);

  // Filtra mercados con suficiente liquidez y volumen
  const filtered = markets
    .filter(m => m.liquidity > 1000 && m.volume > 5000)
    .slice(0, limit);

  // Enriquece con precios actuales
  const enriched = [];
  for (const m of filtered) {
    const tokenId = m.clobTokenIds?.[0];
    let orderbook = null;
    if (tokenId) {
      orderbook = await getOrderbook(tokenId);
      await sleep(200); // Rate limit
    }

    const prices = m.outcomePrices?.map(p => parseFloat(p)) || [];
    enriched.push({
      ...m,
      yesPrice: prices[0] || null,
      noPrice: prices[1] || null,
      impliedProbability: prices[0] || null,
      orderbook,
      source: 'polymarket'
    });
  }

  return enriched;
}

// ─── Paper Trading ────────────────────────────────────────────────────────────

/**
 * Simula una orden en Polymarket (paper trading)
 */
function paperTrade(market, outcome, shares, pricePerShare) {
  const cost = shares * pricePerShare;
  return {
    id: `PM-PAPER-${Date.now()}`,
    market: market.question,
    conditionId: market.conditionId,
    outcome,
    shares,
    pricePerShare,
    cost,
    timestamp: new Date().toISOString(),
    status: 'paper_filled',
    source: 'polymarket',
    mode: 'paper'
  };
}

// ─── Live Trading (stub - requiere API key + wallet) ─────────────────────────

/**
 * Ejecuta orden real en Polymarket
 * Requiere: POLY_API_KEY + POLY_PRIVATE_KEY en env
 */
async function liveTrade(market, outcome, shares, pricePerShare) {
  if (!process.env.POLY_API_KEY || !process.env.POLY_PRIVATE_KEY) {
    throw new Error('Polymarket live trading requiere POLY_API_KEY y POLY_PRIVATE_KEY');
  }
  // TODO: Implementar firma CLOB con ethers.js cuando se activen credenciales
  throw new Error('Polymarket live trading: pendiente configuración de wallet');
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = {
  getActiveMarkets,
  getOrderbook,
  getMarketsForAgent,
  paperTrade,
  liveTrade
};
