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
  for(const t of CONFIG.CRYPTO){try{const q=await alpaca.getLatestCryptoBars(t,{timeframe:'1Min',limit:1});const b=q[t];if(b&&b.length>0)p[t]={price:b[b.length-1].c,type:'crypto'};}catch(e){}}
  if(mi.open.includes('USA')){for(const t of CONFIG.US_STOCKS){try{const q=await alpaca.getLatestTrade(t);p[t]={price:q.Price,type:'stock'};}catch(e){}}}
  if(mi.open.includes('ASIA')||mi.open.includes('EUROPA')||mi.open.includes('ISRAEL')||mi.open.includes('LATAM')){
    for(const etf of CONFIG.GLOBAL_ETFS){try{
      const r=await fetch('https://query1.finance.yahoo.com/v8/finance/chart/'+etf+'?interval=1m&range=1d');
      const d=await r.json();const price=d?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if(price){const reg=['EWJ','EWT','EWY','FXI'].includes(etf)?'ASIA':'EUROPA';if(mi.open.includes(reg))p[etf]={price,type:'etf',market:reg};}
    }catch(e){}}
  }
  if(mi.open.includes('FOREX')){
    try{const r=await fetch('https://api.exchangerate-api.com/v4/latest/USD');const d=await r.json();
      if(d.rates){for(const c of CONFIG.FOREX_PAIRS){if(d.rates[c])p['USD/'+c]={price:d.rates[c],type:'forex'};}}}catch(e){}
  }
  return p;
}
async function getAccountStatus(alpaca){const a=await alpaca.getAccount();const pos=await alpaca.getPositions();return{equity:parseFloat(a.equity),cash:parseFloat(a.cash),buyingPower:parseFloat(a.buying_power),positionCount:pos.length,positions:pos};}
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
  const cost=(price||0)*qty;const avail=Math.min(account.cash,agentState.capitalLimit);
  if(cost>avail){await log('WARN','Fondos insuf: $'+cost.toFixed(2));return null;}
  try{
    const tif=assetType==='crypto'?'gtc':'day';
    const qty2=(assetType==='stock'||assetType==='etf')?Math.floor(qty):qty;
    const order=await alpaca.createOrder({symbol:asset,qty:qty2,side:recommendation.toLowerCase(),type:'market',time_in_force:tif});
    await supabase.from('positions').insert({symbol:asset,qty,entry_price:price,target_price:target,stop_loss:stopLoss,edge,reasoning,order_id:order.id,status:'open',asset_type:assetType,created_at:new Date().toISOString()}).catch(()=>{});
    await log('INFO','ORDEN: '+recommendation+' '+qty2+'x '+asset+' ['+assetType+']');return order;
  }catch(e){await log('ERROR','Orden fallida: '+e.message);return null;}
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