# BURBREEK v5 deployment notes

This build fixes the Railway/PNR UI, header behavior, live Shorts viewer, fresh news feed, movie data integration and server-rendered AI SEO metadata.

## Render environment variables
Keep existing:
- YOUTUBE_API_KEY
- GEMINI_API_KEY
- GEMINI_MODEL=gemini-3.8-flash
- NEWSAPI_KEY (fallback only)

Add:
- RAILRADAR_API_KEY for live train running status
- RAILKIT_API_KEY for PNR status
- TMDB_API_KEY for current movie data

## Notes
- RailRadar is used for live train running status. The integration requests `authoritative=true` so the live train route is fetched from the upstream tier rather than using the default local cache.
- PNR status remains behind the separate RailKit provider because the verified RailRadar public documentation exposes train/live and PNR prediction/refund endpoints, but not a full PNR-status endpoint.
- Ticket prices are not fabricated. The ticket area shows the current movie list from TMDB and links users to live cinema discovery; a true in-app price comparison requires a live cinema booking feed.
- The NewsAPI Developer plan currently has a 24-hour article delay, so BURBREEK uses GDELT first for fresh article discovery and keeps NewsAPI as fallback. GDELT ArticleList supports recent time windows and social preview images.
- The `/story` route renders title, AI meta description, canonical URL, Open Graph tags and valid raw Article JSON-LD on the server.
