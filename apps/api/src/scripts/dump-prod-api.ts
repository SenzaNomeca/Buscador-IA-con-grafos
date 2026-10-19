/**
 * Volcado del catálogo público de VORAEL → JSON local.
 *
 * Lee los metadatos desde la API pública de producción (la misma que consume
 * la web en n8n.americana.edu.co/vorael) y los guarda en un archivo local que
 * el API puede usar como fuente de datos en modo archivo (DB_MOCK=true +
 * DB_FILE). No descarga ninguna imagen: solo metadatos + s3_url pública.
 *
 * Uso:
 *   pnpm dump:prod                       → vuelca todo (~62k filas)
 *   DUMP_MAX=1000 pnpm dump:prod         → subconjunto para pruebas
 *
 * Para mantener el volcado al día sin releer todo el catálogo usa
 * `pnpm dump:sync` (sync incremental con corte temprano — src/prodSync.ts).
 *
 * Opciones por env:
 *   DUMP_BASE     base de la API (default https://n8n.americana.edu.co/vorael)
 *   DUMP_OUT      ruta de salida (default data/images.json)
 *   DUMP_PAGE_SIZE filas por página (default 100)
 *   DUMP_MAX      máximo de filas a guardar (default: todas)
 *   DUMP_DELAY_MS pausa entre páginas (default 50)
 */
import { mkdir, writeFile } from 'fs/promises';
import { dirname, isAbsolute, resolve } from 'path';
import type { ImageRow } from '../types';

const BASE = (process.env.DUMP_BASE || 'https://n8n.americana.edu.co/vorael').replace(/\/$/, '');

function outPath(): string {
  const raw = process.env.DUMP_OUT || 'data/images.json';
  return isAbsolute(raw) ? raw : resolve(__dirname, '../..', raw);
}

const PAGE_SIZE = Number(process.env.DUMP_PAGE_SIZE || '100');
const MAX = process.env.DUMP_MAX ? Number(process.env.DUMP_MAX) : Infinity;
const DELAY_MS = Number(process.env.DUMP_DELAY_MS || '50');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(page: number, attempt = 1): Promise<{ items: ImageRow[]; total: number; hasMore: boolean }> {
  const url = `${BASE}/api/images?page=${page}&limit=${PAGE_SIZE}`;
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { items: ImageRow[]; total: number; hasMore: boolean };
    return data;
  } catch (err) {
    if (attempt >= 4) throw err;
    const wait = 500 * attempt;
    console.warn(`[dump] página ${page} falló (${(err as Error).message}); reintento ${attempt}/3 en ${wait}ms`);
    await sleep(wait);
    return fetchPage(page, attempt + 1);
  }
}

async function main() {
  const dest = outPath();
  console.log(`[dump] origen: ${BASE}/api/images`);
  console.log(`[dump] destino: ${dest}`);

  const all: ImageRow[] = [];
  let page = 1;
  let total = 0;
  let hasMore = true;

  while (hasMore) {
    const data = await fetchPage(page);
    total = data.total;
    all.push(...data.items);
    hasMore = data.hasMore && all.length < MAX;
    if (page === 1 || page % 25 === 0 || !data.hasMore) {
      console.log(`[dump] página ${page} — ${all.length}/${Math.min(total, MAX)} filas`);
    }
    page += 1;
    if (DELAY_MS > 0) await sleep(DELAY_MS);
  }

  const rows = all.slice(0, MAX === Infinity ? all.length : MAX);

  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, JSON.stringify(rows), 'utf8');

  console.log(`[dump] listo — ${rows.length} filas guardadas (total remoto: ${total})`);
}

main().catch((err) => {
  console.error('[dump] falló:', err.message);
  process.exit(1);
});
