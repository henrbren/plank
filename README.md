# Plank

**AI-arbeidsflate for FDV** – forvaltning, drift og vedlikehold av eiendom. Tenk «Cursor for FDV»: porteføljen til venstre, arbeidsflaten i midten og agentene til høyre. Agentene leser dokumentene dine, holder FDV-registeret oppdatert, registrerer avvik, spør mot BIM-modellen og bygger egne sider (artifacts) med levende data – for hver eiendom, hvert bygg, hver etasje og hvert rom.

Kjører i sin helhet på Cloudflare: Workers, D1, R2, Workers AI og Cron Triggers. Agentene bruker Claude-API-et, e-post sendes med Resend.

---

## Innhold i MVP-en

| Område | Hva er på plass |
|---|---|
| **Portefølje** | Eiendom → bygg → etasje → rom, med gnr./bnr., bygningsnummer, BTA, romnummer og areal. Tre i sidepanelet. |
| **Dokumenter** | Opplasting til R2, automatisk tekstuttrekk (Workers AI `toMarkdown` for PDF/Office/bilder, Claude som reserve), fulltekstsøk (SQLite FTS5) og auto-klassifisering (tittel, dokumenttype, NS 3451, sammendrag). Forhåndsvisning av PDF og bilder. |
| **FDV-register** | Komponenter med NS 3451, TFM, produsent/modell, garanti, serviceintervall (neste service beregnes), tilstandsgrad (NS 3424) og IFC-GUID. |
| **Oppgaver** | Vedlikehold, avvik, kontroller og dokumentasjonsmangler – opprettet av brukere eller agenter. |
| **Agenter** | Konfigurerbare agenter: instrukser, modell (Claude Sonnet/Opus/Haiku/Fable), innsats, verktøytilganger, avgrensning til eiendom/bygg, tidsplan og e-postrapporter. Seks ferdige maler. Strømmende chat med verktøysteg, tankegang og lenker. |
| **Artifacts (sider)** | Agentene (eller du) lager HTML-sider som kjøres i en sandkasse og henter levende data via `window.plank`. Versjonshistorikk, gjenoppretting, HTML-redigering og «Be agenten rette»-knapp ved feil. |
| **BIM / IFC** | 3D-viewer i nettleseren (web-ifc + three.js), etasjefilter, egenskaper for valgt element, import av etasjer og rom til porteføljen, elementindeks som agentene kan spørre mot, og «Registrer som komponent». |
| **Innlogging** | Magic link via Resend, sesjonscookie, organisasjoner med roller (eier/admin/medlem) og invitasjoner. |
| **Annet** | Kommandopalett (⌘K), agentpanel (⌘J), aktivitetslogg, lyst/mørkt tema, mobiltilpasset, demodata med IFC-modell. |

## Arkitektur

```
 Nettleser (React + Vite)                     Cloudflare
 ┌──────────────────────────┐   /api/*   ┌──────────────────────────────────────────┐
 │ Portefølje │ Arbeidsflate│ ─────────▶ │ Worker (Hono)                            │
 │   (tre)    │ (sider, IFC)│            │  ├─ auth (magic link) ─────▶ Resend       │
 │            │  Agentpanel │ ◀── SSE ── │  ├─ agent-runtime ─────────▶ Claude API   │
 └──────────────────────────┘            │  ├─ D1  (data + FTS5-søk)                 │
   ▲ sandkasse-iframe (artifacts)        │  ├─ R2  (filer)                           │
   └─ window.plank ⇄ postMessage         │  ├─ Workers AI (toMarkdown)               │
                                         │  └─ Cron hvert 15. min → planlagte agenter│
                                         └──────────────────────────────────────────┘
```

- **Én Worker** serverer både API-et og React-appen (statiske filer via `assets`). Alt under `/api/*` går til Workeren.
- **Agent-runtime** (`worker/agent/runtime.ts`) kjører verktøyløkken mot Claude Messages API med strømming, adaptive thinking, effort-styring og prompt caching. Hele meldingshistorikken lagres i Claude-format i D1, slik at samtaler kan fortsettes.
- **Artifacts** vises i en `sandbox="allow-scripts"`-iframe (opaque origin) med streng CSP uten nettverkstilgang. All data går via `postMessage` til appen, som gjør kallene med brukerens tilgang. Endringer (f.eks. opprette oppgave) må bekreftes av brukeren.
- **IFC** parses i nettleseren. Etasjer, rom og en elementindeks sendes til API-et, slik at agentene kan spørre mot modellen uten å parse IFC på serveren.

## Kom i gang lokalt

Krever Node 22+.

```bash
npm install
cp .dev.vars.example .dev.vars      # fyll inn ANTHROPIC_API_KEY (valgfritt RESEND_API_KEY)
npm run db:migrate:local
npm run dev                          # app på http://localhost:5173, API på :8787
```

- Uten `RESEND_API_KEY` og med `DEV_MODE=true` vises innloggingslenken direkte på skjermen.
- `npm run dev` kjører Workeren uten Cloudflare-tilkobling (`--local`). Workers AI (PDF/Office-uttrekk) krever `wrangler login` og `npm run dev:api:remote`. Lokalt faller Plank tilbake til Claude for PDF og bilder.
- Vil du teste uten Claude-nøkkel? `npm run mock:claude` og sett `ANTHROPIC_BASE_URL=http://localhost:8788` i `.dev.vars`.
- Etter innlogging: velg **Last inn demodata** på oversikten for to eiendommer med dokumenter, komponenter, oppgaver, en levende side og en IFC-modell.

## Deploy til Cloudflare

```bash
npx wrangler login
npx wrangler d1 create plank              # kopier database_id inn i wrangler.jsonc
npx wrangler r2 bucket create plank-files

# Hemmeligheter
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put RESEND_API_KEY

# Juster vars i wrangler.jsonc: APP_URL, EMAIL_FROM (verifisert domene i Resend), ALLOWED_EMAIL_DOMAINS
npm run deploy                            # bygger, migrerer D1 og deployer
```

Legg deretter på eget domene under *Workers & Pages → plank → Settings → Domains & Routes*, og oppdater `APP_URL`.

**Automatisk deploy fra GitHub:** `.github/workflows/ci.yml` typesjekker og bygger på hver push/PR, og deployer fra `main` når repoet har hemmelighetene `CLOUDFLARE_API_TOKEN` (mal: *Edit Cloudflare Workers* + D1-rettigheter) og `CLOUDFLARE_ACCOUNT_ID`.

### Konfigurasjon

| Navn | Type | Beskrivelse |
|---|---|---|
| `ANTHROPIC_API_KEY` | secret | Nøkkel til Claude-API-et |
| `RESEND_API_KEY` | secret | Nøkkel til Resend (innlogging, invitasjoner, agentrapporter) |
| `APP_URL` | var | Offentlig adresse, brukes i lenker i e-post |
| `EMAIL_FROM` | var | Avsender, f.eks. `Plank <noreply@plank.no>` (domenet må være verifisert i Resend) |
| `DEFAULT_MODEL` | var | Modell for nye agenter (standard `claude-sonnet-5-5`) |
| `ALLOWED_EMAIL_DOMAINS` | var | Kommaseparert liste – begrenser hvem som kan registrere seg (inviterte kommer alltid inn) |
| `DEV_MODE` | var | `true` viser innloggingslenken uten e-post. Må være `false` i produksjon |
| `ANTHROPIC_BASE_URL` | var | Valgfri – for mock/proxy |

## Agenter

Verktøy gis per gruppe (velges i agentinnstillingene):

| Gruppe | Verktøy |
|---|---|
| Les dokumenter | `search_documents`, `read_document`, `list_documents` |
| Klassifisere dokumenter | `update_document` |
| Les / endre portefølje | `get_portfolio`, `get_location` / `create_location`, `update_location` |
| Les / endre FDV-register | `list_components`, `get_component` / `save_component` |
| Oppgaver og avvik | `list_tasks`, `create_task`, `update_task` |
| Lage sider | `create_artifact`, `update_artifact`, `get_artifact`, `list_artifacts` |
| BIM / IFC | `ifc_overview`, `query_ifc_elements` |
| Sende e-post | `send_email` (kun til medlemmer og agentens varslingsliste) |
| Nettsøk | Claude sitt web search-verktøy |

**Maler:** FDV-assistent, Dokumentkontrollør, Vedlikeholdsplanlegger, Avviksmottak, Sidebygger og BIM-analytiker. De tre første opprettes automatisk for nye organisasjoner.

**Tidsplaner** (`daily@07:00`, `weekdays@07:00`, `weekly:1@07:00`, `monthly:1@07:00`, Oslo-tid) kjøres av Cron Trigger hvert 15. minutt. Hver kjøring blir en egen samtale med rapport, og sendes på e-post til varslingslisten.

## `window.plank` – API for artifacts

```js
const komponenter = await plank.query("components.list", { building_id, service_due_before: "2026-12-31" });
const oppgaver    = await plank.query("tasks.list", { status: "open" });
await plank.action("tasks.create", { title: "Bytt filter", type: "vedlikehold" }); // brukeren bekrefter
plank.open("component", id);  // navigerer i Plank
plank.context                 // { orgName, artifactId, buildingId, propertyId, theme }
```

Ressurser: `portfolio.tree`, `properties.list`, `buildings.get`, `components.list`, `tasks.list`, `documents.list`, `documents.search`, `ifc.models`, `ifc.elements`. Full beskrivelse står i `worker/agent/prompts.ts` (det er samme tekst som agentene får).

## Sikkerhet

- Alle data er skilt per organisasjon (`org_id` på hver spørring) og krever medlemskap.
- Sesjonscookie er `HttpOnly`, `Secure` og `SameSite=Lax`. Alle muterende kall krever headeren `X-Plank` (CSRF-vern via CORS-preflight).
- Innloggingslenker lagres kun som SHA-256-hash, er engangs og utløper etter 15 minutter. Rate limit per e-post.
- Opplastede HTML/SVG/XML-filer serveres som nedlasting med `CSP: sandbox`.
- Artifacts kjører i sandkasse (opaque origin) med CSP som blokkerer `fetch`/XHR, skjemaer og popups, og endringer via broen må bekreftes. Nettlesere kan ikke hindre at en ramme navigerer seg selv bort, så en ondsinnet side kan i teorien lekke data den har lest via URL-en. Plank oppdager navigasjon, kobler fra broen og laster siden på nytt – men bare medlemmer og agenter i organisasjonen kan lage sider. Godkjenning av agent-genererte sider før bruk står på veikartet.
- Agentene får beskjed om at innhold fra dokumenter, IFC og nett er data – ikke instruksjoner. E-post kan bare sendes til medlemmer og varslingslisten.
- Opplastede filer får MIME-type fra filendelsen (ikke fra klienten). Bare PDF, bilder og ren tekst vises direkte; alt annet lastes ned.
- Systemprompt og verktøy fryses per samtale, slik at endringer i agentoppsettet ikke ødelegger pågående samtaler (gjelder fra neste samtale).

## Kjente begrensninger og veien videre

- **Lange agentkjøringer** strømmes direkte fra Workeren. Lukkes fanen midt i et svar, fullføres det i inntil ~30 sekunder i bakgrunnen. Neste steg er å flytte kjøringen til Durable Objects (evt. Cloudflare Agents SDK) for gjenopptakbare kjøringer.
- **Store filer:** opplasting går via Workeren (maks ~95 MB). For store IFC-filer bør vi bruke R2 multipart/presigned upload.
- **Søk** er fulltekst (FTS5). Semantisk søk med Vectorize + embeddings er et naturlig neste steg.
- **IFC-viewer** lager én mesh per element – fint opp til noen titalls tusen elementer. For større modeller: BatchedMesh eller That Open Engine (fragments).
- Ideer: BCF-støtte, QR-koder på komponenter for avviksmelding fra mobil, import fra FDV-systemer (f.eks. via TFM/NS 3451-eksport), deling av artifacts med eksterne, SSO (Entra ID).

## Prosjektstruktur

```
worker/            Cloudflare Worker (API, agent-runtime, cron)
  agent/           runtime, verktøy, prompts, maler, tidsplan
  routes/          HTTP-ruter
  services/        forretningslogikk (deles av ruter og agentverktøy)
  lib/             Claude-klient, e-post, dokumentbehandling, auth, DB-hjelpere
src/               React-app
  features/chat/   agentpanel og samtalevisning
  features/artifacts/  sandkasse + window.plank-bro
  features/ifc/    IFC-viewer og import
shared/types.ts    delte typer
migrations/        D1-skjema
public/samples/    demo-IFC (generert med scripts/make-sample-ifc.py)
scripts/           wasm-kopiering, mock av Claude, IFC-generator
```
