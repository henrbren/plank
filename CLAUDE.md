# Plank – notater for videre utvikling

Plank er en AI-arbeidsflate for FDV (forvaltning, drift og vedlikehold) som kjører på Cloudflare.
Kode og UI er på norsk (bokmål). Kommentarer, feilmeldinger og tekster i UI skal være på norsk.

## Struktur
- `worker/` – Cloudflare Worker (Hono). Inngang: `worker/index.ts`.
  - `routes/` – HTTP-ruter. Alt org-spesifikt ligger under `/api/orgs/:orgId/...` og går gjennom `requireUser` + `requireOrg`.
  - `services/` – forretningslogikk som deles av ruter og agentverktøy. Alle spørringer MÅ filtrere på `org_id`.
  - `agent/` – agent-runtime: `runtime.ts` (verktøyløkke + strømming), `tools.ts` (verktøy per gruppe), `prompts.ts` (systemprompt + bridge-dokumentasjon), `templates.ts`, `scheduler.ts` (cron), `schedule.ts`.
  - `lib/anthropic.ts` – minimal Claude-klient (fetch + SSE). Assistentmeldinger lagres og spilles av UENDRET (thinking-blokker med signatur må med).
  - `mcp/` – MCP-server (`server.ts`, JSON-RPC over HTTP), OAuth for MCP-klienter (`oauth.ts`), eksterne verktøy (`tools.ts`) og prompts. REST-varianten ligger i `routes/tools.ts`.
- `src/` – React-app (Vite, React Router 7, TanStack Query, Tailwind v4).
  - `features/chat/` – agentpanelet og visning av samtaler.
  - `features/artifacts/ArtifactFrame.tsx` – sandkasse for agent-genererte sider + `window.plank`-broen.
  - `features/ifc/` – IFC-viewer (web-ifc + three.js) og import av etasjer/rom/elementindeks.
- `shared/types.ts` – typer delt mellom Worker og app. Worker importerer med relativ sti (`../../shared/types`), appen med `@shared/types`.
- `migrations/` – D1-migrasjoner. Lag ny fil for endringer (`0002_...sql`), ikke endre eksisterende etter deploy.

## Konvensjoner
- Zod 4: bruk egne patch-skjemaer UTEN `.default()` – i zod 4 brukes default også i `.partial()`.
- D1: maks 100 bundne parametere per spørring og begrenset antall ledd i `UNION`. Bruk `json_each` for bulk-innsetting (se `routes/ifc.ts`).
- Nye agentverktøy: legg til i `TOOLS` i `worker/agent/tools.ts`, gi dem en `group` og en norsk `label`, og legg evt. til visningsnavn i `src/features/chat/transcript.tsx`.
- Endringer agentene gjør skal logges med `activityStatement`. Bruk `actorOf(ctx)`/`logAgent` i verktøy – via MCP/API føres endringen på brukeren («Navn via nøkkel»), ikke på agenten.
- Agentverktøy blir automatisk tilgjengelige i MCP og REST-API-et (`toolDefsFor`). Verktøy som endrer data må stå i `WRITE_TOOLS`, ellers får lesenøkler dem og de merkes som skrivebeskyttet i MCP.
- Auth: `requireUser` godtar sesjonscookie eller `Authorization: Bearer` (API-nøkkel `plk_`, OAuth `plko_`). `c.get("apiKey")` er satt for bearer-kall – bruk `assertSession` for ting som bare skal gjøres fra appen. `orgAccess` i `lib/auth.ts` gir rolle og tilgang (brukes også av MCP).
- Layout bruker container queries (`@container` på hovedflaten, `@xl:`, `@4xl:` osv.) fordi agentpanelet tar plass.

## Lokal testing uten API-nøkkel
`npm run mock:claude` starter en mock av Claude Messages API på port 8788. Sett `ANTHROPIC_BASE_URL=http://localhost:8788` i `.dev.vars`.
