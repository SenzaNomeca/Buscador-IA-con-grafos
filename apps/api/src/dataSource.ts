import { readFileSync, statSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import { config } from './config';
import { MOCK_IMAGES } from './mockData';
import type { ImageRow } from './types';

let cached: ImageRow[] | null = null;
/** Sello del archivo cacheado: `${mtimeMs}:${size}` — para detectar reescrituras. */
let cachedStamp = '';

/**
 * true cuando DB_MOCK=true y DB_FILE apunta a un volcado local del catálogo
 * (scripts/dump-prod-api.ts). En ese caso las filas salen del JSON en disco en
 * vez de mockData.ts o PostgreSQL.
 */
export function usingFileData(): boolean {
  return config.mock && config.dbFile.trim() !== '';
}

function filePath(): string {
  const raw = config.dbFile.trim();
  return isAbsolute(raw) ? raw : resolve(__dirname, '..', raw);
}

/**
 * Filas de generated_images según el modo activo:
 *   - DB_MOCK=true + DB_FILE  → JSON en disco (catálogo real volcado)
 *   - DB_MOCK=true (sin file) → MOCK_IMAGES (30 imágenes de prueba)
 *   - DB_MOCK=false           → no se usa (se consulta PostgreSQL directo)
 * Se cachea en memoria: el grafo igual necesita las filas completas.
 *
 * Hot-reload: en modo archivo se revalida `mtime:size` en cada llamada (un
 * statSync barato) — cuando `pnpm dump:sync` / el auto-sync reescriben el
 * JSON, la API lo recoge sin reiniciar (el grafo lo aplica en su siguiente
 * tick). Se hace stat ANTES de leer: si hay una escritura en medio, el sello
 * queda "viejo" y la próxima llamada relee (una recarga extra, jamás datos
 * viejos servidos como nuevos).
 */
export function getImageRows(): ImageRow[] {
  if (!usingFileData()) return MOCK_IMAGES;
  const path = filePath();

  let stamp: string;
  try {
    const st = statSync(path);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch (err) {
    // Archivo momentáneamente ilegible: conserva lo cacheado si lo hay.
    if (cached) return cached;
    throw err;
  }
  if (cached && stamp === cachedStamp) return cached;

  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as ImageRow[];
  if (!Array.isArray(parsed)) {
    throw new Error(`[dataSource] ${path} no contiene un array de filas`);
  }

  const prev = cached;
  cached = parsed;
  cachedStamp = stamp;
  if (prev) {
    const delta = parsed.length - prev.length;
    console.log(
      `[dataSource] ${parsed.length} filas (Δ${delta >= 0 ? '+' : ''}${delta}) recargadas desde ${path}`,
    );
  } else {
    console.log(`[dataSource] ${parsed.length} filas cargadas desde ${path}`);
  }
  return cached;
}
