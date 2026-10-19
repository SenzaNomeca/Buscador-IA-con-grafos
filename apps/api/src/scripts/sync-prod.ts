/**
 * Sync incremental del catálogo público → JSON local (data/images.json).
 *
 * Uso:
 *   pnpm dump:sync                  → incremental: solo trae las filas nuevas
 *                                      (corta pronto si no hay cambios)
 *   DUMP_FULL=true pnpm dump:sync   → volcado completo con escritura atómica
 *                                      (reconcilia deletes; equivale a dump:prod
 *                                      pero actualiza el estado del sync)
 *
 * Mismos env que dump-prod:
 *   DUMP_BASE, DUMP_OUT, DUMP_PAGE_SIZE, DUMP_DELAY_MS, DUMP_MAX (no aplica).
 * Del sync:
 *   SYNC_SAFETY_PAGES=2   páginas 100% conocidas seguidas para cortar
 *   SYNC_FULL_MS=604800000 (7d) fuerza un full periódico de reconciliación
 *
 * El auto-sync de la API (AUTO_SYNC_MS) usa este mismo núcleo: src/prodSync.ts.
 */
import { syncCatalog } from '../prodSync';

async function main() {
  if (process.env.DUMP_MAX) {
    console.warn('[sync] DUMP_MAX no aplica a sync — para subconjuntos usa pnpm dump:prod');
  }
  const result = await syncCatalog({ full: process.env.DUMP_FULL === 'true' });
  if (!result.written) {
    console.log('[sync] nada que hacer: el volcado local ya está al día');
  }
}

main().catch((err) => {
  console.error('[sync] falló:', (err as Error).message);
  process.exit(1);
});
