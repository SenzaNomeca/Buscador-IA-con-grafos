/**
 * Auto-sync del volcado local (DB_FILE) contra la API pública, dentro del
 * proceso de la API — así el catálogo se mantiene solo, sin tareas del SO.
 *
 * Config (apps/api/.env):
 *   AUTO_SYNC_MS=60000     # default: vuelca al arrancar y cada 60 s; 0 apaga
 *   AUTO_SYNC_ON_BOOT=true # primer vuelco antes de cargar el grafo (default true)
 *
 * Usa el mismo núcleo que `pnpm dump:sync` (src/prodSync.ts): incremental con
 * corte temprano, escritura atómica y reconciliación full cuando el remoto
 * crece, se encoge (reset/bajas) o cumple SYNC_FULL_MS. Los errores solo se
 * loguean: se conserva el volcado anterior y se reintenta en el próximo tick.
 *
 * El JSON reescrito lo recoge dataSource.getImageRows vía revalidación de
 * mtime, y el grafo lo aplica en el siguiente tick. Cuando el full quitó filas
 * (los deltas no saben borrar) se recarga el grafo aquí mismo.
 */
import { config } from './config';
import { usingFileData } from './dataSource';
import { graphStore, fetchAllRows } from './graph';
import { syncCatalog, type SyncResult } from './prodSync';

let running = false;
let bootSynced = false;

/**
 * Ejecuta un vuelco ahora. Devuelve el resultado, o null si no aplica/falló.
 * `boot` se usa desde index.ts antes de bootGraph para que el primer render
 * ya tenga datos; los ticks sucesivos son `tick` (timer) o `manual`.
 */
export async function syncOnce(label = 'manual'): Promise<SyncResult | null> {
  if (!usingFileData()) {
    console.log('[sync] no hay DB_FILE (modo archivo) — auto-sync desactivado');
    return null;
  }
  if (running) {
    console.log(`[sync] ${label}: aún corre el sync anterior — se omite este tick`);
    return null;
  }

  running = true;
  try {
    const result = await syncCatalog({});
    if (label === 'boot') bootSynced = true;

    // Un full con bajas no se puede aplicar por deltas: recargamos el snapshot
    // completo en caliente para que el reset del catálogo se vea al instante.
    if (result.mode === 'full' && result.removed > 0 && graphStore.ready) {
      try {
        graphStore.load(await fetchAllRows());
        console.log(`[sync] grafo recargado tras ${result.removed} bajas del catálogo`);
      } catch (err) {
        console.warn(`[sync] no se pudo recargar el grafo tras el full: ${(err as Error).message}`);
      }
    }
    return result;
  } catch (err) {
    console.warn(
      `[sync] ${label} falló (${(err as Error).message}) — se conserva el volcado actual; ` +
        `se reintenta en ${config.autoSync.ms}ms`,
    );
    return null;
  } finally {
    running = false;
  }
}

/**
 * Arranca el auto-sync si AUTO_SYNC_MS > 0 y hay DB_FILE.
 * Devuelve un `stop()` para apagarlo (o null si no arrancó).
 * El timer es `.unref()`: no bloquea el cierre del proceso.
 */
export function startAutoSync(): (() => void) | null {
  const { ms, onBoot } = config.autoSync;
  if (ms <= 0) return null;
  if (!usingFileData()) {
    console.log('[sync] AUTO_SYNC_MS>0 pero no hay DB_FILE (modo archivo) — auto-sync desactivado');
    return null;
  }

  if (onBoot && !bootSynced) void syncOnce('boot');
  const timer = setInterval(() => void syncOnce('tick'), ms);
  timer.unref();

  console.log(`[sync] auto-sync cada ${ms}ms (onBoot=${onBoot})`);
  return () => clearInterval(timer);
}
