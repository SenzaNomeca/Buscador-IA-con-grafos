import { ChevronDown, Loader2 } from 'lucide-react';
import { ImageGrid } from './ImageGrid';
import type { SearchTierView } from '@/hooks/useImages';
import { cn } from '@/lib/utils';
import type { SearchTier } from '@/types/image';

const TIER_STYLES: Record<SearchTier, { badge: string; bar: string; hint: string }> = {
  strong: {
    badge: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200',
    bar: 'bg-emerald-400',
    hint: 'Todos los términos coinciden dentro de un mismo tag o campo curado (sujeto, estilo, mood o uso).',
  },
  possible: {
    badge: 'border-amber-400/30 bg-amber-400/10 text-amber-200',
    bar: 'bg-amber-400',
    hint: 'Coinciden en parte de la búsqueda, con al menos un término específico.',
  },
  loose: {
    badge: 'border-sky-400/30 bg-sky-400/10 text-sky-200',
    bar: 'bg-sky-400',
    hint: 'Coincidencia débil o solo por prompt; revisa antes de usarlas.',
  },
};

interface Props {
  tier: SearchTierView;
}

export function SearchTierSection({ tier }: Props) {
  if (tier.count === 0) return null;

  const styles = TIER_STYLES[tier.id];
  const remaining = Math.max(0, tier.count - tier.items.length);

  return (
    <section className="mb-12" aria-labelledby={`tier-${tier.id}`}>
      <header className="mb-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className={cn('h-2.5 w-2.5 rounded-full', styles.bar)} aria-hidden />
          <h2 id={`tier-${tier.id}`} className="font-display text-xl font-semibold text-ink">
            {tier.label}
          </h2>
          <span className={cn('rounded-full border px-2 py-0.5 text-[11px] font-medium', styles.badge)}>
            {tier.min}–{tier.max}%
          </span>
          <span className="text-sm text-ink-dim">
            {tier.count.toLocaleString('es-CO')} {tier.count === 1 ? 'resultado' : 'resultados'}
          </span>
        </div>
        <p className="mt-1 text-sm text-ink-faint">{styles.hint}</p>
      </header>

      <ImageGrid pages={[{ items: tier.items }]} />

      {tier.hasMore && (
        <div className="mt-6 flex justify-center">
          <button
            type="button"
            onClick={tier.loadMore}
            disabled={tier.loadingMore}
            className="btn-ghost min-w-44"
          >
            {tier.loadingMore ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Cargando…
              </>
            ) : (
              <>
                <ChevronDown className="h-4 w-4" aria-hidden />
                Ver más ({remaining.toLocaleString('es-CO')})
              </>
            )}
          </button>
        </div>
      )}
    </section>
  );
}
