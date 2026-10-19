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
  metadata: {
    embed: optional('METADATA_EMBED', 'none') as 'exiftool' | 'none',
  },
  // Auto-sync del volcado local (DB_FILE) contra la API pública — ver src/autoSync.ts.
  // ms=0 (default) = apagado. Ej: AUTO_SYNC_MS=3600000 → cada 1h.
  autoSync: {
    ms: Number(optional('AUTO_SYNC_MS', '0')),
    onBoot: optional('AUTO_SYNC_ON_BOOT', 'true').toLowerCase() !== 'false',
  },
};
