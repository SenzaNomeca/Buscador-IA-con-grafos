import { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useSearchConfig, useSearchTiers } from '@/hooks/useImages';
import { SearchTierSection } from '@/components/features/SearchTierSection';
import { GraphCanvas } from '@/components/features/GraphCanvas';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Spinner } from '@/components/ui/Spinner';
import { AlertTriangle, Network } from 'lucide-react';
import { isSearchMode, searchImages, type SearchMode } from '@/services/api';
import { cn } from '@/lib/utils';

const MODES: Array<{ id: SearchMode; label: string; hint: string }> = [
  { id: 'lexical', label: 'Léxica', hint: 'coincidencia exacta de metadatos' },
  { id: 'semantic', label: 'Semántica', hint: 'similitud por embeddings' },
  { id: 'hybrid', label: 'Híbrida', hint: 'une léxica + semántica; gana el % más alto' },
];

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q')?.trim() ?? '';
  const [showGraph, setShowGraph] = useState(false);

  // Toggle: el param explícito manda; si no viene, usamos el default del
  // servidor (expuesto en /api/health) y caemos a hybrid mientras carga.
  const modeParam = params.get('mode');
  const explicitMode = modeParam && isSearchMode(modeParam) ? modeParam : undefined;
  const { data: health } = useSearchConfig();
  const activeMode = explicitMode ?? health?.search?.mode ?? 'hybrid';

  const {
    data: grouped,
    tiers,
    isLoading,
    error,
    refetch,
    loadError,
  } = useSearchTiers(q, explicitMode);

  // Subgrafo de la búsqueda: se pide aparte (graph=1) cuando el usuario abre
  // el toggle — el feed agrupado no debería arrastrar el grafo en cada request.
  const { data: graphResp, isFetching: graphLoading } = useQuery({
    queryKey: ['search', q, activeMode, 'graph'],
    queryFn: () =>
      searchImages({
        q,
        mode: explicitMode ?? activeMode,
        limit: 100,
        graph: true,
      }),
    enabled: showGraph && q.length > 0,
  });

  const onPickMode = useCallback(
    (mode: SearchMode) => {
      setParams({ q, mode }, { replace: true });
    },
    [setParams, q],
  );

  const toggleGraph = useCallback(() => {
    setShowGraph((v) => !v);
  }, []);

  const total = grouped?.total ?? 0;

  if (!q) {
    return (
      <EmptyState
        title="Escribe algo para buscar"
        description="La barra superior busca en tags, sujeto, estilo, mood, uso y prompts."
      />
    );
  }

  return (
    <div>
      <header className="mb-6">
        <p className="text-xs uppercase tracking-wider text-ink-faint">Búsqueda</p>
        <h1 className="mt-1 font-display text-3xl font-bold text-ink">
          “{q}”
          <span className="ml-3 align-middle text-sm font-normal text-ink-dim">
            {total.toLocaleString('es-CO')} resultados
          </span>
        </h1>

        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs uppercase tracking-wider text-ink-faint">Modo</span>
          {MODES.map((m) => {
            const isActive = activeMode === m.id;
            return (
              <button
                key={m.id}
                type="button"
                title={m.hint}
                onClick={() => onPickMode(m.id)}
                className={cn('chip', isActive && 'chip-active')}
              >
                {m.label}
              </button>
            );
          })}
          <span className="mx-2 h-4 w-px bg-white/10" />
          <button
            type="button"
            onClick={toggleGraph}
            title={showGraph ? 'Volver a los resultados' : 'Ver el grafo de esta búsqueda'}
            className={cn('chip', showGraph && 'chip-active')}
          >
            <Network className="mr-1 h-3.5 w-3.5" aria-hidden />
            {showGraph ? 'Ver resultados' : 'Ver grafo'}
          </button>
        </div>

        <p className="mt-3 text-xs text-ink-faint">
          El porcentaje combina la coincidencia de metadatos con la similitud semántica
          según el modo elegido. No es una probabilidad.
        </p>
      </header>

      {showGraph ? (
        // Subgrafo inducido por el top-100 del ranking actual.
        <div
          className="relative rounded-2xl border border-white/5 bg-canvas-raised overflow-hidden"
          style={{ height: '70vh' }}
        >
          {graphLoading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-canvas/80">
              <Spinner />
            </div>
          )}
          {graphResp?.graph && graphResp.graph.nodes.length > 0 ? (
            <GraphCanvas data={graphResp.graph} height="70vh" />
          ) : (
            !graphLoading && (
              <div className="flex h-full items-center justify-center p-8">
                <EmptyState
                  title="Sin grafo para esta búsqueda"
                  description="Los resultados no comparten metadatos suficientes para armar el subgrafo."
                />
              </div>
            )
          )}
        </div>
      ) : error ? (
        <ErrorState message={(error as Error).message} onRetry={() => refetch()} />
      ) : isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : total === 0 ? (
        <EmptyState
          title="Sin coincidencias"
          description={`No encontramos imágenes para “${q}”. Prueba con términos más generales o cambia el modo.`}
        />
      ) : (
        <>
          {loadError && (
            <div className="mb-6 flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
              <AlertTriangle className="h-4 w-4 shrink-0 text-red-400" aria-hidden />
              <span>{loadError}</span>
            </div>
          )}
          {tiers.map((tier) => (
            <SearchTierSection key={tier.id} tier={tier} />
          ))}
        </>
      )}
    </div>
  );
}
