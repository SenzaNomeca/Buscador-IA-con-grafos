import { motion, type Variants } from 'framer-motion';
import { Download, Eye, Network } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { Image, MatchTerm, SearchMatch, SearchTier } from '@/types/image';

interface Props {
  image: Image;
  /** Index within the current batch/page — used to compute stagger delay. */
  index?: number;
  onDownload?: (image: Image) => void;
  /** Coincidencia de la búsqueda (badge de % + tooltip de campos). */
  match?: SearchMatch;
}

const MATCH_BADGE: Record<SearchTier, string> = {
  strong: 'border-emerald-400/40 bg-emerald-400/15 text-emerald-100',
  possible: 'border-amber-400/40 bg-amber-400/15 text-amber-100',
  loose: 'border-sky-400/40 bg-sky-400/15 text-sky-100',
};

const FIELD_LABELS: Record<MatchTerm['field'], string> = {
  tag: 'tag',
  tagToken: 'tag',
  subject: 'sujeto',
  style: 'estilo',
  mood: 'mood',
  useCase: 'uso',
  original: 'prompt',
  enhanced: 'prompt mejorado',
};

function matchTooltip(match: SearchMatch): string {
  const parts: string[] = [];
  if (match.terms.length > 0) {
    const details = match.terms
      .slice(0, 5)
      .map((t) => `${FIELD_LABELS[t.field]}: ${t.term}`)
      .join(' · ');
    const coverage =
      typeof match.queryTerms === 'number' && match.queryTerms > 1
        ? ` (${match.matched} de ${match.queryTerms} términos)`
        : '';
    parts.push(`Coincide en ${details}${coverage}`);
  }
  if (typeof match.semanticPercent === 'number') {
    parts.push(`Similitud semántica ${match.semanticPercent}%`);
  }
  return parts.join(' · ') || 'Coincidencia semántica';
}

const cardVariants: Variants = {
  hidden: { opacity: 0, y: 12, scale: 0.96 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      duration: 0.35,
      ease: 'easeOut',
      // 0.05s stagger per card, capped so big batches don't have absurd tails.
      delay: Math.min(i * 0.05, 0.6),
    },
  }),
};

export function ImageCard({ image, index = 0, onDownload, match }: Props) {
  const [loaded, setLoaded] = useState(false);
  const navigate = useNavigate();

  function goRelated() {
    navigate(`/image/${image.id}?related=1`);
  }

  return (
    <motion.article
      custom={index}
      variants={cardVariants}
      initial="hidden"
      animate="visible"
      className="group relative overflow-hidden rounded-2xl border border-white/5 bg-canvas-raised shadow-card transition-shadow hover:shadow-glow"
    >
      <Link to={`/image/${image.id}`} className="block">
        <div className="relative aspect-[4/5] w-full overflow-hidden bg-canvas-edge">
          {!loaded && <div className="absolute inset-0 skeleton" />}
          <img
            src={image.s3_url}
            alt={image.subject ?? image.filename ?? `Imagen ${image.id}`}
            loading="lazy"
            decoding="async"
            onLoad={() => setLoaded(true)}
            className={`h-full w-full object-cover transition-all duration-500 group-hover:scale-[1.03] ${
              loaded ? 'opacity-100' : 'opacity-0'
            }`}
          />
          {match && (
            <span
              title={matchTooltip(match)}
              className={cn(
                'absolute left-2 top-2 z-10 rounded-full border px-2 py-0.5 text-[11px] font-semibold backdrop-blur-sm',
                MATCH_BADGE[match.tier],
              )}
            >
              {match.percent}%
            </span>
          )}
          {/* Overlay difuminado sobre la foto al hover */}
          <div className="absolute inset-0 bg-canvas/70 opacity-0 backdrop-blur-[2px] transition-opacity duration-200 group-hover:opacity-100" />
          {/* Botones apilados, centrados encima de la foto */}
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2.5 p-4 opacity-0 transition-opacity duration-200 group-hover:pointer-events-auto group-hover:opacity-100">
            <Link to={`/image/${image.id}`} className="btn-ghost h-9 w-full whitespace-nowrap text-xs">
              <Eye className="h-4 w-4" />
              Ver
            </Link>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                goRelated();
              }}
              className="btn-ghost h-9 w-full whitespace-nowrap text-xs"
              title="Ver relacionadas"
            >
              <Network className="h-4 w-4" />
              Relacionadas
            </button>
            {onDownload && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  onDownload(image);
                }}
                className="btn-primary h-9 w-full whitespace-nowrap text-xs"
              >
                <Download className="h-4 w-4" />
                Descargar
              </button>
            )}
          </div>
        </div>
      </Link>

      <div className="px-4 pb-4 pt-3">
        {image.subject && (
          <h3 className="line-clamp-1 font-display text-sm font-semibold text-ink">
            {image.subject}
          </h3>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {image.style && <span className="chip">{image.style}</span>}
          {image.mood && <span className="chip">{image.mood}</span>}
          {image.tags?.slice(0, 2).map((tag) => (
            <Link key={tag} to={`/tag/${encodeURIComponent(tag)}`} className="chip">
              #{tag}
            </Link>
          ))}
        </div>
      </div>
    </motion.article>
  );
}
