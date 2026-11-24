export interface Image {
  id: string;
  s3_key: string;
  s3_url: string;
  original_prompt: string | null;
  enhanced_prompt: string | null;
  tags: string[] | null;
  style: string | null;
  subject: string | null;
  mood: string | null;
  color_palette: string[] | null;
  use_case: string | null;
  filename: string | null;
  created_at: string;
}

export interface PaginatedImages {
  items: Image[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

/** Tramos de coincidencia que devuelve /api/search. */
export type SearchTier = 'strong' | 'possible' | 'loose';

export interface MatchTerm {
  term: string;
  field:
    | 'tag'
    | 'tagToken'
    | 'subject'
    | 'style'
    | 'mood'
    | 'useCase'
    | 'original'
    | 'enhanced';
  weight: number;
}

export interface SearchMatch {
  /** Coincidencia 0-100 (no es una probabilidad). */
  percent: number;
  tier: SearchTier;
  /** Nº de términos de la búsqueda encontrados. */
  matched: number;
  /** Nº total de términos significativos de la búsqueda. */
  queryTerms?: number;
  /** Cobertura IDF 0-1 (útil para depurar; no se muestra como %). */
  coverage?: number;
  /** Términos encontrados en campos curados (tag, sujeto, estilo, mood, uso). */
  coreMatched?: number;
  /** Algún término encontrado es poco frecuente, o hay un tag exacto. */
  distinctive?: boolean;
  /** Todos los términos coinciden en el mismo tag/campo curado. */
  cohesive?: boolean;
  terms: MatchTerm[];
  /** Similitud semántica 0-100 (solo en semantic/hybrid). */
  semanticPercent?: number;
}

/** Item de búsqueda: la imagen + el detalle de coincidencia. */
export interface SearchItem extends Image {
  match: SearchMatch;
}

export interface TierCounts {
  strong: number;
  possible: number;
  loose: number;
}

export interface SearchTierSlice {
  id: SearchTier;
  label: string;
  min: number;
  max: number;
  count: number;
  page: number;
  limit: number;
  hasMore: boolean;
  items: SearchItem[];
}

export interface FilterValue {
  value: string;
  count: number;
}

export interface FiltersResponse {
  styles: FilterValue[];
  moods: FilterValue[];
  useCases: FilterValue[];
}

export interface TagWithCount {
  tag: string;
  count: number;
}

export interface Stats {
  total: number;
  topStyles: FilterValue[];
  topMoods: FilterValue[];
  topTags: FilterValue[];
}

export interface ActiveFilters {
  style?: string;
  mood?: string;
  use_case?: string;
}

/** Formats accepted by GET /api/images/:id/download (see apps/api/src/routes/images.ts). */
export type DownloadFormat = 'webp' | 'png' | 'jpg';
