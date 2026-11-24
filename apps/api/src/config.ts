import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    console.warn(`[config] Missing env: ${name} (continuing — some endpoints may fail)`);
    return '';
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== '' ? v : fallback;
}

export const config = {
  mock: optional('DB_MOCK', 'false').toLowerCase() === 'true',
  // Fuente alternativa a PostgreSQL: un JSON local con las filas de
  // generated_images (ver scripts/dump-prod-api.ts). Solo se usa con
  // DB_MOCK=true. Ruta relativa a apps/api o absoluta.
  dbFile: optional('DB_FILE', ''),
  db: {
    host: required('DB_HOST'),
    port: Number(optional('DB_PORT', '5432')),
    database: required('DB_NAME'),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
    ssl: optional('DB_SSL', 'false').toLowerCase() === 'true',
  },
  s3: {
    endpoint: required('S3_ENDPOINT'),
    bucket: required('S3_BUCKET'),
    accessKey: required('S3_ACCESS_KEY'),
    secretKey: required('S3_SECRET_KEY'),
    region: optional('S3_REGION', 'us-east-1'),
  },
  server: {
    port: Number(optional('PORT', '3001')),
    host: optional('HOST', '127.0.0.1'),
    corsOrigin: optional('CORS_ORIGIN', '*'),
  },
  graph: {
    refreshMs: Number(optional('GRAPH_REFRESH_MS', '60000')),
    fullReloadMs: Number(optional('GRAPH_FULL_RELOAD_MS', '600000')),
    engine: optional('SEARCH_ENGINE', 'graph') as 'graph' | 'sql',
  },
  semantic: {
    mode: optional('SEARCH_MODE', 'lexical') as 'lexical' | 'semantic' | 'hybrid',
    model: optional('EMBED_MODEL', 'bge-m3'),
    server: optional('EMBED_SERVER', 'http://127.0.0.1:11434'),
    dim: Number(optional('EMBED_DIM', '1024')),
    minScore: Number(optional('SEMANTIC_MIN_SCORE', '0.65')),
  },
  // Tramos de coincidencia de la búsqueda (ver scoreSearch/computeMetadataMatch).
  // El % es cobertura ponderada de metadatos, no una probabilidad.
  search: {
    tierStrong: Number(optional('SEARCH_TIER_STRONG', '80')),
    tierPossible: Number(optional('SEARCH_TIER_POSSIBLE', '40')),
    floor: Number(optional('SEARCH_MATCH_FLOOR', '10')),
    // Un término cuenta como "distintivo" (evidencia fuerte en un match
    // parcial) si aparece en muy pocas imágenes del catálogo. El mínimo evita
    // que corpus pequeños (tests) marquen todo como frecuente.
    distinctiveDfRatio: Number(optional('SEARCH_DISTINCTIVE_DF_RATIO', '0.01')),
    distinctiveMinDf: Number(optional('SEARCH_DISTINCTIVE_MIN_DF', '10')),
  },
  metadata: {
    embed: optional('METADATA_EMBED', 'none') as 'exiftool' | 'none',
  },
  // Auto-sync del volcado local (DB_FILE) contra la API pública — ver src/autoSync.ts.
  // Por defecto se vuelca al arrancar y cada 60 s (el mismo cadencia que el
  // refresh del grafo). ms=0 lo desactiva explícitamente.
  autoSync: {
    ms: Number(optional('AUTO_SYNC_MS', '60000')),
    onBoot: optional('AUTO_SYNC_ON_BOOT', 'true').toLowerCase() !== 'false',
  },
};
