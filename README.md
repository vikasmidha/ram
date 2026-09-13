# BRIEF v1

Launchable Phase 1 build of BRIEF: news, markets, weather, and product comparison with a PostgreSQL-backed activity foundation.

## Requirements
- Node.js 18+
- PostgreSQL 14+ for production

## Local run
1. `cp .env.example .env`
2. Set `NODE_ENV=development`, `DATABASE_SSL=false`, `REQUIRE_DATABASE=false`, and a local PostgreSQL `DATABASE_URL`.
3. Add provider keys if you want live news/weather.
4. `npm install`
5. `npm start`
6. Open `http://localhost:4000`
7. Check `http://localhost:4000/health`

## Production
- Set a real `CORS_ORIGINS` value; do not leave the example domain.
- Set `REQUIRE_DATABASE=true`.
- Set `DATABASE_URL` and provider keys as environment secrets.
- Set `GA_MEASUREMENT_ID` when the production GA4 property exists.
- Put HTTPS/reverse proxy in front of the app.

## Data policy
`data/manual-prices.json` is seed/manual data. It is not represented as live retailer pricing. The API exposes `source: manual` and the frontend should retain that distinction until real provider integrations are added.

## Health semantics
- `/health` returns 200 when the service is ready.
- If `DATABASE_URL` is configured and the database cannot initialize, health returns 503.
- If the database is intentionally omitted for a local fallback build, health remains available.
