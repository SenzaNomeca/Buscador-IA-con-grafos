import { useCallback, useEffect, useState } from 'react';
import { fetchGraph, type GraphExport, type GraphMode, type GraphNode } from '@/services/api';
import { GraphCanvas } from '@/components/features/GraphCanvas';
import { GraphInfoPanel } from '@/components/features/GraphInfoPanel';
import { Spinner } from '@/components/ui/Spinner';
import { ErrorState } from '@/components/ui/ErrorState';
import { LayoutGrid, Image as ImageIcon, ArrowLeft } from 'lucide-react';

const ATLAS_LIMIT = 80;
const IMAGES_LIMIT = 300;

export function GraphPage() {
  const [view, setView] = useState<GraphMode>('atlas');
  const [activeCommunity, setActiveCommunity] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nodeCount, setNodeCount] = useState(0);
  const [edgeCount, setEdgeCount] = useState(0);
  const [graphData, setGraphData] = useState<GraphExport | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);

  const loadData = useCallback(async (mode: GraphMode, community: number | null) => {
    setLoading(true);
    setError(null);
    setSelectedNode(null);
    try {
      const data =
        mode === 'atlas'
          ? await fetchGraph({ mode: 'atlas', limit: ATLAS_LIMIT })
          : await fetchGraph({
              mode: 'images',
              limit: IMAGES_LIMIT,
              community: community ?? undefined,
            });
      setGraphData(data);
      setNodeCount(data.nodes.length);
      setEdgeCount(data.edges.length);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData(view, activeCommunity);
  }, [view, activeCommunity, loadData]);

  function showAtlas() {
    setActiveCommunity(null);
    setView('atlas');
  }

  function showCommunity(community: number) {
    setActiveCommunity(community);
    setView('images');
  }

  // Leyenda: solo en atlas, los grupos más grandes (ya vienen ordenados).
  const legend =
    view === 'atlas'
      ? (graphData?.nodes ?? []).filter((n) => n.type === 'community').slice(0, 12)
      : [];

  return (
    <div>
      <header className="mb-6">
        <p className="text-xs uppercase tracking-wider text-ink-faint">Explorar</p>
        <h1 className="mt-1 font-display text-3xl font-bold text-ink">Red de Grafo</h1>
        <p className="mt-1 text-sm text-ink-dim">
          {view === 'atlas'
            ? 'Cada burbuja es un grupo de imágenes parecidas. Click para verlo por dentro.'
            : activeCommunity !== null
              ? 'Imágenes del grupo, unidas por los metadatos que comparten.'
              : 'Muestra de imágenes agrupadas por similitud de metadatos.'}
        </p>
      </header>

      {/* Vista + navegación */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={showAtlas}
          className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
            view === 'atlas' ? 'bg-white/10 text-ink' : 'bg-white/[0.03] text-ink-faint hover:bg-white/5'
          }`}
        >
          <LayoutGrid className="h-3 w-3" />
          Atlas de grupos
        </button>
        <button
          type="button"
          onClick={() => {
            setActiveCommunity(null);
            setView('images');
          }}
          className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
            view === 'images' ? 'bg-white/10 text-ink' : 'bg-white/[0.03] text-ink-faint hover:bg-white/5'
          }`}
        >
          <ImageIcon className="h-3 w-3" />
          Imágenes
        </button>
        {view === 'images' && activeCommunity !== null && (
          <button
            type="button"
            onClick={showAtlas}
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-400/10 px-3 py-1.5 text-xs font-medium text-amber-300 transition-colors hover:bg-amber-400/15"
          >
            <ArrowLeft className="h-3 w-3" />
            Volver al atlas
          </button>
        )}
      </div>

      {/* Leyenda de grupos (solo atlas) */}
      {legend.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {legend.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => showCommunity(c.meta?.community ?? 0)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.03] px-2.5 py-1 text-xs text-ink-dim transition-colors hover:bg-white/5"
              title={`Ver las imágenes del grupo (${c.meta?.size ?? 0})`}
            >
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: c.color }} />
              {c.label}
            </button>
          ))}
        </div>
      )}

      {/* Stats bar */}
      <div className="mb-4 flex items-center gap-4 text-xs text-ink-faint">
        <span>{nodeCount} nodos</span>
        <span>{edgeCount} aristas</span>
      </div>

      {/* Grafo + panel */}
      <div className="flex gap-4" style={{ height: '70vh' }}>
        <div className="relative min-w-0 flex-1 overflow-hidden rounded-2xl border border-white/5 bg-canvas-raised">
          {loading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-canvas/80">
              <Spinner />
            </div>
          )}
          {error && (
            <div className="absolute inset-0 z-10 flex items-center justify-center">
              <ErrorState message={error} onRetry={() => loadData(view, activeCommunity)} />
            </div>
          )}
          {graphData && graphData.nodes.length > 0 && (
            <GraphCanvas data={graphData} height="100%" onNodeClick={setSelectedNode} />
          )}
        </div>
        {selectedNode && (
          <GraphInfoPanel
            node={selectedNode}
            onClose={() => setSelectedNode(null)}
            onViewCommunity={showCommunity}
          />
        )}
      </div>
    </div>
  );
}
