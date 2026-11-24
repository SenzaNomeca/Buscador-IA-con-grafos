import { useCallback, useEffect, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  fetchHealth,
  fetchImage,
  fetchImages,
  fetchRelated,
  fetchTagImages,
  searchGrouped,
  searchByTier,
  searchImages,
  type ImageListParams,
  type SearchMode,
} from '@/services/api';
import type { ActiveFilters, SearchItem, SearchTier } from '@/types/image';

export function useInfiniteImages(filters: ActiveFilters, limit = 24) {
  return useInfiniteQuery({
    queryKey: ['images', filters, limit],
    queryFn: ({ pageParam }) =>
      fetchImages({ page: pageParam as number, limit, ...filters } satisfies ImageListParams),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
  });
}

export function useImage(id: string) {
  return useQuery({
    queryKey: ['image', id],
    queryFn: () => fetchImage(id),
    enabled: typeof id === 'string' && id.length > 0,
  });
}

export function useRelatedImages(id: string) {
  return useQuery({
    queryKey: ['image', id, 'related'],
    queryFn: () => fetchRelated(id, 8),
    enabled: typeof id === 'string' && id.length > 0,
  });
}

// `mode` undefined = el servidor decide (config SEARCH_MODE). Se incluye en el
// queryKey para que cambiar el toggle re-haga la búsqueda.
export function useInfiniteSearch(q: string, limit = 24, mode?: SearchMode) {
  return useInfiniteQuery({
    queryKey: ['search', q, mode ?? null, limit],
    queryFn: ({ pageParam }) => searchImages({ q, page: pageParam as number, limit, mode }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
    enabled: q.trim().length > 0,
  });
}

/** Config de búsqueda del servidor (modo y modelo por defecto) para inicializar el toggle. */
export function useSearchConfig() {
  return useQuery({
    queryKey: ['health', 'search'],
    queryFn: fetchHealth,
    staleTime: 60_000,
  });
}

export interface SearchTierView {
  id: SearchTier;
  label: string;
  min: number;
  max: number;
  count: number;
  items: SearchItem[];
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
}

function emptyExtraPages(): Record<SearchTier, SearchItem[]> {
  return { strong: [], possible: [], loose: [] };
}

function firstExtraPage(): Record<SearchTier, number> {
  return { strong: 2, possible: 2, loose: 2 };
}

/**
 * Búsqueda agrupada en tres tramos. La primera request trae la primera página
 * de cada tramo; "Ver más" pide solo la página siguiente del tramo elegido.
 */
export function useSearchTiers(q: string, mode?: SearchMode, perTier = 12) {
  const query = useQuery({
    queryKey: ['search', 'grouped', q, mode ?? null, perTier],
    queryFn: () => searchGrouped(q, mode, perTier),
    enabled: q.trim().length > 0,
  });

  const [extra, setExtra] = useState<Record<SearchTier, SearchItem[]>>(emptyExtraPages);
  const [nextPage, setNextPage] = useState<Record<SearchTier, number>>(firstExtraPage);
  const [loadingTier, setLoadingTier] = useState<SearchTier | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Al cambiar la query o el modo, la primera página vuelve a mandar.
  useEffect(() => {
    setExtra(emptyExtraPages());
    setNextPage(firstExtraPage());
    setLoadingTier(null);
    setLoadError(null);
  }, [q, mode]);

  const loadMore = useCallback(
    (tier: SearchTier) => {
      if (loadingTier) return;
      setLoadingTier(tier);
      setLoadError(null);
      searchByTier(q, tier, mode, nextPage[tier], perTier)
        .then((res) => {
          setExtra((prev) => ({ ...prev, [tier]: [...prev[tier], ...res.items] }));
          setNextPage((prev) => ({ ...prev, [tier]: prev[tier] + 1 }));
        })
        .catch((err: unknown) => {
          setLoadError(err instanceof Error ? err.message : 'No se pudieron cargar más resultados');
        })
        .finally(() => setLoadingTier(null));
    },
    [q, mode, nextPage, perTier, loadingTier],
  );

  const tiers: SearchTierView[] = (query.data?.tiers ?? []).map((slice) => {
    const items = [...slice.items, ...extra[slice.id]];
    return {
      id: slice.id,
      label: slice.label,
      min: slice.min,
      max: slice.max,
      count: slice.count,
      items,
      hasMore: items.length < slice.count,
      loadingMore: loadingTier === slice.id,
      loadMore: () => loadMore(slice.id),
    };
  });

  return { ...query, tiers, loadError };
}

export function useInfiniteTagImages(tag: string, limit = 24) {
  return useInfiniteQuery({
    queryKey: ['tag', tag, limit],
    queryFn: ({ pageParam }) => fetchTagImages(tag, pageParam as number, limit),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
    enabled: tag.length > 0,
  });
}
