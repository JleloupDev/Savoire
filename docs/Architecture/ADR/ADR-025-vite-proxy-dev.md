# ADR-025 — Vite Dev Proxy for API and SignalR

## Status
Accepted (development only)

## Context
In development, the frontend runs on `localhost:3000` (Vite) and the backend on `localhost:5000`. Cross-origin requests from the browser to the backend would require CORS configuration. SignalR WebSocket connections have additional CORS constraints.

## Decision
Vite's built-in proxy is configured to forward `/api` and `/hubs` requests to `http://localhost:5000`. From the browser's perspective, all requests go to the same origin — no CORS headers needed.

```ts
// vite.config.ts
proxy: {
  '/api': 'http://localhost:5000',
  '/hubs': { target: 'http://localhost:5000', ws: true },
}
```

## Consequences
- No CORS configuration needed in the backend for local development.
- The backend does not need to know about frontend dev origins.
- This proxy is **development only** — in production, the frontend is served by the same host as the backend, or a reverse proxy (Nginx/Caddy) handles routing at the infrastructure level.
- New contributors must not add CORS middleware to the backend to "fix" apparent CORS errors — the proxy already handles this in dev.
