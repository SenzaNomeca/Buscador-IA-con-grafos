import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import { ImageIcon, Layers, Sun, Monitor, Tag, X } from 'lucide-react';
import type { GraphNode } from '@/services/api';

interface GraphInfoPanelProps {
  node: GraphNode;
  onClose: () => void;
  /** Solo para nodos de comunidad: abrir el cardumen de imágenes. */
  onViewCommunity?: (communityId: number) => void;
}

function Chip({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-white/[0.06] px-2 py-0.5 text-xs text-ink-dim">
      {icon}
      {children}
    </span>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wider text-ink-faint">{label}</span>
      <span className="text-sm text-ink">{value}</span>
    </div>
  );
}

/** Panel lateral con la información precisa del nodo seleccionado. */
export function GraphInfoPanel({ node, onClose, onViewCommunity }: GraphInfoPanelProps) {
  const isCommunity = node.type === 'community';
  const community = node.meta?.community;

  return (
    <aside className="flex w-72 shrink-0 flex-col gap-4 rounded-2xl border border-white/5 bg-canvas-raised p-4">
      <header className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          {isCommunity ? (
            <Layers className="h-4 w-4 text-ink-dim" />
          ) : (
            <ImageIcon className="h-4 w-4 text-ink-dim" />
          )}
          <h2 className="font-display text-base font-semibold text-ink">
            {isCommunity ? `Grupo ${community ?? ''}` : node.label}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-ink-faint transition-colors hover:bg-white/5 hover:text-ink"
          title="Cerrar"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      {isCommunity ? (
        <>
          <Row label="Imágenes" value={(node.meta?.size ?? 0).toLocaleString('es')} />
          {node.meta?.topTags?.length ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] uppercase tracking-wider text-ink-faint">Tags principales</span>
              <div className="flex flex-wrap gap-1.5">
                {node.meta.topTags.map((tag) => (
                  <Chip key={tag} icon={<Tag className="h-3 w-3" />}>
                    {tag}
                  </Chip>
                ))}
              </div>
            </div>
          ) : null}
          {node.meta?.style && (
            <Row label="Estilo dominante" value={<Chip icon={<Layers className="h-3 w-3" />}>{node.meta.style}</Chip>} />
          )}
          {node.meta?.mood && (
            <Row label="Mood dominante" value={<Chip icon={<Sun className="h-3 w-3" />}>{node.meta.mood}</Chip>} />
          )}
          {node.meta?.useCase && (
            <Row label="Uso dominante" value={<Chip icon={<Monitor className="h-3 w-3" />}>{node.meta.useCase}</Chip>} />
          )}
          {community !== undefined && onViewCommunity && (
            <button
              type="button"
              onClick={() => onViewCommunity(community)}
              className="mt-auto inline-flex items-center justify-center gap-2 rounded-lg bg-white/10 px-3 py-2 text-sm font-medium text-ink transition-colors hover:bg-white/15"
            >
              <ImageIcon className="h-4 w-4" />
              Ver las imágenes del grupo
            </button>
          )}
        </>
      ) : (
        <>
          {node.meta?.topTags?.length ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] uppercase tracking-wider text-ink-faint">Tags</span>
              <div className="flex flex-wrap gap-1.5">
                {node.meta.topTags.map((tag) => (
                  <Chip key={tag} icon={<Tag className="h-3 w-3" />}>
                    {tag}
                  </Chip>
                ))}
              </div>
            </div>
          ) : null}
          {node.meta?.style && (
            <Row label="Estilo" value={<Chip icon={<Layers className="h-3 w-3" />}>{node.meta.style}</Chip>} />
          )}
          {node.meta?.mood && (
            <Row label="Mood" value={<Chip icon={<Sun className="h-3 w-3" />}>{node.meta.mood}</Chip>} />
          )}
          {node.meta?.useCase && (
            <Row label="Uso" value={<Chip icon={<Monitor className="h-3 w-3" />}>{node.meta.useCase}</Chip>} />
          )}
          <Link
            to={`/image/${encodeURIComponent(node.id)}`}
            className="mt-auto inline-flex items-center justify-center gap-2 rounded-lg bg-white/10 px-3 py-2 text-sm font-medium text-ink transition-colors hover:bg-white/15"
          >
            <ImageIcon className="h-4 w-4" />
            Ver imagen
          </Link>
        </>
      )}
    </aside>
  );
}
