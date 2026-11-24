# VORAEL

Banco de imágenes generadas por IA — Corporación Universitaria Americana.

Catálogo web de **solo lectura**: grid con scroll infinito, búsqueda por
coincidencia de metadatos agrupada en tres tramos (80/40/10 %), filtros por
estilo, mood y caso de uso, grafo interactivo y descarga en WebP, PNG o JPG con
metadatos incrustados opcionales.

Producción: **https://n8n.americana.edu.co/vorael/**

> **Empieza aquí:** **[Guía completa de uso y entrega](docs/GUIA_DE_ENTREGA.md)**
> — arranque en 3 comandos sin credenciales, recorrido por la interfaz, API,
> solución de problemas y guion de 5 minutos para clase.

## Cómo está armado

Monorepo pnpm con dos aplicaciones:

| | Stack | Rol |
|---|---|---|
| [`apps/web`](apps/web) | React 18 · Vite 5 · TypeScript · Tailwind · TanStack Query · vis-network | SPA servida como estáticos bajo `/vorael/` |
| [`apps/api`](apps/api) | Express 4 · TypeScript (CommonJS) · `pg` · AWS SDK v3 · `sharp` · Graphology | API REST en `127.0.0.1:3001`, expuesta en `/vorael/api/` |

Servicios externos:

- **PostgreSQL** — tabla `generated_images`, de donde salen los metadatos.
  VORAEL solo lee.
- **DigitalOcean Spaces** (S3, bucket `n8ns3`) — los archivos de imagen. El grid
  los carga directo desde Spaces; las descargas pasan por el API para
  reconvertirlas con `sharp`.
- **n8n** — flujo externo a este repositorio que genera las imágenes y llena la
  base de datos.

Opcionales: **Ollama** + `bge-m3` (búsqueda semántica) y **ExifTool**
(metadatos en descargas). Si faltan, el sistema degrada sin caerse.

## Arranque rápido (sin credenciales)

Requiere Node ≥ 20 y pnpm 11.3.0.

```bash
pnpm install
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
pnpm dev
```

Abrir **http://localhost:5173/vorael/** (con la barra final).

El `.env.example` del API ya trae `DB_MOCK=true` + `DB_FILE=data/images.json`:
no hacen falta PostgreSQL ni claves S3. Al arrancar, el API **descarga el
catálogo público y construye el grafo**; luego sigue sincronizando **cada 60 s**.
Si no hay red, los logs lo avisan y se reintenta solo. Para probar todo lo que
debes ver, sigue la [guía de uso](docs/GUIA_DE_ENTREGA.md).

### Con PostgreSQL local (opcional)

```bash
docker compose up -d              # Postgres en puerto 5433
cd apps/api && pnpm seed:db       # 30 imágenes de prueba
cd ../.. && pnpm dev
```

Para este modo, cambia `DB_MOCK=false` en `apps/api/.env` y completa las
credenciales (`docker-compose.yml` y `.env.example` tienen los valores locales).

## Motor de búsqueda

Grafo en memoria (Graphology) sincronizado con PostgreSQL o con el volcado
local. Cada resultado lleva un **% de coincidencia de metadatos** (no una
probabilidad): pesan más los tags y el sujeto que los prompts, y los términos
raros pesan más que los comunes. Hay tres modos:

| Modo | Cómo funciona |
|---|---|
| `lexical` (default) | Coincidencia por tokens, sin tildes, plurales y sinónimos curados |
| `semantic` | Top-100 por similitud coseno con embeddings `bge-m3` |
| `hybrid` | Une ambas señales: `percent = max(metadatos, coseno × 100)` |

Los resultados se agrupan en **Resultados parecidos** (80-100 %), **Podría
encajar** (40-79 %) y **Podrían ser similares** (10-39 %), con paginación
independiente por tramo. Detalle técnico en
[ARQUITECTURA.md §4.5](ARQUITECTURA.md) y decisiones en
[docs/PLAN_GRAFOS.md](docs/PLAN_GRAFOS.md) (documento histórico).

## Metadatos incrustados

Las descargas pueden llevar metadatos XMP/EXIF/IPTC incrustados (namespace
`XMP-vorael:`), equivalentes al frontmatter YAML de Obsidian. Se activa con
`METADATA_EMBED=exiftool`; si el binario falta, la imagen se entrega igual.
Ver [ARQUITECTURA.md §3](ARQUITECTURA.md).

## Scripts

| Comando | Qué hace |
|---|---|
| `pnpm dev` | API (`:3001`) y web (`:5173`) en paralelo |
| `pnpm dev:api` · `pnpm dev:web` | una sola app |
| `pnpm build` · `pnpm build:api` · `pnpm build:web` | compilar |
| `pnpm typecheck` · `pnpm lint` | verificación estática |
| `pnpm test` · `pnpm test:watch` · `pnpm test:coverage` | 204 pruebas (Vitest) |
| `pnpm dump:prod` · `pnpm dump:sync` | volcado completo / incremental del catálogo |
| `pnpm embeddings:build` | generar vectores semánticos (requiere Ollama) |
| `pnpm seed:generate` | 1000 imágenes sintéticas deterministas para pruebas |
| `pnpm export-portable` | exportar imágenes con metadatos a `export-vorael/` |
| `pnpm backfill` | reescribir archivos en S3 con metadatos (requiere guardia) |
| `pnpm scan` | reconstruir el grafo desde archivos (recovery) |
| `pnpm release` | empaquetar `release/vorael-{web,api}.tar.gz` |

> El monorepo usa `pnpm-lock.yaml`. `apps/api/package-lock.json` se conserva
> solo para el `npm install --omit=dev` del despliegue (ver
> [DEPLOY.md](DEPLOY.md)).

## Documentación

- **[docs/GUIA_DE_ENTREGA.md](docs/GUIA_DE_ENTREGA.md)** — guía completa de
  uso: arranque, interfaz, API, solución de problemas y guion para clase.
- **[MVP.md](MVP.md)** — alcance, casos de uso, requisitos, criterios de
  aceptación, roadmap y glosario.
- **[ARQUITECTURA.md](ARQUITECTURA.md)** — detalle técnico: rutas, esquema,
  variables de entorno, motor de grafos y sub-ruta `/vorael/`.
- **[docs/CHEATSHEET.md](docs/CHEATSHEET.md)** — mapa rápido del código y API.
- **[DEPLOY.md](DEPLOY.md)** — despliegue en el servidor: Nginx, systemd,
  exiftool y verificación.
- **[docs/vorael-slides.html](docs/vorael-slides.html)** — diapositivas
  autocontenidas para presentar.

Los documentos `docs/PLAN_*.md` y `docs/GUIA_EMBEDDINGS.md` son **contexto
histórico** del diseño; el comportamiento vigente está en ARQUITECTURA.md y en
la guía de uso.

## Secretos

Ningún `.env` real está en el repositorio. Solo se versionan `.env.example` y
`.env.production.example`, con los valores sensibles en blanco. El volcado
`apps/api/data/images.json` y las imágenes reales de prueba tampoco se suben.
