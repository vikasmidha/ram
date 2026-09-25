const express = require('express');
const fetch = require('node-fetch');
const cache = require('../cache');

const router = express.Router();

const CATEGORY_QUERIES = {
  trending: 'India OR world news',
  startup: '(startup OR funding OR founder OR venture) India',
  funding: '"funding round" OR "raised" startup India',
  ai: '"artificial intelligence" OR "AI model"',
  market: 'India (Nifty OR Sensex OR NSE OR BSE OR "stock market" OR "share market")',
  politics: 'parliament OR "government policy" India',
  gtk: 'explainer OR "what you need to know"',
};

const CATEGORY_TTL_SECONDS = { trending: 60, market: 60, startup: 120, funding: 120, ai: 120, politics: 120, gtk: 180 };

function isConfigured(){
  const key=process.env.NEWSAPI_KEY;
  return Boolean(key && !key.includes('your_'));
}
function clean(v){return String(v||'').replace(/\s+/g,' ').trim();}
function domainName(domain){return clean(domain).replace(/^www\./,'') || 'Unknown source';}

async function fetchGdelt(category){
  const q=CATEGORY_QUERIES[category]||CATEGORY_QUERIES.trending;
  const timespan=(category==='market'||category==='trending')?'12h':'24h';
  const url=new URL('https://api.gdeltproject.org/api/v2/doc/doc');
  url.searchParams.set('query',q);
  url.searchParams.set('mode','artlist');
  url.searchParams.set('maxrecords','20');
  url.searchParams.set('timespan',timespan);
  url.searchParams.set('sort','datedesc');
  url.searchParams.set('format','json');
  const res=await fetch(url.toString(),{headers:{Accept:'application/json','User-Agent':'BURBREEK/1.0'},timeout:10000});
  if(!res.ok) throw new Error(`GDELT HTTP ${res.status}`);
  const body=await res.json();
  const rows=Array.isArray(body?.articles)?body.articles:(Array.isArray(body?.data)?body.data:[]);
  return rows.filter(a=>a&&a.title&&a.url).map(a=>({
    tag:category.toUpperCase(),
    headline:clean(a.title),
    dek:'',
    source:domainName(a.domain),
    url:a.url,
    time:a.seendate?parseGdeltDate(a.seendate):new Date().toISOString(),
    imageUrl:a.socialimage||null,
    image:a.socialimage||null,
  }));
}

function parseGdeltDate(v){
  const s=String(v||'');
  if(/^\d{8}T\d{6}Z$/.test(s)){
    const iso=s.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,'$1-$2-$3T$4:$5:$6Z');
    const d=new Date(iso);
    if(!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return s;
}

async function fetchNewsApi(category, options={}){
  const key=process.env.NEWSAPI_KEY;
  if(!key || key.includes('your_newsapi_key')) throw new Error('NEWSAPI_KEY not configured — add a real key to Render');
  const q=CATEGORY_QUERIES[category]||CATEGORY_QUERIES.trending;
  const ttl=CATEGORY_TTL_SECONDS[category]||120;
  const cacheKey=`newsapi:${category}`;
  if(!options.forceRefresh){const cached=cache.get(cacheKey);if(cached)return cached;}
  const from=new Date(Date.now()-(category==='market'||category==='trending'?48:72)*60*60*1000);
  const url=new URL('https://newsapi.org/v2/everything');
  url.searchParams.set('q',q);url.searchParams.set('language','en');url.searchParams.set('sortBy','publishedAt');url.searchParams.set('pageSize','20');url.searchParams.set('from',from.toISOString());
  const res=await fetch(url.toString(),{headers:{Accept:'application/json','X-Api-Key':key,'X-No-Cache':'true'},timeout:10000});
  if(!res.ok) throw new Error(`NewsAPI error ${res.status}`);
  const data=await res.json();
  const mapped=(data.articles||[]).filter(a=>a&&a.title&&a.title!=='[Removed]').map(a=>({tag:category.toUpperCase(),headline:clean(a.title),dek:clean(a.description),source:a.source?.name||'Unknown',url:a.url,time:a.publishedAt,imageUrl:a.urlToImage||null,image:a.urlToImage||null}));
  cache.set(cacheKey,mapped,ttl);
  return mapped;
}

async function fetchCategory(category, forceRefresh){
  const ttl=CATEGORY_TTL_SECONDS[category]||120;
  const cacheKey=`news:${category}`;
  if(!forceRefresh){const cached=cache.get(cacheKey);if(cached)return {articles:cached,source:'cache',ttl};}
  try{
    const live=await fetchGdelt(category);
    if(live.length){cache.set(cacheKey,live,ttl);return {articles:live,source:'GDELT',ttl};}
  }catch(err){
    console.warn(`[news] GDELT ${category} failed:`,err.message||err);
  }
  const fallback=await fetchNewsApi(category,{forceRefresh});
  cache.set(cacheKey,fallback,ttl);
  return {articles:fallback,source:'NewsAPI',ttl};
}

router.get('/:category',async(req,res)=>{
  const category=String(req.params.category||'trending').toLowerCase();
  const forceRefresh=req.query.refresh==='1';
  try{
    const result=await fetchCategory(category,forceRefresh);
    res.set('Cache-Control','no-store');
    res.json({category,articles:result.articles,source:result.source,refreshedAt:new Date().toISOString(),cacheTtlSeconds:result.ttl,configured:isConfigured(),freshFeed:result.source==='GDELT'||result.source==='NewsAPI'});
  }catch(err){res.status(502).json({error:err.message});}
});

module.exports=router;
