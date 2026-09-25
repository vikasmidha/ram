const express = require('express');
const fetch = require('node-fetch');

const router = express.Router();
const cache = { at: 0, data: null };
const CACHE_TTL_MS = 60 * 1000;

function keyConfigured(){ return Boolean(process.env.NEWSAPI_KEY && !process.env.NEWSAPI_KEY.includes('your_')); }

router.get('/', async (req,res)=>{
  if(!keyConfigured()) return res.status(503).json({success:false,error:'News API is not configured.',configured:false});
  if(cache.data && Date.now()-cache.at<CACHE_TTL_MS) return res.json(cache.data);
  const now=new Date();
  const from=new Date(now.getTime()-18*60*60*1000);
  try{
    const url=new URL('https://newsapi.org/v2/everything');
    url.searchParams.set('q','Sensex OR Nifty OR "Bank Nifty" OR NSE OR BSE OR "Indian stock market"');
    url.searchParams.set('from',from.toISOString());
    url.searchParams.set('to',now.toISOString());
    url.searchParams.set('language','en');
    url.searchParams.set('sortBy','publishedAt');
    url.searchParams.set('pageSize','10');
    url.searchParams.set('apiKey',process.env.NEWSAPI_KEY);
    const response=await fetch(url.toString(),{headers:{Accept:'application/json'}});
    const body=await response.json().catch(()=>({}));
    if(!response.ok || body.status==='error') throw new Error(body.message||`News API HTTP ${response.status}`);
    const articles=(body.articles||[]).filter(a=>a?.url&&a?.title&&a?.publishedAt).filter(a=>{const ts=new Date(a.publishedAt).getTime();return Number.isFinite(ts)&&ts<=Date.now()&&Date.now()-ts<=24*60*60*1000;}).sort((a,b)=>new Date(b.publishedAt)-new Date(a.publishedAt)).map(a=>({
      title:a.title,
      description:a.description||'',
      source:a.source?.name||'News',
      url:a.url,
      image:a.urlToImage||null,
      publishedAt:a.publishedAt||null,
    }));
    const data={success:true,articles,updatedAt:new Date().toISOString()};
    cache.at=Date.now(); cache.data=data;
    res.json(data);
  }catch(err){
    console.error('[market-news]',err.message||err);
    res.status(502).json({success:false,error:'Unable to fetch current market news.'});
  }
});

module.exports=router;
