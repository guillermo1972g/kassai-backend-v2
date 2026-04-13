// GELT365.AI — WhatsApp Notifier + Daily Reports
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const WA_FROM = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';
const WA_TO = process.env.TWILIO_WHATSAPP_TO || 'whatsapp:+595994996777';
const BRAND = 'GELT365.AI';
const BRAND_ICON = '🟠';

async function sendWhatsApp(message) {
  try {
    const url = 'https://api.twilio.com/2010-04-01/Accounts/' + TWILIO_SID + '/Messages.json';
    const auth = Buffer.from(TWILIO_SID + ':' + TWILIO_TOKEN).toString('base64');
    const body = new URLSearchParams({ To: WA_TO, From: WA_FROM, Body: message });
    const response = await fetch(url, { method: 'POST', headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    const result = await response.json();
    if (result.sid) { console.log('[' + BRAND + '] WhatsApp sent:', result.sid); return true; }
    else { console.error('[' + BRAND + '] Error:', JSON.stringify(result)); return false; }
  } catch (e) { console.error('[' + BRAND + '] Send error:', e.message); return false; }
}

async function getPortfolioData(alpaca) {
  try {
    const account = await alpaca.getAccount(); const positions = await alpaca.getPositions();
    const orders = await alpaca.getOrders({ status: 'all', limit: 20 });
    const equity = parseFloat(account.equity); const cash = parseFloat(account.cash);
    const pnl = equity - 100000; const pnlPct = ((pnl / 100000) * 100).toFixed(2);
    const cutoff = new Date(Date.now() - 12 * 60 * 60 * 1000);
    const recentOrders = orders.filter(o => new Date(o.created_at) > cutoff);
    return { equity, cash, pnl, pnlPct, positions, recentOrders };
  } catch (e) { return null; }
}

async function generateReport(data, reportType, philosophy) {
  const { equity, cash, pnl, pnlPct, positions, recentOrders } = data;
  const posStr = positions.length > 0 ? positions.map(p => p.symbol + ': P&L $' + parseFloat(p.unrealized_pl).toFixed(2)).join(', ') : 'Sin posiciones';
  const ordersStr = recentOrders.length > 0 ? recentOrders.map(o => o.side.toUpperCase() + ' ' + o.qty + 'x ' + o.symbol).join(', ') : 'Sin operaciones';
  const isAM = reportType === 'morning';
  const sys = 'Eres ' + BRAND + ', agente de trading autónomo con IA. Generás informes breves en español para WhatsApp. Max 300 palabras. Usa emojis. El logo/marca es GELT365.AI (no KASS.AI). Filosofia del agente: ' + JSON.stringify(philosophy || {});
  const prompt = isAM
    ? 'Informe matutino 8am para William Dreifus. Equity: $' + equity.toFixed(2) + ' Cash: $' + cash.toFixed(2) + ' P&L total: ' + (pnl>=0?'+':'') + '$' + pnl.toFixed(2) + ' (' + pnlPct + '%). Posiciones: ' + posStr + '. Ops recientes: ' + ordersStr + '. Incluye saludo, estado portfolio, outlook del dia.'
    : 'Informe vespertino 8pm para William Dreifus. Equity: $' + equity.toFixed(2) + ' Cash: $' + cash.toFixed(2) + ' P&L total: ' + (pnl>=0?'+':'') + '$' + pnl.toFixed(2) + ' (' + pnlPct + '%). Posiciones: ' + posStr + '. Ops del dia: ' + ordersStr + '. Incluye resumen, trades, resultado, outlook manana.';
  const response = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 500, system: sys, messages: [{ role: 'user', content: prompt }] });
  return response.content[0].text;
}

function shouldSendReport() {
  const py = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Asuncion' }));
  const h = py.getHours(); const m = py.getMinutes();
  if (m !== 0) return null;
  if (h === 8) return 'morning';
  if (h === 20) return 'evening';
  return null;
}

async function sendTradeAlert(trade) {
  const emoji = trade.side === 'buy' ? '🟢' : '🔴';
  const msg = BRAND_ICON + ' *' + BRAND + ' - Trade Ejecutado*\n\n' + emoji + ' ' + trade.side.toUpperCase() + ' ' + trade.qty + 'x *' + trade.symbol + '*\nPrecio: $' + parseFloat(trade.price||0).toFixed(2) + '\nTipo: ' + (trade.assetType==='crypto'?'₿ Crypto':'📈 Stock') + '\nHora PY: ' + new Date().toLocaleTimeString('es-PY',{timeZone:'America/Asuncion'}) + '\n\n_' + BRAND + ' Trading System_';
  return await sendWhatsApp(msg);
}

let lastReportHour = -1; let notifierInterval = null;

async function checkAndSendReport(alpaca, philosophy) {
  const reportType = shouldSendReport();
  if (!reportType) return;
  const pyHour = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Asuncion' })).getHours();
  if (pyHour === lastReportHour) return;
  lastReportHour = pyHour;
  console.log('[' + BRAND + '] Sending ' + reportType + ' report...');
  try {
    const data = await getPortfolioData(alpaca);
    if (!data) return;
    const report = await generateReport(data, reportType, philosophy);
    const header = reportType === 'morning'
      ? BRAND_ICON + ' *GELT365.AI — INFORME MATUTINO*\n_' + new Date().toLocaleDateString('es-PY', {timeZone:'America/Asuncion'}) + '_\n'
      : BRAND_ICON + ' *GELT365.AI — INFORME VESPERTINO*\n_' + new Date().toLocaleDateString('es-PY', {timeZone:'America/Asuncion'}) + '_\n';
    await sendWhatsApp(header + '\n' + report);
  } catch (e) { console.error('[' + BRAND + '] Report error:', e.message); }
}

function startNotifier(alpaca, philosophy) {
  if (notifierInterval) return;
  console.log('[' + BRAND + '] Notifier started - 8am y 8pm hora Paraguay');
  notifierInterval = setInterval(() => checkAndSendReport(alpaca, philosophy), 60 * 1000);
}
function stopNotifier() { if (notifierInterval) { clearInterval(notifierInterval); notifierInterval = null; } }
module.exports = { startNotifier, stopNotifier, sendWhatsApp, sendTradeAlert };