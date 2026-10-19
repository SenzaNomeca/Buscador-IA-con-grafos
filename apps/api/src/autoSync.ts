/**
 * Auto-sync del volcado local (DB_FILE) contra la API pública, dentro del
 * proceso de la API — así el repo "nunca se queda corto" sin tareas del SO.
 *
 * Config (apps/api/.env):
 *   AUTO_SYNC_MS=3600000     # 0 o ausente = apagado; 1h = cada cuánto sync
 *   AUTO_SYNC_ON_BOOT=true   # sincronizar una vez al arrancar (default true)
 *
 * Usa el mismo núcleo que `pnpm dump:sync` (src/prodSync.ts): incremental con
 * corte temprano, escritura atómica y reconciliación full periódica
 * (SYNC_FULL_MS). Los errores solo se loguean — la API sigue sirviendo el
 * volcado actual; el siguiente tick reintenta.
 *
 * El JSON reescrito lo recoge dataSource.getImageRows vía revalidación de
 * mtime, y el grafo lo aplica en el siguiente tick (delta) o full reload.
 */
import { config } from './config';
import { usingFileData } from './dataSource';
import { syncCatalog } from './prodSync';

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

  let running = false;
  const run = async (label: string) => {
    if (running) {
      console.log(`[sync] ${label}: aún corre el sync anterior — se omite este tick`);
      return;
    }
    running = true;
    try {
      await syncCatalog({}); // syncCatalog ya loguea el resumen
    } catch (err) {
      console.warn(
        `[sync] ${label} falló (${(err as Error).message}) — se conserva el volcado actual`,
      );
    } finally {
      running = false;
    }
  };

  if (onBoot) void run('boot');
  const timer = setInterval(() => void run('tick'), ms);
  timer.unref();

  console.log(`[sync] auto-sync cada ${ms}ms (onBoot=${onBoot})`);
  return () => clearInterval(timer);
}
