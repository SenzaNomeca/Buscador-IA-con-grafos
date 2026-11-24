# VORAEL — Cheatsheet del API

## Ruta rápida

```
vorael/
├── apps/api/src/
│   ├── index.ts              ← Entry point: Express, middleware, rutas
│   ├── config.ts             ← Lee .env, exporta config.*
│   ├── db.ts                 ← Pool PostgreSQL + mock-aware query()
│   ├── s3.ts                 ← Cliente DigitalOcean Spaces (S3)
│   ├── graph.ts              ← Motor de grafos (Graphology, in-memory)
│   ├── metadata.ts           ← ExifTool: embed + readImageMetadata
│   ├── mockData.ts           ← 30 imágenes mock (MOCK_IMAGES)
│   ├── types.ts              ← ImageRow y tipos compartidos
│   ├── routes/
│   │   ├── images.ts         ← /api/images, /api/images/:id, /download, /related
│   │   ├── search.ts         ← /api/search?q=... (match % + tramos)
│   │   ├── tags.ts           ← /api/tags, /api/tags/:tag/images
│   │   ├── filters.ts        ← /api/filters (estilos, moods, usos)
│   │   ├── stats.ts          ← /api/stats (totales y rankings)
│   │   └── graph.ts          ← /api/graph (nodos + aristas, ids/atlas/comunidades)
│   └── scripts/
│       ├── seed-db.ts        ← Carga 30 mock images a PostgreSQL
│       ├── simulate-local.ts ← Descarga de S3 + embed + DB local
│       ├── backfill.ts       ← Reescribe archivos en S3 con metadatos
│       ├── export-portable.ts← Exporta imágenes con metadatos a disco
│       └── scanner.ts        ← Reconstruye grafo desde archivos
```

## Endpoints — tabla rápida

| Ruta | Qué hace | Archivo |
|---|---|---|
| `GET /api/health` | Estado, métricas del grafo y modo de búsqueda | `index.ts` |
| `GET /api/images` | Grid paginado (page, limit, style, mood, use_case) | `routes/images.ts` |
| `GET /api/images/:id` | Detalle de una imagen | `routes/images.ts` |
| `GET /api/images/:id/download` | Descarga (format=webp\|png\|jpg, embed metadatos) | `routes/images.ts` |
| `GET /api/images/:id/related` | Imágenes relacionadas (vecinos compartidos en grafo) | `routes/images.ts` |
| `GET /api/search?q=...` | Match % ponderado + tramos 80/40/10 (`grouped=1`, `tier=`, `graph=1`, `mode=`) | `routes/search.ts` |
| `GET /api/tags` | Todos los tags con conteo | `routes/tags.ts` |
| `GET /api/tags/:tag/images` | Imágenes por tag específico | `routes/tags.ts` |
| `GET /api/filters` | Estilos, moods y usos disponibles | `routes/filters.ts` |
| `GET /api/stats` | Totales, top estilos, top moods, top tags | `routes/stats.ts` |
| `GET /api/graph` | Grafo: `types`, `limit`, `center`, `hops`, `ids`, `mode=atlas\|images`, `community` (vis-network) | `routes/graph.ts` |

## Flujo del motor de búsqueda

```mermaid
flowchart TD
    A[Request] --> B["search.ts<br/>modo lexical/semantic/hybrid"]
    B --> C[graph.ts · scoreSearch]
    C --> D{SEARCH_ENGINE?}
    D -->|graph| E[grafo in-memory Graphology]
    E --> E1["meaningfulTerms: minúsculas, sin tildes, sin stopwords"]
    E1 --> E2["match por campo con plural + sinónimos curados"]
    E2 --> E3["percent = cobertura IDF × calidad ponderada"]
    E3 --> E4["tramos: >=80 strong (cohesión) · >=40 possible · >=10 loose"]
    E4 --> E5["orden: percent, coreMatched, metadataScore, created_at, id"]
    E5 --> E6["grouped=1 → primera página por tramo<br/>tier=… → paginar un tramo"]
    D -->|sql| F[fallback PostgreSQL]
    F --> F1["ILIKE/overlap de tags (cap 5000) → mismo cálculo en JS"]
```

> **Cómo busca**: `percent` mide cuánto de la búsqueda aparece en los metadatos, **no es una probabilidad**. Pesos: tag 1.00, token de tag multi-palabra 0.95, subject 0.90, style/mood/use_case 0.85, prompt original 0.65, prompt mejorado 0.60. `cobertura` pondera por IDF (términos comunes pesan menos) y suma plurales + sinónimos curados (`sonriendo` → `sonrisa/sonriente`); `calidad = promedio del mejor peso por término`. `strong` exige todos los términos y cohesión (mismo tag/campo curado); un parcial multi-término solo entra si aporta un término distintivo. Los parciales solo-prompt se capean a 39 y los no cohesivos a 79, así el % siempre cae dentro de su tramo. En hybrid, `percent = max(metadata, coseno×100)`; en semantic puro solo se muestran hits semánticos. `SEMANTIC_MIN_SCORE` solo filtra hybrid.

## Flujo de descarga con metadatos

```mermaid
flowchart TD
    A["GET /api/images/:id/download?format=webp"] --> B["1. Busca imagen en DB graph store o PostgreSQL"]
    B --> C["2. Baja archivo de S3 o test-images/ en mock mode"]
    C --> D["3. Sharp convierte a formato solicitado"]
    D --> E{"METADATA_EMBED=exiftool?"}
    E -->|si| F["4. ExifTool incrusta metadatos"]
    F --> F1["EXIF: ImageDescription, Artist"]
    F --> F2["IPTC: Keywords tags"]
    F --> F3["XMP: Subject, Title"]
    F --> F4["XMP-vorael: id, style, mood, useCase, palette, fileName, createdAt"]
    E -->|no| G["5. Devuelve binario con Content-Disposition"]
    F1 --> G
    F2 --> G
    F3 --> G
    F4 --> G
```

## Motor de grafos — nodos y aristas

```mermaid
flowchart LR
    I[image] -->|TAGGED_WITH| T[tag]
    I -->|HAS_STYLE| S[style]
    I -->|HAS_MOOD| M[mood]
    I -->|HAS_USECASE| U[useCase]
    I -->|HAS_COLOR| C[color]
    T1[tag] -->|CO_OCCURS_WITH peso=frecuencia| T2[tag]
```

## Modos de operación

| Variable | Valor | Qué pasa |
|---|---|---|
| `DB_MOCK=true` | Mock | 30 imágenes de `mockData.ts`, 10 .webp en `test-images/`. Sin DB, sin S3 |
| `DB_MOCK=false` | Real | PostgreSQL + S3. Requiere Docker o DB real |
| `DB_MOCK=true` + `DB_FILE=data/images.json` | Archivo | Catálogo volcado desde la API pública: 30 imágenes mock solo si no hay `DB_FILE` |
| `AUTO_SYNC_MS=60000` | Auto-sync | Vuelco al arrancar y cada 60 s; si el remoto se encoge, full + recarga del grafo. `0` = apagado |
| `SEARCH_ENGINE=graph` | Grafo | In-memory Graphology, refresh cada 60s |
| `SEARCH_ENGINE=sql` | SQL | Fallback PostgreSQL directo |
| `METADATA_EMBED=exiftool` | Embed | Incrusta EXIF/IPTC/XMP en descargas |
| `METADATA_EMBED=none` | No embed | Sin metadatos en archivos |

## Desarrollo local

```bash
# 1. Postgres Docker (puerto 5433)
sudo docker compose up -d

# 2. Cargar datos mock a PostgreSQL
cd apps/api && pnpm seed:db

# 3. Arrancar API + web
cd ../.. && pnpm dev

# URLs
# Galería:  http://localhost:5173/vorael/
# Grafo:    http://localhost:5173/vorael/graph
# Search:   http://localhost:5173/vorael/search?q=cat
# Tags:     http://localhost:5173/vorael/tags
# Stats:    http://localhost:5173/vorael/stats
```

## Tests

```bash
pnpm test                    # 204 tests (16 archivos)
npx vitest run               # todos (los de ExifTool degradan si falta el binario)
npx vitest run test/routes.test.ts   # un archivo específico
```

## Variables de entorno — las más usadas

| Variable | Defecto | Descripción |
|---|---|---|
| `DB_MOCK` | `false` (`true` en `.env.example`) | Modo mock (sin DB/S3) |
| `DB_FILE` | `''` (`data/images.json` en `.env.example`) | Volcado local del catálogo |
| `AUTO_SYNC_MS` / `AUTO_SYNC_ON_BOOT` | `60000` / `true` | Vuelco al arrancar y cada 60 s (`0` = apagado) |
| `GRAPH_FULL_RELOAD_MS` | `600000` | Rebuild completo del grafo (reconcilia bajas) |
| `SEARCH_ENGINE` | `graph` | Motor: `graph` o `sql` |
| `SEARCH_MODE` | `lexical` | `lexical`, `semantic` o `hybrid` |
| `SEMANTIC_MIN_SCORE` | `0.65` | Filtro de coseno solo en hybrid |
| `SEARCH_TIER_STRONG` | `80` | Piso de “Resultados parecidos” |
| `SEARCH_TIER_POSSIBLE` | `40` | Piso de “Podría encajar” |
| `SEARCH_MATCH_FLOOR` | `10` | Piso de “Podrían ser similares” |
| `METADATA_EMBED` | `none` | `exiftool` o `none` |
| `DB_HOST` / `DB_PORT` | — / `5432` | PostgreSQL. Docker local: `localhost:5433` |
| `S3_ENDPOINT` | — | `https://sfo3.digitaloceanspaces.com` |
| `PORT` | `3001` | Puerto Express |
| `HOST` | `127.0.0.1` | Loopback (no exponer) |
