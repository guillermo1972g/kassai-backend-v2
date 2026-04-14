/**
 * KASS.AI - Kraken Service
 * Integración con Kraken REST API (crypto)
 * Docs: https://docs.kraken.com/rest/
 */

const https = require('https');
const crypto = require('crypto');

const KRAKEN_BASE = 'api.kraken.com';

// ─── Pares de trading KASS ────────────────────────────────────────────────────

const DEFAULT_PAIRS = ['XBTUSD', 'ETHUSD', 'SOLUSD', 'ADAUSD', 'DOTUSD'];

const PAIR_MAP = {
  'BTC': 'XBTUSD',
  'ETH': 'ETHUSD',
  'SOL': 'SOLUSD',
  'ADA': 'ADAUSD',
  'DOT': 'DOTUSD'
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function httpGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: KRAKEN_BASE,
      path,
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error?.length) reject(new Error(parsed.error.join(', ')));
          else resolve(parsed.result);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function privateRequest(urlPath, data, apiKey, apiSecret) {
  return new Promise((resolve, reject) => {
    const nonce = Date.now().toString();
    const postData = `nonce=${nonce}&${new URLSearchParams({ ...data, nonce }).toString()}`;

    const signature = getKrakenSignature(urlPath, nonce, postData, apiSecret);

    const options = {
      hostname: KRAKEN_BASE,
      path: urlPath,
      method: 'POST',
      headers: {
        'API-Key': apiKey,
        'API-Sign': signature,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.error?.length) reject(new Error(parsed.error.join(', ')));
          else resolve(parsed.result);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function getKrakenSignature(urlPath, nonce, postData, secret) {
  const message = nonce + postData;
  const secretBuffer = Buffer.from(secret, 'base64');
  const hash = crypto.createHash('sha256').update(nonce + postData).digest();
  const hmac = crypto.createHmac('sha512', secretBuffer)
    .update(urlPath + hash.toString('binary'), 'binary')
    .digest('base64');
  return hmac;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Public Data ─────────────────────────────────────────────────────────────

/**
 * Ticker de múltiples pares
 */
async function getTickers(pairs = DEFAULT_PAIRS) {
  const pairStr = pairs.join(',');
  const result = await httpGet(`/0/public/Ticker?pair=${pairStr}`);
  return Object.entries(result).map(([pair, t]) => ({
    pair: pair.replace('XXBT', 'XBT').replace('XETH', 'ETH').replace('ZUSD','USD'),
    ask: parseFloat(t.a[0]),
    bid: parseFloat(t.b[0]),
    last: parseFloat(t.c[0]),
    volume24h: parseFloat(t.v[1]),
    vwap24h: parseFloat(t.p[1]),
    high24h: parseFloat(t.h[1]),
    low24h: parseFloat(t.l[1]),
    spread: parseFloat(t.a[0]) - parseFloat(t.b[0]),
    source: 'kraken'
  }));
}

/**
 * OHLCV bars para análisis técnico
 */
async function getOHLCV(pair, interval = 60, count = 24) {
  const result = await httpGet(`/0/public/OHLC?pair=${pair}&interval=${interval}`);
  const key = Object.keys(result).find(k => k !== 'last');
  const bars = result[key] || [];
  return bars.slice(-count).map(b => ({
    timestamp: new Date(b[0] * 1000).toISOString(),
    open: parseFloat(b[1]),
    high: parseFloat(b[2]),
    low: parseFloat(b[3]),
    close: parseFloat(b[4]),
    volume: parseFloat(b[6])
  }));
}

/**
 * Datos enriquecidos para el agente
 */
async function getCryptoForAgent() {
  try {
    const tickers = await getTickers(DEFAULT_PAIRS);
    const enriched = [];

    for (const ticker of tickers) {
      const bars = await getOHLCV(ticker.pair, 60, 24);
      const closes = bars.map(b => b.close).filter(Boolean);
      const rsi = closes.length >= 14 ? calcRSI(closes) : null;
      const sma20 = closes.length >= 20 ? avg(closes.slice(-20)) : null;
      const volatility24h = closes.length > 1
        ? ((ticker.high24h - ticker.low24h) / ticker.low24h * 100).toFixed(2)
        : null;

      enriched.push({
        ...ticker,
        rsi,
        sma20,
        volatility24h: parseFloat(volatility24h),
        trend: sma20 ? (ticker.last > sma20 ? 'bullish' : 'bearish') : null,
        source: 'kraken_crypto'
      });

      await sleep(300); // Kraken rate limit
    }

    return enriched;
  } catch (err) {
    console.error('[Kraken] getCryptoForAgent error:', err.message);
    return [];
  }
}

// ─── Private (Trading) ───────────────────────────────────────────────────────

function getCredentials() {
  return {
    apiKey: process.env.KRAKEN_API_KEY || '',
    apiSecret: process.env.KRAKEN_API_SECRET || '',
    isPaper: !process.env.KRAKEN_API_KEY
  };
}

/**
 * Balance de cuenta
 */
async function getBalance() {
  const { apiKey, apiSecret } = getCredentials();
  if (!apiKey) throw new Error('KRAKEN_API_KEY no configurada');
  const result = await privateRequest('/0/private/Balance', {}, apiKey, apiSecret);
  return Object.entries(result)
    .filter(([, v]) => parseFloat(v) > 0)
    .map(([currency, balance]) => ({
      currency,
      balance: parseFloat(balance)
    }));
}

/**
 * Coloca orden de mercado
 */
async function placeOrder({ pair, type, ordertype = 'market', volume }) {
  const { apiKey, apiSecret, isPaper } = getCredentials();
  if (!apiKey) throw new Error('KRAKEN_API_KEY no configurada para live trading');

  const result = await privateRequest(
    '/0/private/AddOrder',
    { pair, type, ordertype, volume: volume.toString() },
    apiKey,
    apiSecret
  );

  return {
    txids: result.txid,
    pair,
    type,
    volume,
    status: 'submitted',
    mode: 'live',
    source: 'kraken',
    timestamp: new Date().toISOString()
  };
}

/**
 * Paper trade simulado
 */
function paperTrade({ pair, type, volume, currentPrice }) {
  const cost = volume * currentPrice;
  return {
    id: `KR-PAPER-${Date.now()}`,
    pair,
    type,
    volume,
    price: currentPrice,
    cost,
    status: 'paper_filled',
    mode: 'paper',
    source: 'kraken',
    timestamp: new Date().toISOString()
  };
}

/**
 * Posiciones abiertas
 */
async function getOpenPositions() {
  const { apiKey, apiSecret } = getCredentials();
  if (!apiKey) return [];
  const result = await privateRequest('/0/private/OpenPositions', {}, apiKey, apiSecret);
  return Object.entries(result).map(([txid, p]) => ({
    txid,
    pair: p.pair,
    type: p.type,
    volume: parseFloat(p.vol),
    cost: parseFloat(p.cost),
    fee: parseFloat(p.fee),
    pl: parseFloat(p.net || 0),
    source: 'kraken'
  }));
}

// ─── Technical Indicators ────────────────────────────────────────────────────

function avg(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[closes.length - i] - closes[closes.length - i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const rs = gains / (losses || 0.0001);
  return parseFloat((100 - (100 / (1 + rs))).toFixed(2));
}

module.exports = {
  getTickers,
  getOHLCV,
  getCryptoForAgent,
  getBalance,
  placeOrder,
  paperTrade,
  getOpenPositions,
  PAIR_MAP,
  DEFAULT_PAIRS
};
