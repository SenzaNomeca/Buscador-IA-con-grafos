# AGENTS.md — VORAEL

## Quick commands

```bash
pnpm test                    # run all API tests (vitest)
pnpm test:watch              # vitest watch mode
pnpm test:coverage           # vitest with coverage
cd apps/api && npx vitest run test/routes.test.ts   # single test file
pnpm build                   # build both api + web
pnpm build:api               # tsc only
pnpm build:web               # tsc -b && vite build
pnpm lint                    # eslint (API + web) con config raíz
pnpm lint:fix                # eslint --fix
pnpm dev                     # dev both (api :3001, web :5173)
pnpm seed:generate           # sintetiza + siembra 1000 filas gen-* (DB_MOCK=false)
pnpm seed:generate:clear     # borra filas gen-* y re-siembra
cd apps/api && pnpm dump:prod    # vuelca TODO el catálogo público → data/images.json
cd apps/api && pnpm dump:sync    # sync incremental (solo filas nuevas; ver src/prodSync.ts)
```

## Architecture

Monorepo with pnpm workspaces. Two packages:

- **apps/api** — Express 4 + TypeScript (CommonJS). The API server.
- **apps/web** — React 18 + Vite 5 + TypeScript (ESM). SPA frontend.

Data comes from PostgreSQL (`generated_images` table) and DigitalOcean Spaces (S3). The API is read-only — it never writes to the DB. An external n8n flow populates the data.

## Critical conventions

- **API is CommonJS** (`"type": "commonjs"`). Web is ESM (`"type": "module"`). Do not mix import styles.
- **API entry guard**: `index.ts` only calls `app.listen` when `require.main === module`. When imported for tests, it exports `app` + `bootGraph()` without starting a server.
- **Mock mode**: set `DB_MOCK=true` in `apps/api/.env`. Uses `mockData.ts` (30 images) + `test-images/` (10 .webp placeholders). All routes work — DB and S3 are bypassed. This is the default for local dev and tests.
- **File mode catalog sync** (`DB_MOCK=true` + `DB_FILE=data/images.json`): el volcado de la API pública se mantiene al día con `pnpm dump:sync` (incremental, `src/prodSync.ts`) o con el **auto-sync dentro de la API** (`AUTO_SYNC_MS` default `60000`, `src/autoSync.ts` — timer `.unref()`, mutex anti-solapamiento). `index.ts` espera a `syncOnce('boot')` **antes** de `bootGraph()`, así el grafo nace con datos; si falla el vuelco se conserva el archivo anterior, se avisa en logs y se reintenta en 60 s (nunca se cae a imágenes mock). El incremental pagina la API (orden `created_at DESC`) y **corta tras 2 páginas consecutivas 100% conocidas** (~12 req por 1k filas nuevas en vez de ~630). Seguridades que caen a volcado completo: orden remoto no-DESC, `local+nuevas < remoto` (dump parcial), **`remoto < local` (reset/bajas del catálogo)** y `SYNC_FULL_MS` (7d, reconcilia deletes; estado en `data/.sync-state.json`). Tras un full con bajas se recarga el grafo de inmediato (`applyDelta` no elimina nodos). Si el full es por antigüedad, primero persiste el incremental: las filas nuevas quedan servibles aunque el full tarde o falle. Escritura **atómica** (tmp+rename) — `dataSource.getImageRows()` revalida `mtime:size` en cada llamada (hot-reload sin reiniciar). El grafo en modo archivo ya no devuelve `[]` en `fetchDeltaRows`: filtra por watermark en memoria, así las filas nuevas entran en el tick de 60s. Tests: `test/sync.test.ts` (fetchPage inyectable, sin red).
- **Graph engine**: `SEARCH_ENGINE=graph` (default) uses in-memory Graphology. `SEARCH_ENGINE=sql` falls back to PostgreSQL.
  - **Incremental refresh**: every `GRAPH_REFRESH_MS` (default 60000) the store fetches only rows newer than a watermark (keyset on `(created_at, id)`) and applies them in-memory (`applyDelta`). Every `GRAPH_FULL_RELOAD_MS` (default 600000) it does a full rebuild + refetch to reconcile (deltas can't detect deletes/edits).
  - **Precision warning**: `created_at` is read via `to_char(created_at AT TIME ZONE 'UTC', ... .US ...)` to keep microsecond precision. Do NOT round-trip through `new Date().toISOString()`, which truncates to ms and makes the watermark lag (each tick re-fetches the newest row forever). `computeWatermark` preserves strings as-is.
- **Tests require no external services** — they use `mockData.ts` and `test/fixtures/images.ts`. No DB, no S3, no exiftool needed.
- **ExifTool**: optional. `METADATA_EMBED=exiftool` enables metadata embedding in downloads. Config in `apps/api/.ExifTool_config` defines custom XMP namespace `XMP-vorael:*`. If exiftool is missing, degrades silently.
- **Semantic search**: `SEARCH_MODE=lexical` (default) | `semantic` | `hybrid`. Requires Ollama local (default `http://127.0.0.1:11434`, model `EMBED_MODEL` default `bge-m3`, dims 1024) and the `image_embeddings` table (id, embedding real[], model). Index lives in memory (`apps/api/src/embeddings.ts`, `loadSemanticIndex`). **Lifecycle**: `warmSemanticIndex()` precarga el índice en el boot (no-mock, modo ≠ lexical) porque la carga de 53k vectores tarda ~25s — no debe caer sobre el primer request (timeout del cliente). `startSemanticRefresh(GRAPH_FULL_RELOAD_MS)` lo recarga periódicamente para recoger embeddings nuevos sin reiniciar; el timer está `.unref()`. El frontend lee el default en `GET /api/health` (`search.mode`/`search.model`) y puede sobreescribirlo con `?mode=lexical|semantic|hybrid`. Query embedding is cached with LRU. Degrades to lexical if Ollama/table missing. Build embeddings with `pnpm embeddings:build` (resumable, batches of 32). **Precision warning**: the RAM index is Float32Array — do not mutate it in place; `cosine`/`searchSemantic`/`rrfFuse` are pure and tested in `test/embeddings.test.ts`.
- **Metadata match & grouped search**: `scoreSearch` (graph.ts) devuelve `entries` con `percent`, `tier`, `matched`, `queryTerms`, `coverage`, `coreMatched`, `distinctive`, `cohesive`, `terms` y `score`. El % es **cobertura ponderada de metadatos**, no una probabilidad: `percent = round(100 * coberturaIDF * avg(best field weight))`; pesos `tag 1.00`, `tagToken 0.95`, `subject 0.90`, `style/mood/use_case 0.85`, `original_prompt 0.65`, `enhanced_prompt 0.60`. `tokenDf` vive en el snapshot y se recalcula en `finalizeSnapshot`/`applyDelta`; IDF suavizado = `log((N+1)/(df+1))+1`. Los términos de la query se expanden con plural mínimo + sinónimos curados (`src/synonyms.ts`): `sonriendo` encuentra `sonrisa/sonriente`, `oficina` encuentra `escritorio/office`, etc. Tramos: `strong >= SEARCH_TIER_STRONG (80)` (exige todos los términos y cohesión: mismo tag o mismo campo curado; si hay un término distintivo, basta que estén en tags, salvo que un color deba compartir tag con el sustantivo que califica), `possible >= SEARCH_TIER_POSSIBLE (40)`, `loose >= SEARCH_MATCH_FLOOR (10)`; por debajo del piso se descarta. Un match multi-término parcial solo entra si aporta un término **distintivo** (df ≤ `SEARCH_DISTINCTIVE_DF_RATIO` del catálogo, mínimo `SEARCH_DISTINCTIVE_MIN_DF`); los parciales solo-prompt se capean a 39 (loose) y los no cohesivos a 79 (possible). Orden: `percent DESC, coreMatched DESC, metadataScore DESC, semanticScore DESC, created_at DESC, id DESC`. `GET /api/search?grouped=1` devuelve la primera página de cada tramo (`tiers[]` con `label/min/max/count/hasMore/items`), `tier=strong|possible|loose` pagina solo ese tramo, y cada item trae `match` (`percent/tier/matched/queryTerms/coverage/coreMatched/distinctive/cohesive/terms` y `semanticPercent` en modos semánticos). En **hybrid** se une el feed léxico + top-100 semántico y `percent = max(metadata, round(cosine*100))`; en **semantic** puro solo se devuelven hits semánticos (el léxico solo enriquece el %); `SEMANTIC_MIN_SCORE` (default 0.65) se aplica **solo a hybrid**. `rrfFuse` sigue existiendo y testeado, pero la ruta ya no lo usa.
- **Search normalization**: `meaningfulTerms` (stopwords.ts) normaliza minúsculas, quita tildes/diacríticos y separa por cualquier no-alfanumérico; `isStopword` compara contra una copia plegada para que `según/más/está` sigan filtrándose. Los tags se indexan como frase completa (`tagPhrases`) + tokens (`tags`), así funcionan tags multi-palabra, plural mínimo y búsquedas sin tilde.
- **Web graph renderer**: `GraphCanvas.tsx` renders with **vis-network** (vis.js) — the same engine behind Graphify's `graph.html` viewer. Physics is Barnes-Hut (spring + repulsion), triggered by `data` change; the component rebuilds (destroy + recreate) per `data` swap. Node `color` comes from the API by type (graph.ts `NODE_COLORS`); click → highlight neighbors + navigate (image/tag) or callback. Do NOT pass custom shapes — vis-network only handles built-in shapes (`dot`, `box`, etc.).
- **Sub-route `/vorael/`**: hardcoded in 4 places — `vite.config.ts` (base), `main.tsx` (BrowserRouter basename), `deploy/nginx-vorael.conf` (location), `index.html` (favicon href). Changing one without the others breaks the app.

## Verification order

```
cd apps/api && npx tsc --noEmit && npx vitest run
cd apps/web && npx tsc --noEmit
```

Both must pass before committing.

## Test structure

Tests live in `apps/api/test/`:

- `routes.test.ts` — endpoint tests (supertest against Express app)
- `search.test.ts` — search engine behavior
- `match.test.ts` — metadata match %, pesos por campo y tramos 80/40/10
- `graph.test.ts` — graph construction and querying
- `graph-endpoint.test.ts` — GET /api/graph endpoint (incluye subgrafo por `ids`)
- `related.test.ts` — related images via graph similarity
- `tags.test.ts` — tag listing and tag-images endpoint
- `facets.test.ts` — filters and stats endpoints
- `exif.test.ts` — metadata embedding (requires exiftool)
- `metadata.test.ts` — metadata roundtrip (requires exiftool)

202 tests total, all passing (`metadata.test.ts`/`exif.test.ts` cubren el round-trip ExifTool si el binario y `.ExifTool_config` existen; degradan a fallback si no). Run with `pnpm test` from root or `npx vitest run` from `apps/api/`.

## Key files

- `apps/api/src/graph.ts` — Graph engine, GraphStore singleton, exportSnapshot, `computeMetadataMatch`/`scoreSearch`/tramos, IDF/cohesión
- `apps/api/src/synonyms.ts` — expansión curada de sinónimos/plurales para la búsqueda léxica
- `apps/api/src/embeddings.ts` — Semantic index (cosine, searchSemantic, LRU cache; `rrfFuse` queda como utilidad histórica — la ruta actual usa `max(metadata, coseno×100)`)
- `apps/api/src/scripts/embeddings-build.ts` — one-time build of image_embeddings (resumable)
- `apps/api/src/metadata.ts` — ExifTool wrapper (embed + readImageMetadata)
- `apps/api/src/db.ts` — pg pool + mock-aware query()
- `apps/api/src/mockData.ts` — 30 test images with TEST_URL/TEST_KEY helpers
- `apps/api/.ExifTool_config` — Custom XMP namespace definition
- `apps/web/src/pages/Graph.tsx` — Página del grafo (atlas/comunidades); el render real está en `GraphCanvas.tsx` con vis-network
- `apps/web/src/components/features/GraphCanvas.tsx` — render reutilizable con **vis-network** (el motor de graph.html de Graphify: Barnes-Hut + highlight de vecinos); lo usan GraphPage y el subgrafo de Search
- `GET /api/graph?ids=id1,id2,…` — subgrafo inducido por un conjunto de imágenes: nodos imagen + metadatos que comparten **2+ imágenes del set** (los compartidos por 1 sola se filtran, no "unen" nada). El `size` de un metadato = cuántas imágenes del set lo comparten. **Esto también optimiza el render**: una búsqueda de 100 imágenes con ~1070 metadatos crudos baja a ~220 nodos.
- `GET /api/search?graph=1` — devuelve el subgrafo del top-100 del ranking actual en `response.graph`. El frontend lo pide aparte del feed agrupado (solo cuando el usuario abre el toggle "Ver grafo" en Search.tsx), para no arrastrar el grafo en cada request.
- `apps/web/src/components/features/SearchTierSection.tsx` — sección reutilizable de un tramo (label/rango/conteo, `ImageGrid` y "Ver más").
- `apps/web/src/hooks/useImages.ts` — `useSearchTiers(q, mode)`: primera página por tramo + paginación independiente de cada uno.
- `apps/web/src/services/api.ts` — Axios instance + fetchGraph + downloadImage

## Environment

- `apps/api/.env` is **gitignored** and NOT tracked (only `.env.example`/`.env.production.example` are tracked). Never commit real S3/DB passwords.
- `DB_MOCK=true` (default) → uses `mockData.ts` (30 images) + `test-images/` (10 .webp placeholders). No DB, no S3 needed.
- `DB_MOCK=false` → requires a running PostgreSQL. Local dev uses Docker: `sudo docker compose up -d` (port **5433**, user/pass `vorael`/`vorael123`). Schema in `deploy/init.sql`; seed with `pnpm seed:db`.
- `SEARCH_ENGINE=graph` (default) → in-memory Graphology, refreshes every 60s. `SEARCH_ENGINE=sql` → falls back to PostgreSQL queries (search tiering se calcula en JS sobre hasta 5000 candidatos).
- `SEARCH_TIER_STRONG=80`, `SEARCH_TIER_POSSIBLE=40`, `SEARCH_MATCH_FLOOR=10` → límites de los tramos de coincidencia. El floor descarta resultados con % menor. `SEARCH_DISTINCTIVE_DF_RATIO=0.01` + `SEARCH_DISTINCTIVE_MIN_DF=10` definen qué término es lo bastante raro para sostener un match parcial multi-término.
- `apps/api/.env.production.example` shows the template for real credentials.
- `test-images-real/` contains real images downloaded from S3 (for local simulation). These are large (~45MB) and untracked.
- **pnpm en esta máquina (reparado 2026-10-19)**: el standalone viejo de marzo-2025 en `%LOCALAPPDATA%\pnpm\pnpm.exe` estaba roto (auto-descarga de 11.3.0 incompleta) y sombreaba al resto; quedó renombrado a `pnpm.exe.legacy-broken` (reversible). Se reinstaló con el instalador oficial → `pnpm` resuelve a `%PNPM_HOME%\bin\pnpm.cmd` (11.3.0, sin self-switch). Fallback: `C:\Users\Janus\AppData\Roaming\npm\pnpm.cmd` (11.3.0). El store en `%LOCALAPPDATA%\pnpm\store` es intocable (el `node_modules` linkea a él).
