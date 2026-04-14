// GELT365.AI Agent Loop v3 - COBERTURA GLOBAL 24/7
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const CONFIG = {
  INTERVAL_MS: 90*1000, MAX_POSITIONS: 3, STOP_LOSS_PCT: 0.20, MIN_EDGE_PCT: 0.15,
  US_STOCKS: ['AAPL','TSLA','NVDA','MSFT','AMZN','GOOGL','META','AMD','SPY','QQQ'],
  CRYPTO: ['BTC/USD','ETH/USD','SOL/USD','DOGE/USD','AVAX/USD','LINK/USD'],
  GLOBAL_ETFS: ['EWJ','FXI','EWG','EWU','EWZ','EWT','EWY','VGK','EIS','ISRA'],// EIS/ISRA = Israel ETFs
  FOREX_PAIRS: ['EUR','GBP','JPY','AUD','CAD','CHF'],
};
let agentState = { running:false,intervalId:null,cycleCount:0,lastCycle:null,lastAction:'NONE',status:'STOPPED',marketMode:'UNKNOWN',capitalLimit:Infinity,takeProfitTarget:null };
function setCapital(a){agentState.capitalLimit=parseFloat(a);}
function setTakeProfit(t){agentState.takeProfitTarget=parseFloat(t);}
function getActiveMarkets(){
  const now=new Date();const utcT=now.getUTCHours()*60+now.getUTCMinutes();const day=now.getUTCDay();const wd=day>=1&&day<=5;
  const open=['CRYPTO'];
  if((day>=1&&day<=4)||(day===5&&utcT<22*60)||(day===0&&utcT>=21*60))open.push('FOREX');
  if(wd&&utcT<9*60)open.push('ASIA');
  // Israel/TASE: Sun-Thu 06:59-14:15 UTC (Israel UTC+3)
  const israelDay = day === 0 || (day >= 1 && day <= 4);
  if(israelDay&&utcT>=6*60+59&&utcT<14*60+15)open.push('ISRAEL');
  if(wd&&utcT>=7*60&&utcT<16*60+30)open.push('EUROPA');
  if(wd&&utcT>=13*60+30&&utcT<20*60)open.push('USA');
  return{open,mode:open.join('+')};
}
async function log(level,message,data={}){
  console.log('[GELT365]['+level+'] '+message);
  try{await supabase.from('logs').insert({level,message,data:JSON.stringify(data),created_at:new Date().toISOString(),source:'agent-loop'});}catch(e){}
}
async function getMarketData(alpaca,mi){
  const p={};
  // --- CRYPTO via Kraken public API (no key needed) ---
  try {
    const kraken = require('./kraken');
    const tickers = await kraken.getTickers(['XBTUSD','ETHUSD','SOLUSD','ADAUSD','DOTUSD']);
    for(const t of tickers){
      const sym = t.pair.replace('XXBT','BTC').replace('ZUSD','USD').replace('XBT','BTC');
      if(t.last) p[sym]={price:parseFloat(t.last),type:'crypto',pair:t.pair,spread:t.spread};
    }
    log('INFO','Kraken data: '+Object.keys(p).join(', '));
  } catch(e){ log('WARN','Kraken data error: '+e.message); }

  // --- POLYMARKET via public CLOB API ---
  try {
    const poly = require('./polymarket');
    const markets = await poly.getActiveMarkets(5);
    for(const m of markets){
      if(m.yesPrice && m.volume > 10000){
        p['POLY:'+m.conditionId.slice(0,8)]={price:parseFloat(m.yesPrice),type:'polymarket',question:m.question,volume:m.volume,liquidity:m.liquidity};
      }
    }
  } catch(e){ log('WARN','Polymarket data error: '+e.message); }

  // --- STOCKS via Alpaca if key available ---
  if(process.env.ALPACA_API_KEY && mi.open.includes('USA')){
    for(const t of CONFIG.US_STOCKS){try{const q=await alpaca.getLatestTrade(t);p[t]={price:q.Price,type:'stock'};}catch(e){}}
  }
  return p;
}
async function getAccountStatus(alpaca){
  // Get open positions from Supabase
  let positions = [];
  try {
    const {data} = await supabase.from('positions').select('*').eq('status','open').limit(10);
    positions = data || [];
  } catch(e){}

  // Try Alpaca if key available
  if(process.env.ALPACA_API_KEY){
    try{
      const a=await alpaca.getAccount();
      const alpacaPos=await alpaca.getPositions();
      return{equity:parseFloat(a.equity),cash:parseFloat(a.cash),buyingPower:parseFloat(a.buying_power),positionCount:alpacaPos.length+positions.length,positions:[...alpacaPos,...positions]};
    }catch(e){}
  }

  // Paper mode: use capital limit
  const capital = agentState.capitalLimit === Infinity ? 500 : agentState.capitalLimit;
  return{equity:capital, cash:capital, buyingPower:capital, positionCount:positions.length, positions};
}
async function checkStopLoss(alpaca,account){for(const pos of account.positions){if(parseFloat(pos.unrealized_plpc)<=-CONFIG.STOP_LOSS_PCT){try{await alpaca.closePosition(pos.symbol);await log('WARN','STOP LOSS: '+pos.symbol);}catch(e){}}}}
async function checkTakeProfit(alpaca,account,sendWA){
  if(!agentState.takeProfitTarget||account.equity<agentState.takeProfitTarget)return;
  await log('INFO','TAKE PROFIT: $'+account.equity.toFixed(2));
  for(const pos of account.positions){try{await alpaca.closePosition(pos.symbol);}catch(e){}}
  if(sendWA)await sendWA('🎯 *GELT365.AI — TAKE PROFIT!*\n\nPortfolio: *$'+account.equity.toFixed(2)+'*\nObjetivo: *$'+agentState.takeProfitTarget.toFixed(2)+'*\n\nPosiciones liquidadas.\n\n_GELT365.AI_');
  agentState.takeProfitTarget=null;agentState.lastAction='TAKE PROFIT ejecutado';
}
async function analyzeWithClaude(prices,account,mi){
  const avail=Math.min(account.cash,agentState.capitalLimit);const maxT=Math.floor(avail/CONFIG.MAX_POSITIONS);
  const ps=Object.entries(prices).slice(0,20).map(([k,v])=>k+':$'+parseFloat(v.price).toFixed(4)).join(', ');
  const sys='You are GELT365.AI, elite global trading agent. Cash:$'+avail.toFixed(2)+' Max/trade:$'+maxT+' Positions:'+account.positionCount+'/'+CONFIG.MAX_POSITIONS+' Active:'+mi.open.join('+')+'\nAsset types: stock(USA only),crypto(24/7),etf(Asia/Europa ETFs),forex(USD/currency pairs). Min edge:'+CONFIG.MIN_EDGE_PCT*100+'%\nRespond ONLY valid JSON:{"recommendation":"BUY|SELL|PASS","asset":null,"qty":null,"price":null,"target":null,"stopLoss":null,"edge":0,"confidence":"HIGH|MEDIUM|LOW","reasoning":"","marketAnalysis":"","assetType":"stock|crypto|etf|forex","market":"USA|ASIA|EUROPA|FOREX|CRYPTO"}';
  const resp=await anthropic.messages.create({model:'claude-sonnet-4-20250514',max_tokens:1000,system:sys,messages:[{role:'user',content:'Prices:'+ps+' | Positions:'+JSON.stringify(account.positions.map(p=>({s:p.symbol,pl:p.unrealized_plpc})))}]});
  try{const m=resp.content[0].text.match(/\{[\s\S]*\}/);return m?JSON.parse(m[0]):{recommendation:'PASS',edge:0};}catch(e){return{recommendation:'PASS',edge:0};}
}
async function executeTrade(alpaca,analysis,account){
  const{recommendation,asset,qty,price,target,stopLoss,edge,reasoning,assetType}=analysis;
  if(!asset||!qty||edge<CONFIG.MIN_EDGE_PCT||account.positionCount>=CONFIG.MAX_POSITIONS)return null;
  const cost=(price||0)*qty;const avail=Math.min(account.cash||500,agentState.capitalLimit);
  if(cost>avail&&cost>0){await log('WARN','Fondos insuf: $'+cost.toFixed(2));return null;}

  const tradeId='KASS-'+Date.now();
  const side=recommendation.toLowerCase();

  // --- Try Alpaca if key available and asset is stock ---
  if(process.env.ALPACA_API_KEY && assetType==='stock'){
    try{
      const tif='day';
      const qty2=Math.max(1,Math.floor(qty));
      const order=await alpaca.createOrder({symbol:asset,qty:qty2,side,type:'market',time_in_force:tif});
      await supabase.from('positions').insert({symbol:asset,qty:qty2,entry_price:price,target_price:target,stop_loss:stopLoss,edge,reasoning,order_id:order.id,status:'open',asset_type:assetType,side,created_at:new Date().toISOString()}).catch(()=>{});
      await log('INFO','ALPACA ORDER: '+recommendation+' '+qty2+'x '+asset);
      return order;
    }catch(e){await log('WARN','Alpaca order failed, using paper: '+e.message);}
  }

  // --- Paper trade via Supabase (no broker needed) ---
  const paperQty = assetType==='stock'||assetType==='etf' ? Math.max(1,Math.floor(qty)) : parseFloat((qty||0.001).toFixed(6));
  const paperCost = (price||0)*paperQty;
  const {data:pos,error} = await supabase.from('positions').insert({
    symbol:asset, qty:paperQty, entry_price:price||0,
    target_price:target||0, stop_loss:stopLoss||0,
    edge, reasoning: reasoning||'', order_id:tradeId,
    status:'open', asset_type:assetType, side,
    created_at:new Date().toISOString()
  }).select();

  if(!error){
    await log('INFO','PAPER TRADE: '+recommendation+' '+paperQty+'x '+asset+' @ $'+price+' ['+assetType+'] ID:'+tradeId);
    return {id:tradeId, symbol:asset, qty:paperQty, side, status:'paper_filled', mode:'paper'};
  } else {
    await log('ERROR','Paper trade failed: '+error.message);
    return null;
  }
}
let _sendWA=null;
async function runCycle(alpaca,sendWA){
  agentState.cycleCount++;agentState.lastCycle=new Date().toISOString();
  const mi=getActiveMarkets();agentState.marketMode=mi.mode;
  await log('INFO','Ciclo #'+agentState.cycleCount+' | '+mi.mode);
  try{
    const account=await getAccountStatus(alpaca);
    await checkStopLoss(alpaca,account);await checkTakeProfit(alpaca,account,sendWA);
    const prices=await getMarketData(alpaca,mi);
    if(Object.keys(prices).length===0){agentState.status='WAITING';agentState.lastAction='Sin datos';return;}
    const analysis=await analyzeWithClaude(prices,account,mi);
    if(analysis.recommendation==='BUY'||analysis.recommendation==='SELL'){
      const order=await executeTrade(alpaca,analysis,account);
      agentState.lastAction=order?(analysis.recommendation+' '+analysis.asset+' ['+(analysis.assetType||'')+']'):(analysis.recommendation+' BLOQUEADO');
    }else{agentState.lastAction='PASS — '+(analysis.reasoning||'').substring(0,80);}
    agentState.status='RUNNING';
  }catch(e){agentState.status='ERROR';await log('ERROR','Ciclo fallido: '+e.message);}
}
function startAgent(alpaca,sendWAFn){
  if(agentState.running)return{success:false,message:'Ya activo'};
  if(sendWAFn)_sendWA=sendWAFn;
  agentState.running=true;agentState.status='RUNNING';agentState.cycleCount=0;
  log('INFO','GELT365.AI v3 iniciado — Cobertura Global 24/7: USA+ASIA+EUROPA+FOREX+CRYPTO');
  runCycle(alpaca,_sendWA);
  agentState.intervalId=setInterval(()=>runCycle(alpaca,_sendWA),CONFIG.INTERVAL_MS);
  return{success:true,message:'Agente global iniciado',markets:['CRYPTO','FOREX','ASIA','EUROPA','USA']};
}
function stopAgent(){
  if(!agentState.running)return{success:false,message:'No activo'};
  clearInterval(agentState.intervalId);agentState.running=false;agentState.status='STOPPED';agentState.intervalId=null;
  return{success:true,message:'Agente detenido'};
}
function getAgentStatus(){const m=getActiveMarkets();return{...agentState,intervalId:agentState.intervalId?'ACTIVE':null,config:CONFIG,activeMarkets:m.open};}
module.exports={startAgent,stopAgent,getAgentStatus,setCapital,setTakeProfit};