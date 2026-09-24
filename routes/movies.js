const express = require('express');
const fetch = require('node-fetch');

const router = express.Router();
const cache = { at: 0, data: null };
const CACHE_TTL_MS = 30 * 60 * 1000;

function configured(){ return Boolean(process.env.TMDB_BEARER_TOKEN || process.env.TMDB_API_KEY); }
async function tmdb(path, params={}){
  const url=new URL(`https://api.themoviedb.org/3${path}`);
  Object.entries(params).forEach(([k,v])=>url.searchParams.set(k,String(v)));
  const headers={Accept:'application/json'};
  if(process.env.TMDB_BEARER_TOKEN) headers.Authorization=`Bearer ${process.env.TMDB_BEARER_TOKEN}`;
  else url.searchParams.set('api_key',process.env.TMDB_API_KEY);
  const response=await fetch(url.toString(),{headers});
  const body=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(body?.status_message||`TMDB HTTP ${response.status}`);
  return body;
}
function mapMovie(m){
  return {
    id:m.id,
    title:m.title||m.name||'Untitled',
    poster:m.poster_path?`https://image.tmdb.org/t/p/w500${m.poster_path}`:null,
    backdrop:m.backdrop_path?`https://image.tmdb.org/t/p/w780${m.backdrop_path}`:null,
    releaseDate:m.release_date||null,
    rating:Number(m.vote_average||0),
    voteCount:Number(m.vote_count||0),
    overview:m.overview||'',
    url:`https://www.themoviedb.org/movie/${m.id}`,
  };
}
router.get('/status',(req,res)=>res.json({provider:'TMDB',configured:configured()}));
router.get('/latest',async(req,res)=>{
  if(!configured()) return res.status(503).json({success:false,configured:false,error:'TMDB movie data is not configured. Add TMDB_API_KEY or TMDB_BEARER_TOKEN in Render.'});
  if(cache.data && Date.now()-cache.at<CACHE_TTL_MS) return res.json(cache.data);
  try{
    const params={language:'en-IN',region:'IN',page:1};
    const [now,upcoming]=await Promise.all([
      tmdb('/movie/now_playing',params),
      tmdb('/movie/upcoming',params),
    ]);
    const data={success:true,provider:'TMDB',region:'IN',nowPlaying:(now.results||[]).slice(0,10).map(mapMovie),upcoming:(upcoming.results||[]).slice(0,10).map(mapMovie),updatedAt:new Date().toISOString()};
    cache.at=Date.now(); cache.data=data; res.json(data);
  }catch(err){
    console.error('[movies]',err.message||err);
    res.status(502).json({success:false,error:'Unable to fetch latest movie data.'});
  }
});
module.exports=router;
