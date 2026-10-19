/**
 * Sync incremental del catálogo público de VORAEL → JSON local (DB_FILE).
 *
 * `dump-prod-api.ts` vuelca TODO el catálogo (~63k filas ≈ 630 peticiones).
 * Este módulo hace lo mismo pero cortando pronto: el listado de la API pública
 * ordena `created_at DESC`, así que las filas nuevas están al frente — basta
 * con leer páginas hasta encontrar `safetyPages` consecutivas 100% conocidas.
 * Traer 1k filas nuevas cuesta ~12 peticiones en vez de ~630.
 *
 * Seguridades (todas degradan a volcado completo):
 *  - `isOrderingDesc` verifica el orden real de cada página y el cruce entre
 *    páginas; si el remoto no ordena DESC, cae a full.
 *  - Si `local + nuevas < total remoto`, el volcado local está incompleto
 *    (parcial o con filas que el remoto ya no tiene) → full, que reconcilia.
 *  - `SYNC_FULL_MS` (default 7 días) fuerza un full periódico de todos modos.
 *
 * Escritura atómica (tmp + rename con reintentos): la API puede estar leyendo
 * el JSON mientras se reemplaza — ver `dataSource.getImageRows`.
 *
 * Usado por `pnpm dump:sync` (CLI, scripts/sync-prod.ts) y por el auto-sync
 * dentro de la API (AUTO_SYNC_MS, ver src/autoSync.ts).
 *
 * A propósito NO importa `./config`: el CLI no debe cargar dotenv ni emitir
 * warnings de env faltantes. Lee sus propios settings de process.env.
 */
import { statSync } from 'fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'fs/promises';
import { dirname, isAbsolute, resolve } from 'path';
import type { ImageRow } from './types';

const DEFAULT_BASE = 'https://n8n.americana.edu.co/vorael';
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_DELAY_MS = 50;
const DEFAULT_SAFETY_PAGES = 2;
const DEFAULT_FULL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Page {
  items: ImageRow[];
  total: number;
  hasMore: boolean;
}

/** Paginador inyectable: los tests lo simulan, producción usa makeFetcher. */
export type PageFetcher = (page: number) => Promise<Page>;

export interface SyncOptions {
  /** Base de la API pública (default: env DUMP_BASE o la de producción). */
  base?: string;
  /** Ruta del JSON local (default: env DUMP_OUT / DB_FILE o data/images.json). */
  out?: string;
  pageSize?: number;
  delayMs?: number;
  /** Páginas 100% conocidas consecutivas para cortar (env SYNC_SAFETY_PAGES). */
  safetyPages?: number;
  /** Vuelco completo aunque no haya señales de que haga falta. */
  full?: boolean;
  /** Fuerza un full si el último fue hace más de esto ms (env SYNC_FULL_MS, 0 = nunca). */
  fullIntervalMs?: number;
  /** Paginador inyectable (tests); producción arma el suyo contra la API. */
  fetchPage?: PageFetcher;
  log?: (msg: string) => void;
}

export interface SyncResult {
  mode: 'incremental' | 'full';
  /** Filas nuevas respecto al volcado local anterior. */
  added: number;
  /** Filas locales que ya no están en el remoto (solo mode='full'). */
  removed: number;
  totalLocal: number;
  totalRemote: number;
  pages: number;
  written: boolean;
  dest: string;
}

// ── Helpers puros (testeados en test/sync.test.ts) ──────────────────────────

function parseTs(row: ImageRow): number {
  const t = Date.parse(String(row.created_at ?? ''));
  return Number.isNaN(t) ? Number.NaN : t;
}

/** Ordena `(created_at DESC, id DESC)` — el mismo orden que espera la API. */
export function sortRowsDesc(rows: ImageRow[]): ImageRow[] {
  return [...rows].sort((a, b) => {
    const ta = parseTs(a);
    const tb = parseTs(b);
    const na = Number.isNaN(ta) ? 0 : ta;
    const nb = Number.isNaN(tb) ? 0 : tb;
    if (na !== nb) return nb - na;
    return String(b.id).localeCompare(String(a.id));
  });
}

/**
 * Une volcado local + filas nuevas (dedupe por id, ganan las existentes) y
 * devuelve el resultado ordenado DESC. `added` = filas realmente nuevas.
 */
export function mergeRows(
  existing: ImageRow[],
  incoming: ImageRow[],
): { rows: ImageRow[]; added: number } {
  const ids = new Set(existing.map((r) => r.id));
  const fresh: ImageRow[] = [];
  for (const r of incoming) {
    if (!ids.has(r.id)) {
      ids.add(r.id);
      fresh.push(r);
    }
  }
  return { rows: sortRowsDesc([...existing, ...fresh]), added: fresh.length };
}

/**
 * ¿Los items están ordenados de más nuevo a más viejo (no-creciente por
 * created_at)? Revisa dentro de la página y el cruce con la última fila de la
 * anterior (`prevLast`). Los timestamps no parseables no emiten juicio.
 * Si el remoto ordena ASC, esto se detecta en la primera página → full.
 */
export function isOrderingDesc(items: ImageRow[], prevLast?: ImageRow): boolean {
  const leq = (a: ImageRow, b: ImageRow): boolean => {
    const ta = parseTs(a);
    const tb = parseTs(b);
    if (Number.isNaN(ta) || Number.isNaN(tb)) return true; // sin juicio
    return ta >= tb;
  };
  if (prevLast && items.length > 0 && !leq(prevLast, items[0])) return false;
  for (let i = 1; i < items.length; i++) {
    if (!leq(items[i - 1], items[i])) return false;
  }
  return true;
}

/** Clasifica una página contra los ids conocidos: nuevas + ¿100% conocida? */
export function classifyPage(
  items: ImageRow[],
  knownIds: ReadonlySet<string>,
): { newRows: ImageRow[]; allKnown: boolean } {
  const newRows = items.filter((r) => !knownIds.has(r.id));
  return { newRows, allKnown: newRows.length === 0 };
}

/**
 * ¿Hay que forzar el volcado completo y por qué?
 *  - 'forced'  → lo pidió quien llamó (DUMP_FULL=true).
 *  - 'missing' → no hay volcado local (primera corrida) o está corrupto.
 *  - 'stale'   → el último full fue hace más de `fullIntervalMs`.
 */
export function decideFullReason(input: {
  requestedFull: boolean;
  fileOk: boolean;
  lastFullAt: number | null;
  fullIntervalMs: number;
  now: number;
}): 'forced' | 'missing' | 'stale' | null {
  if (input.requestedFull) return 'forced';
  if (!input.fileOk) return 'missing';
  if (
    input.fullIntervalMs > 0 &&
    input.lastFullAt !== null &&
    input.now - input.lastFullAt >= input.fullIntervalMs
  ) {
    return 'stale';
  }
  return null;
}

// ── I/O ─────────────────────────────────────────────────────────────────────

/** Resuelve el JSON destino: DUMP_OUT > DB_FILE > data/images.json (rel. a apps/api). */
export function resolveOutPath(out?: string): string {
  const raw =
    (out ?? '').trim() ||
    (process.env.DUMP_OUT ?? '').trim() ||
    (process.env.DB_FILE ?? '').trim() ||
    'data/images.json';
  return isAbsolute(raw) ? raw : resolve(__dirname, '..', raw);
}

async function readLocalRows(
  dest: string,
  log: (msg: string) => void,
): Promise<{ rows: ImageRow[]; ok: boolean }> {
  try {
    const raw = await readFile(dest, 'utf8');
    const parsed = JSON.parse(raw) as ImageRow[];
    if (!Array.isArray(parsed)) throw new Error('no es un array de filas');
    return { rows: parsed, ok: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      log(`[sync] volcado local ilegible (${(err as Error).message}) — se regenera completo`);
    }
    return { rows: [], ok: false };
  }
}

interface SyncState {
  lastFullAt?: number;
  lastSyncAt?: number;
  totalRemote?: number;
}

function statePath(dest: string): string {
  return resolve(dirname(dest), '.sync-state.json');
}

async function readState(dest: string): Promise<SyncState> {
  try {
    return JSON.parse(await readFile(statePath(dest), 'utf8')) as SyncState;
  } catch {
    return {};
  }
}

async function writeState(dest: string, state: SyncState): Promise<void> {
  try {
    await writeFile(statePath(dest), JSON.stringify(state), 'utf8');
  } catch (err) {
    // Estado cosmético: no interrumpe el sync si falla.
    console.warn(`[sync] no se pudo escribir el estado: ${(err as Error).message}`);
  }
}

/** Escritura atómica: tmp + rename con reintentos (Windows: EPERM/EBUSY). */
async function writeAtomic(dest: string, rows: ImageRow[]): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(rows), 'utf8');
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await rename(tmp, dest);
      return;
    } catch (err) {
      lastErr = err;
      await sleep(50 * attempt);
    }
  }
  await unlink(tmp).catch(() => {});
  throw lastErr;
}

/** Último volcado completo conocido: el del state o, si no, el mtime del JSON. */
function lastFullAtMs(state: SyncState, dest: string): number | null {
  if (typeof state.lastFullAt === 'number') return state.lastFullAt;
  try {
    return statSync(dest).mtimeMs;
  } catch {
    return null;
  }
}

// ── Fetch ───────────────────────────────────────────────────────────────────

function makeFetcher(
  base: string,
  pageSize: number,
  log: (msg: string) => void,
): PageFetcher {
  return async (page: number): Promise<Page> => {
    const url = `${base}/api/images?page=${page}&limit=${pageSize}`;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const res = await fetch(url, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as Page;
      } catch (err) {
        if (attempt >= 4) throw err;
        const wait = 500 * attempt;
        log(`[sync] página ${page} falló (${(err as Error).message}); reintento ${attempt}/3 en ${wait}ms`);
        await sleep(wait);
      }
    }
    throw new Error('unreachable');
  };
}

// ── Pasadas ─────────────────────────────────────────────────────────────────

/** Vuelco completo: todas las páginas hasta !hasMore. */
async function runFull(
  fetchPage: PageFetcher,
  delayMs: number,
  log: (msg: string) => void,
): Promise<{ rows: ImageRow[]; total: number; pages: number }> {
  const rows: ImageRow[] = [];
  let page = 1;
  let total = 0;
  let hasMore = true;
  while (hasMore) {
    const data = await fetchPage(page);
    total = data.total;
    rows.push(...data.items);
    // items vacíos con hasMore=true sería un bucle infinito: corta.
    hasMore = data.hasMore && data.items.length > 0;
    if (page === 1 || page % 25 === 0 || !hasMore) {
      log(`[sync] página ${page} — ${rows.length}/${total} filas`);
    }
    page += 1;
    if (hasMore && delayMs > 0) await sleep(delayMs);
  }
  return { rows, total, pages: page - 1 };
}

/**
 * Pasada incremental: lee páginas desde la más nueva hasta encontrar
 * `safetyPages` consecutivas 100% conocidas (o el final del listado).
 * Corta también si el orden remoto no es DESC (`ordered=false` → full).
 */
async function runIncremental(
  fetchPage: PageFetcher,
  delayMs: number,
  safetyPages: number,
  existing: ImageRow[],
  log: (msg: string) => void,
): Promise<{ collected: ImageRow[]; totalRemote: number; pages: number; ordered: boolean }> {
  const knownIds = new Set(existing.map((r) => r.id));
  const collected: ImageRow[] = [];
  let page = 1;
  let consecutiveKnown = 0;
  let totalRemote = 0;
  let prevLast: ImageRow | undefined;
  let ordered = true;

  for (;;) {
    const data = await fetchPage(page);
    totalRemote = data.total;

    if (!isOrderingDesc(data.items, prevLast)) {
      ordered = false;
      log(`[sync] el orden de la API no es DESC (página ${page}) — volcado completo`);
      break;
    }

    const { newRows, allKnown } = classifyPage(data.items, knownIds);
    for (const r of newRows) {
      knownIds.add(r.id);
      collected.push(r);
    }
    if (data.items.length > 0) prevLast = data.items[data.items.length - 1];

    if (!data.hasMore || data.items.length === 0) break;

    consecutiveKnown = allKnown ? consecutiveKnown + 1 : 0;
    if (consecutiveKnown >= safetyPages) {
      log(`[sync] corte temprano en página ${page} (${safetyPages} páginas ya conocidas)`);
      break;
    }
    page += 1;
    if (delayMs > 0) await sleep(delayMs);
  }

  return { collected, totalRemote, pages: page, ordered };
}

// ── Sync ────────────────────────────────────────────────────────────────────

/**
 * Sincroniza el JSON local contra la API pública.
 *
 * Modo incremental (default): agrega las filas nuevas que falten y conserva
 * las existentes; no reescribe el archivo si no hubo cambios.
 * Modo full: reemplaza el volcado por el contenido completo del remoto.
 *
 * Devuelve el resultado; ya loguea el resumen (o usa opts.log para capturarlo).
 */
export async function syncCatalog(opts: SyncOptions = {}): Promise<SyncResult> {
  const started = Date.now();
  const log = opts.log ?? ((m: string) => console.log(m));

  const base = (opts.base ?? process.env.DUMP_BASE ?? DEFAULT_BASE).replace(/\/+$/, '');
  const dest = resolveOutPath(opts.out);
  const pageSize = opts.pageSize ?? Number(process.env.DUMP_PAGE_SIZE || DEFAULT_PAGE_SIZE);
  const delayMs = opts.delayMs ?? Number(process.env.DUMP_DELAY_MS || DEFAULT_DELAY_MS);
  const safetyPages = Math.max(
    1,
    opts.safetyPages ?? Number(process.env.SYNC_SAFETY_PAGES || DEFAULT_SAFETY_PAGES),
  );
  const fullIntervalMs =
    opts.fullIntervalMs ?? Number(process.env.SYNC_FULL_MS || String(DEFAULT_FULL_MS));
  const fetchPage = opts.fetchPage ?? makeFetcher(base, pageSize, log);

  const local = await readLocalRows(dest, log);
  const state = await readState(dest);
  const fullReason = decideFullReason({
    requestedFull: opts.full === true,
    fileOk: local.ok,
    lastFullAt: lastFullAtMs(state, dest),
    fullIntervalMs,
    now: Date.now(),
  });

  let mode: 'incremental' | 'full' = 'incremental';
  let rows: ImageRow[] = local.rows;
  let added = 0;
  let removed = 0;
  let totalRemote = 0;
  let pages = 0;

  let reason: string | null = fullReason;
  if (!reason) {
    const inc = await runIncremental(fetchPage, delayMs, safetyPages, local.rows, log);
    totalRemote = inc.totalRemote;
    pages = inc.pages;
    if (!inc.ordered) {
      reason = 'orden remoto no es DESC';
    } else if (local.rows.length + inc.collected.length < totalRemote) {
      reason = `local ${local.rows.length}+${inc.collected.length} < remoto ${totalRemote} (volcado parcial o deletes)`;
    } else {
      const merged = mergeRows(local.rows, inc.collected);
      added = merged.added;
      rows = merged.rows;
    }
  }

  if (reason) {
    mode = 'full';
    log(`[sync] volcado completo: ${reason}`);
    const full = await runFull(fetchPage, delayMs, log);
    totalRemote = full.total;
    pages = full.pages;
    rows = sortRowsDesc(full.rows);
    const localIds = new Set(local.rows.map((r) => r.id));
    const remoteIds = new Set(rows.map((r) => r.id));
    added = rows.filter((r) => !localIds.has(r.id)).length;
    removed = local.rows.filter((r) => !remoteIds.has(r.id)).length;
    if (rows.length !== totalRemote) {
      log(`[sync] aviso: obtuve ${rows.length} filas pero el remoto reporta total=${totalRemote}`);
    }
  }

  // Escritura solo si algo cambió (evita relecturas del JSON de 100MB en vano).
  const written = !local.ok || added > 0 || removed > 0;
  if (written) {
    await writeAtomic(dest, rows);
  }

  await writeState(dest, {
    lastSyncAt: Date.now(),
    lastFullAt: mode === 'full' ? Date.now() : state.lastFullAt,
    totalRemote,
  });

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const delta = written ? `+${added}${removed > 0 ? ` -${removed}` : ''} filas` : 'sin cambios';
  log(
    `[sync] ${mode} — ${delta} — local ${rows.length} / remoto ${totalRemote} (${pages} páginas, ${secs}s)`,
  );

  return { mode, added, removed, totalLocal: rows.length, totalRemote, pages, written, dest };
}
