// GELT365.AI — Alpaca Client con soporte SIMULACION y REAL
const Alpaca = require('@alpacahq/alpaca-trade-api');

// Modos disponibles
const MODES = {
  paper: {
    keyId: process.env.ALPACA_API_KEY,
    secretKey: process.env.ALPACA_SECRET_KEY,
    baseUrl: 'https://paper-api.alpaca.markets',
    paper: true,
    label: 'SIMULACION'
  },
  live: {
    keyId: process.env.ALPACA_LIVE_API_KEY || process.env.ALPACA_API_KEY,
    secretKey: process.env.ALPACA_LIVE_SECRET_KEY || process.env.ALPACA_SECRET_KEY,
    baseUrl: process.env.ALPACA_LIVE_BASE_URL || 'https://api.alpaca.markets',
    paper: false,
    label: 'REAL'
  }
};

let currentMode = 'paper'; // Default: simulacion
let alpacaInstance = null;

function createClient(mode) {
  const config = MODES[mode];
  return new Alpaca({
    keyId: config.keyId,
    secretKey: config.secretKey,
    baseUrl: config.baseUrl,
    paper: config.paper
  });
}

// Initialize with paper mode
alpacaInstance = createClient('paper');

function switchMode(mode) {
  if (!MODES[mode]) throw new Error('Modo invalido: ' + mode + '. Use paper o live.');
  currentMode = mode;
  alpacaInstance = createClient(mode);
  console.log('[GELT365] Modo cambiado a: ' + MODES[mode].label);
  return { mode, label: MODES[mode].label, paper: MODES[mode].paper };
}

function getCurrentMode() {
  return { mode: currentMode, label: MODES[currentMode].label, paper: MODES[currentMode].paper };
}

function getClient() { return alpacaInstance; }

// Export both the client instance (for backward compat) and utilities
module.exports = alpacaInstance;
module.exports.switchMode = switchMode;
module.exports.getCurrentMode = getCurrentMode;
module.exports.getClient = getClient;
module.exports.MODES = MODES;
