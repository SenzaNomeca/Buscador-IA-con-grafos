import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  syncCatalog,
  mergeRows,
  sortRowsDesc,
  isOrderingDesc,
  classifyPage,
  decideFullReason,
  resolveOutPath,
} from '../src/prodSync';
import type { Page, SyncOptions } from '../src/prodSync';
import type { ImageRow } from '../src/types';

// ── Fixtures ────────────────────────────────────────────────────────────────

function row(id: string, createdAt: string): ImageRow {
  return {
    id,
    s3_key: `k/${id}`,
    s3_url: `https://x/${id}.webp`,
    original_prompt: null,
    enhanced_prompt: null,
    tags: [],
    style: null,
    subject: null,
    mood: null,
    color_palette: null,
    use_case: null,
    filename: `${id}.webp`,
    created_at: createdAt,
  };
}

/** n filas [img-(start+n-1) … img-start] ordenadas DESC (created_at e id). */
function rowsDesc(n: number, start = 0): ImageRow[] {
  const out: ImageRow[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + i * 60_000).toISOString();
    out.push(row(`img-${String(start + i).padStart(4, '0')}`, ts));
  }
  return out;
}

function paginate(all: ImageRow[], pageSize: number): Page[] {
  const pages: Page[] = [];
  for (let i = 0; i < all.length; i += pageSize) {
    pages.push({
      items: all.slice(i, i + pageSize),
      total: all.length,
      hasMore: i + pageSize < all.length,
    });
  }
  if (pages.length === 0) pages.push({ items: [], total: 0, hasMore: false });
  return pages;
}

function fakeFetcher(all: ImageRow[], pageSize: number): {
  fetchPage: (page: number) => Promise<Page>;
  calls: number[];
} {
  const pages = paginate(all, pageSize);
  const calls: number[] = [];
  const fetchPage = async (page: number): Promise<Page> => {
    calls.push(page);
    return pages[page - 1] ?? { items: [], total: all.length, hasMore: false };
  };
  return { fetchPage, calls };
}

let dir: string;
let dest: string;

function opts(fetchPage: (page: number) => Promise<Page>, extra: Partial<SyncOptions> = {}): SyncOptions {
  return {
    out: dest,
    pageSize: 3,
    delayMs: 0,
    safetyPages: 2,
    fullIntervalMs: 0, // desactiva el "stale" — se prueba aparte en decideFullReason
    fetchPage,
    log: () => {},
    ...extra,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vorael-sync-'));
  dest = join(dir, 'images.json');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

// ── Helpers puros ───────────────────────────────────────────────────────────

describe('sortRowsDesc', () => {
  it('ordena por created_at DESC y desempata por id DESC', () => {
    const a = row('a', '2026-01-01T00:00:00Z');
    const b = row('b', '2026-01-02T00:00:00Z');
    const tie1 = row('aaa', '2026-01-01T00:00:00Z');
    const out = sortRowsDesc([a, tie1, b]);
    expect(out.map((r) => r.id)).toEqual(['b', 'aaa', 'a']);
  });
});

describe('mergeRows', () => {
  it('agrega solo las filas nuevas y las mezcla ordenadas', () => {
    const existing = rowsDesc(3); // [2,1,0]
    const incoming = [row('img-0004', '2026-01-05T00:00:00Z'), row('img-0000', '2026-01-01T00:00:00Z')];
    const { rows, added } = mergeRows(existing, incoming);
    expect(added).toBe(1); // img-0000 ya existía (dedupe)
    expect(rows.map((r) => r.id)).toEqual(['img-0004', 'img-0002', 'img-0001', 'img-0000']);
  });

  it('added=0 cuando todo ya existe', () => {
    const existing = rowsDesc(3);
    const { rows, added } = mergeRows(existing, [...existing]);
    expect(added).toBe(0);
    expect(rows).toHaveLength(3);
  });
});

describe('isOrderingDesc', () => {
  it('acepta DESC y empates de created_at', () => {
    const items = [
      row('b', '2026-01-02T00:00:00Z'),
      row('a', '2026-01-02T00:00:00Z'),
      row('z', '2026-01-01T00:00:00Z'),
    ];
    expect(isOrderingDesc(items)).toBe(true);
  });

  it('rechaza ASC (el fallo clásico que obliga a full)', () => {
    const items = rowsDesc(3).reverse();
    expect(isOrderingDesc(items)).toBe(false);
  });

  it('verifica el cruce entre páginas con prevLast', () => {
    const remote = rowsDesc(6); // [5,4,3,2,1,0]
    // p1 = [5,4] y p2 = [3,2] — continuidad OK
    expect(isOrderingDesc(remote.slice(2, 4), remote[1])).toBe(true);
    // la p1 anterior terminó MÁS VIEJA que donde empieza la actual → fuera de orden
    expect(isOrderingDesc(remote.slice(2, 4), remote[5])).toBe(false);
  });

  it('no emite juicio sobre timestamps no parseables', () => {
    expect(isOrderingDesc([row('x', 'no-date'), row('y', 'tampoco')])).toBe(true);
  });
});

describe('classifyPage', () => {
  it('detecta página 100% conocida vs con filas nuevas', () => {
    const known = new Set(['img-0001']);
    expect(classifyPage([row('img-0001', '2026-01-01T00:00:00Z')], known).allKnown).toBe(true);
    const mix = classifyPage(
      [row('img-0001', '2026-01-02T00:00:00Z'), row('img-0002', '2026-01-01T00:00:00Z')],
      known,
    );
    expect(mix.allKnown).toBe(false);
    expect(mix.newRows.map((r) => r.id)).toEqual(['img-0002']);
  });
});

describe('decideFullReason', () => {
  const base = { requestedFull: false, fileOk: true, lastFullAt: 1_000, fullIntervalMs: 0, now: 2_000 };

  it('forced si lo pidió el llamador', () => {
    expect(decideFullReason({ ...base, requestedFull: true })).toBe('forced');
  });

  it('missing si no hay volcado local', () => {
    expect(decideFullReason({ ...base, fileOk: false })).toBe('missing');
  });

  it('stale si el último full supera el intervalo', () => {
    expect(decideFullReason({ ...base, fullIntervalMs: 500, now: 2_000 })).toBe('stale');
    expect(decideFullReason({ ...base, fullIntervalMs: 5_000, now: 2_000 })).toBeNull();
  });

  it('null en el caso normal (reciente y completo)', () => {
    expect(decideFullReason(base)).toBeNull();
    expect(decideFullReason({ ...base, lastFullAt: null })).toBeNull(); // sin info no fuerza
  });
});

describe('resolveOutPath', () => {
  it('honra DUMP_OUT cuando es absoluto', () => {
    vi.stubEnv('DUMP_OUT', dest);
    vi.stubEnv('DB_FILE', 'otra/ruta.json');
    expect(resolveOutPath()).toBe(dest);
  });

  it('el out explícito gana sobre los env', () => {
    vi.stubEnv('DUMP_OUT', '/otra.json');
    expect(resolveOutPath(dest)).toBe(dest);
  });

  it('relativo se resuelve contra apps/api', () => {
    const p = resolveOutPath(join('data', 'x.json'));
    expect(p.endsWith(join('apps', 'api', 'data', 'x.json'))).toBe(true);
  });
});

// ── syncCatalog ─────────────────────────────────────────────────────────────

describe('syncCatalog (incremental)', () => {
  it('trae solo las filas nuevas y corta temprano por páginas conocidas', async () => {
    const remote = rowsDesc(10); // [9…0]
    await writeFile(dest, JSON.stringify(remote.slice(3))); // local: [6…0]
    const { fetchPage, calls } = fakeFetcher(remote, 3);

    const res = await syncCatalog(opts(fetchPage));

    expect(res.mode).toBe('incremental');
    expect(res.added).toBe(3); // img-0009, img-0008, img-0007
    expect(res.totalRemote).toBe(10);
    expect(res.totalLocal).toBe(10);
    expect(res.written).toBe(true);
    // p1 nueva, p2 conocida, p3 conocida → corta antes de p4 (la 10ª fila)
    expect(calls).toEqual([1, 2, 3]);

    const saved = JSON.parse(await readFile(dest, 'utf8')) as ImageRow[];
    expect(saved).toHaveLength(10);
    expect(saved[0].id).toBe('img-0009');

    const state = JSON.parse(await readFile(join(dir, '.sync-state.json'), 'utf8')) as {
      lastSyncAt?: number;
    };
    expect(typeof state.lastSyncAt).toBe('number');

    const leftovers = (await readdir(dir)).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]); // escritura atómica sin huérfanos
  });

  it('sin cambios no reescribe el archivo', async () => {
    const remote = rowsDesc(6);
    const original = JSON.stringify(remote);
    await writeFile(dest, original);
    const { fetchPage } = fakeFetcher(remote, 3);

    const res = await syncCatalog(opts(fetchPage));

    expect(res.mode).toBe('incremental');
    expect(res.added).toBe(0);
    expect(res.written).toBe(false);
    expect(await readFile(dest, 'utf8')).toBe(original); // intacto
  });

  it('si el orden remoto no es DESC, cae a volcado completo', async () => {
    const asc = rowsDesc(6).reverse(); // remoto viejo→nuevo
    await writeFile(dest, JSON.stringify(rowsDesc(6)));
    const { fetchPage, calls } = fakeFetcher(asc, 3);

    const res = await syncCatalog(opts(fetchPage));

    expect(res.mode).toBe('full');
    expect(res.totalLocal).toBe(6);
    expect(res.added).toBe(0); // mismo contenido, distinto orden
    // p1 incremental (detección) + p1,p2 del full que la rehace
    expect(calls).toEqual([1, 1, 2]);
  });

  it('si el local está incompleto (faltan viejas) lo detecta y hace full', async () => {
    const remote = rowsDesc(8); // [7…0]
    await writeFile(dest, JSON.stringify(remote.slice(0, 6))); // local: [7…2]
    const { fetchPage } = fakeFetcher(remote, 3);

    const res = await syncCatalog(opts(fetchPage));

    // p1 [7,6,5] conocida, p2 [4,3,2] conocida → corte ANTES de [1,0];
    // local(6)+nuevas(0) < remoto(8) → full reconcilia
    expect(res.mode).toBe('full');
    expect(res.totalLocal).toBe(8);
    expect(res.added).toBe(2);
    expect(res.written).toBe(true);
  });
});

describe('syncCatalog (full)', () => {
  it('primera corrida: no hay volcado → vuelca todo y crea el estado', async () => {
    const remote = rowsDesc(4);
    const { fetchPage } = fakeFetcher(remote, 3);

    const res = await syncCatalog(opts(fetchPage));

    expect(res.mode).toBe('full');
    expect(res.added).toBe(4);
    expect(res.written).toBe(true);
    const saved = JSON.parse(await readFile(dest, 'utf8')) as ImageRow[];
    expect(saved).toHaveLength(4);

    const state = JSON.parse(await readFile(join(dir, '.sync-state.json'), 'utf8')) as {
      lastFullAt?: number;
    };
    expect(typeof state.lastFullAt).toBe('number');
  });

  it('repara un volcado corrupto', async () => {
    await writeFile(dest, '{esto no es json');
    const remote = rowsDesc(4);
    const { fetchPage } = fakeFetcher(remote, 3);

    const res = await syncCatalog(opts(fetchPage));

    expect(res.mode).toBe('full');
    expect(res.totalLocal).toBe(4);
    const saved = JSON.parse(await readFile(dest, 'utf8')) as ImageRow[];
    expect(saved).toHaveLength(4);
  });

  it('DUMP_FULL (requestedFull) fuerza el completo aunque todo esté al día', async () => {
    const remote = rowsDesc(6);
    await writeFile(dest, JSON.stringify(remote));
    const { fetchPage, calls } = fakeFetcher(remote, 3);

    const res = await syncCatalog(opts(fetchPage, { full: true }));

    expect(res.mode).toBe('full');
    expect(res.added).toBe(0);
    expect(calls).toEqual([1, 2]); // full igual recorre todo, sin corte temprano
  });
});

// ── Delta del grafo en modo archivo ─────────────────────────────────────────

describe('fetchDeltaRows (modo archivo)', () => {
  it('filtra por watermark en vez de devolver [] cuando DB_MOCK=true + DB_FILE', async () => {
    const rows = rowsDesc(5); // [4,3,2,1,0] DESC
    await writeFile(dest, JSON.stringify(rows));
    vi.stubEnv('DB_MOCK', 'true');
    vi.stubEnv('DB_FILE', dest);

    // Nota: config/dataSource se cachean a nivel de archivo de test — las dos
    // aserciones van juntas contra el mismo volcado.
    const { fetchDeltaRows } = await import('../src/graph');

    // watermark en img-0001 → filas estrictamente mayores en ASC
    const wm = { created_at: rows[3].created_at, id: rows[3].id };
    const delta = await fetchDeltaRows(wm);
    expect(delta.map((r) => r.id)).toEqual(['img-0002', 'img-0003', 'img-0004']);

    // watermark en la más nueva → nada por aplicar (como en Postgres)
    const empty = await fetchDeltaRows({ created_at: rows[0].created_at, id: rows[0].id });
    expect(empty).toEqual([]);
  });
});
