const express=require('express');
const fetch=require('node-fetch');

const router=express.Router();
const trainCache=new Map();
const TRAIN_CACHE_TTL_MS=45*1000;

function fail(res,status,message,requestId){return res.status(status).json({success:false,error:message,requestId});}
function validPnr(pnr){return /^\d{10}$/.test(String(pnr||'').replace(/\D/g,''));}
function validTrain(n){return /^\d{5}$/.test(String(n||'').trim());}
function validDate(d){return !d || /^\d{2}-\d{2}-\d{4}$/.test(String(d).trim());}
function toRailRadarDate(d){
  if(!d) return '';
  const [dd,mm,yyyy]=String(d).split('-');
  return `${yyyy}-${mm}-${dd}`;
}

async function railRadarTrain(number,date,requestId){
  if(!process.env.RAILRADAR_API_KEY){const e=new Error('Live train tracking is not configured. Add RAILRADAR_API_KEY in Render.');e.code='NOT_CONFIGURED';throw e;}
  const url=new URL(`https://api.railradar.in/v1/trains/${number}/live`);
  if(date) url.searchParams.set('date',toRailRadarDate(date));
  url.searchParams.set('authoritative','true');
  const res=await fetch(url.toString(),{headers:{Accept:'application/json',Authorization:`Bearer ${process.env.RAILRADAR_API_KEY}`,'X-Request-Id':requestId||''},timeout:10000});
  const body=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(body?.error?.message||body?.error||`RailRadar HTTP ${res.status}`);
  return body;
}

async function railKitPnr(pnr){
  if(!process.env.RAILKIT_API_KEY){const e=new Error('PNR status service is not configured. Add RAILKIT_API_KEY in Render.');e.code='NOT_CONFIGURED';throw e;}
  let mod;
  try{mod=await import('railkit');}catch(e){e.code='SDK_MISSING';throw new Error('PNR provider package is unavailable after deployment.');}
  if(typeof mod.configure!=='function'||typeof mod.checkPNRStatus!=='function') throw new Error('PNR provider SDK is unavailable or incompatible.');
  mod.configure(process.env.RAILKIT_API_KEY);
  return mod.checkPNRStatus(pnr);
}

router.get('/pnr',async(req,res)=>{
  const pnr=String(req.query.pnr||'').replace(/\D/g,'');
  if(!validPnr(pnr)) return fail(res,400,'PNR must be exactly 10 digits.',req.requestId);
  try{
    const result=await railKitPnr(pnr);
    if(!result||result.success===false) return fail(res,502,result?.error||'Unable to fetch PNR status.',req.requestId);
    return res.json(result);
  }catch(err){
    console.error(`[${req.requestId||'unknown'}] railway PNR failed`,err.message||err);
    return fail(res,err.code==='NOT_CONFIGURED'?503:502,err.code==='NOT_CONFIGURED'?err.message:'Railway PNR service is temporarily unavailable.',req.requestId);
  }
});

router.get('/train/:trainNumber/live',async(req,res)=>{
  const number=String(req.params.trainNumber||'').trim();
  const date=String(req.query.date||'').trim();
  if(!validTrain(number)) return fail(res,400,'Train number must be exactly 5 digits.',req.requestId);
  if(!validDate(date)) return fail(res,400,'Journey date must be DD-MM-YYYY or omitted for today.',req.requestId);
  const cacheKey=`${number}:${date||'today'}`;
  const cached=trainCache.get(cacheKey);
  if(cached&&Date.now()-cached.at<TRAIN_CACHE_TTL_MS) return res.json(cached.data);
  try{
    const result=await railRadarTrain(number,date,req.requestId);
    trainCache.set(cacheKey,{at:Date.now(),data:result});
    res.set('Cache-Control','no-store');
    return res.json(result);
  }catch(err){
    console.error(`[${req.requestId||'unknown'}] railway train failed`,err.message||err);
    return fail(res,err.code==='NOT_CONFIGURED'?503:502,err.code==='NOT_CONFIGURED'?err.message:'Live train service is temporarily unavailable.',req.requestId);
  }
});

router.get('/status',(req,res)=>res.json({provider:'RailRadar + RailKit',trainTrackingConfigured:Boolean(process.env.RAILRADAR_API_KEY),pnrConfigured:Boolean(process.env.RAILKIT_API_KEY)}));

module.exports=router;
