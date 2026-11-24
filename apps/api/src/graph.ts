/**
 * Motor de búsqueda por grafos — VORAEL.
 *
 * Carga la tabla `generated_images` en memoria al arrancar, construye un grafo
 * con Graphology y mantiene índices invertidos para búsqueda, recomendaciones y
 * facets (tags, filters, stats).
 *
 * ## Arquitectura
 *
 * - **Grafo** (Graphology): nodos `Image`, `Tag`, `Style`, `Mood`, `UseCase`,
 *   `Color`; aristas no dirigidas entre Image y sus dimensiones; arista
 *   `CO_OCCURS_WITH` entre Tags que comparten imágenes.
 * - **Índices invertidos** (`Map<dim, Set<id>>`): acceso rápido por valor de
 *   dimensión.
 * - **Índice de texto** por imagen (minúsculas, tokenizado): para token-match.
 * - **Lista ordenada**: `(created_at DESC, id DESC)` para paginado determinista.
 *
 * ## Sincronización
 *
 * Se construye completo al arrancar. Un timer periódico (GRAPH_REFRESH_MS) hace un
 * refresh incremental: consulta solo las filas nuevas (watermark keyset sobre
 * `(created_at, id)`) y las aplica mutando las estructuras en sitio (applyDelta).
 * Cada GRAPH_FULL_RELOAD_MS se hace un rebuild completo con el watermark fresco
 * para detectar updates/deletes de filas antiguas. Si una pasada falla, se
 * conserva el último snapshot válido. El applyDelta es síncrono dentro del timer
 * (sin awaits entre la lectura y la escritura), así que las rutas nunca observan
 * un grafo a medias.
 */
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import type { ImageRow } from './types';
import { meaningfulTerms } from './stopwords';
import { COLOR_TERMS, expandTerm } from './synonyms';
import { config } from './config';

// ── Tipos de apoyo ──────────────────────────────────────────────────────────

/** Token normalizado (minúscula, frontera de palabra). */
type Token = string;

/** Resumen de una comunidad (cardumen) detectada por Louvain. */
export interface CommunityInfo {
  id: number;
  /** Nº de imágenes en la comunidad. */
  size: number;
  topTags: { tag: string; count: number }[];
  style: { value: string; count: number } | null;
  mood: { value: string; count: number } | null;
  useCase: { value: string; count: number } | null;
  color: string;
}

/** Arista agregada entre dos comunidades (peso = pares de imágenes que comparten metadatos). */
export interface CommunityEdge {
  a: number;
  b: number;
  weight: number;
}

/** Snapshot inmutable que sirven las rutas. */
export interface GraphSnapshot {
  /** Grafo completo (para traversal de co-ocurrencia). */
  graph: Graph;
  /** Mapa id → fila completa. */
  byId: Map<string, ImageRow>;
  /** Índice invertido por dimensión: `tagIndex.get('cat')` → Set de ids. */
  tagIndex: Map<string, Set<string>>;
  styleIndex: Map<string, Set<string>>;
  moodIndex: Map<string, Set<string>>;
  useCaseIndex: Map<string, Set<string>>;
  colorIndex: Map<string, Set<string>>;
  /** Índice de texto por imagen: tokens precomputados por campo (Sets rápidos). */
  textIndex: Map<string, TextTokens>;
  /** Frecuencia documental por token: en cuántas imágenes aparece (cualquier campo). */
  tokenDf: Map<Token, number>;
  /** Pesos de co-ocurrencia entre tags: `tagA → tagB → weight`. */
  coWeights: Map<string, Map<string, number>>;
  /** Lista global ordenada `created_at DESC, id DESC`. */
  orderedIds: string[];
  /** Nodos ordenados por grado (descendente) — usado por export sin center. */
  topByDegree: string[];
  /** id de imagen → id de comunidad (Louvain). Vacío si se desactivó. */
  imageCommunity: Map<string, number>;
  /** Comunidades ordenadas por tamaño (descendente). */
  communities: CommunityInfo[];
  /** Aristas agregadas entre comunidades. */
  communityEdges: CommunityEdge[];
  /** Estadísticas rápidas. */
  stats: {
    total: number;
    styles: { value: string; count: number }[];
    moods: { value: string; count: number }[];
    tags: { tag: string; count: number }[];
    useCases: { value: string; count: number }[];
  };
  /** Timestamp de construcción. */
  builtAt: Date;
  /** Tiempo de construcción en ms. */
  buildMs: number;
}

// ── Utilidades de tokenización ──────────────────────────────────────────────

/**
 * Normaliza un string: minúsculas, quita acentos ligeros, fragmenta en tokens
 * por separadores no alfanuméricos.
 */
function tokenize(text: string): Token[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Genera variantes de plural mínimo:
 * - "gatos" → ["gato", "gatos"]  (retira 's')
 * - "gato" → ["gato", "gatos"]   (agrega 's')
 * - "categorías" → ["categoria", "categorias"]  (retira 'es' y 's')
 * Solo trabaja con tokens de al menos 3 chars.
 *
 * Cache: scoreSearch recorre ~53k filas y reutiliza los mismos términos de la
 * query; sin cache se generarían millones de Sets/arrays por request.
 */
const pluralCache = new Map<Token, Token[]>();

function pluralVariants(token: Token): Token[] {
  const cached = pluralCache.get(token);
  if (cached) return cached;

  const variants = new Set<Token>([token]);
  if (token.length >= 3) {
    // Retira trailing 's'/'es' (backward: plural → singular)
    if (token.endsWith('s') && !token.endsWith('es')) {
      variants.add(token.slice(0, -1));
    } else if (token.endsWith('es') && token.length > 4) {
      variants.add(token.slice(0, -2));
    }

    // Agrega trailing 's' (forward: singular → plural)
    if (!token.endsWith('s')) {
      variants.add(token + 's');
    }
  }

  const result = [...variants];
  if (pluralCache.size > 5000) pluralCache.clear();
  pluralCache.set(token, result);
  return result;
}

/** Tokens precomputados por imagen/config para search (pesos por campo). */
export interface TextTokens {
  /** Tags completos normalizados (frases con espacios) para match exacto. */
  tagPhrases: Set<Token>;
  /** Tokens individuales de todos los tags (soporta tags multi-palabra). */
  tags: Set<Token>;
  subject: Set<Token>;
  style: Set<Token>;
  mood: Set<Token>;
  useCase: Set<Token>;
  original: Set<Token>;
  enhanced: Set<Token>;
}

/** Normaliza un texto a frase: tokens normalizados unidos por un espacio. */
export function normalizePhrase(text: string): Token {
  return tokenize(text).join(' ');
}

/** Construye los tokens de búsqueda de una fila (sin depender del snapshot). */
export function buildTextTokens(row: ImageRow): TextTokens {
  const tagPhrases = new Set<Token>();
  const tags = new Set<Token>();
  for (const tag of row.tags ?? []) {
    if (!tag || tag.trim() === '') continue;
    const phrase = normalizePhrase(tag);
    if (phrase) tagPhrases.add(phrase);
    for (const token of tokenize(tag)) tags.add(token);
  }
  return {
    tagPhrases,
    tags,
    subject: new Set(row.subject ? tokenize(row.subject) : []),
    style: new Set(row.style ? tokenize(row.style) : []),
    mood: new Set(row.mood ? tokenize(row.mood) : []),
    useCase: new Set(row.use_case ? tokenize(row.use_case) : []),
    original: new Set(row.original_prompt ? tokenize(row.original_prompt) : []),
    enhanced: new Set(row.enhanced_prompt ? tokenize(row.enhanced_prompt) : []),
  };
}

/**
 * Frecuencia documental por token a partir de un índice de texto.
 * Un token cuenta una sola vez por imagen, aunque aparezca en varios campos.
 */
export function buildTokenDf(textTokens: Iterable<TextTokens>): Map<Token, number> {
  const df = new Map<Token, number>();
  const seen = new Set<Token>();

  for (const toks of textTokens) {
    seen.clear();
    for (const set of [
      toks.tags,
      toks.subject,
      toks.style,
      toks.mood,
      toks.useCase,
      toks.original,
      toks.enhanced,
    ]) {
      for (const token of set) seen.add(token);
    }
    for (const token of seen) df.set(token, (df.get(token) ?? 0) + 1);
  }

  return df;
}

/** IDF suavizado: términos frecuentes pesan poco, términos raros pesan más. */
export function idfFromDf(
  df: ReadonlyMap<Token, number> | undefined,
  total: number,
  token: Token,
): number {
  const docs = df?.get(token) ?? 0;
  return Math.log((total + 1) / (docs + 1)) + 1;
}

/** Función IDF lista para pasar a `computeMetadataMatch`. */
export function makeIdf(snap: GraphSnapshot): (token: Token) => number {
  return (token) => idfFromDf(snap.tokenDf, snap.byId.size, token);
}

/**
 * Un término es distintivo cuando aparece en una porción muy pequeña del
 * catálogo. Los matches parciales de una query multi-término solo se muestran
 * si aportan al menos un término distintivo; así "fondo" (muy frecuente) no
 * llena la búsqueda de "fondo blanco", pero "sonrisa" o "abogado" sí pueden
 * sostener un match parcial.
 */
export function makeDistinctiveFromDf(
  df: ReadonlyMap<Token, number> | undefined,
  total: number,
): (token: Token) => boolean {
  const maxDf = Math.max(
    config.search.distinctiveMinDf,
    Math.ceil(total * config.search.distinctiveDfRatio),
  );
  return (token) => {
    // Se mira la familia morfológica (fondo/fondos, gato/gatos): si cualquier
    // forma es frecuente, el concepto no es distintivo.
    let docs = 0;
    for (const variant of pluralVariants(token)) {
      const variantDf = df?.get(variant) ?? 0;
      if (variantDf > docs) docs = variantDf;
    }
    return docs > 0 && docs <= maxDf;
  };
}

export function makeDistinctive(snap: GraphSnapshot): (token: Token) => boolean {
  return makeDistinctiveFromDf(snap.tokenDf, snap.byId.size);
}

/**
 * Variantes de un término: plural mínimo + sinónimos curados. Se cachea porque
 * `scoreSearch` recorre todo el catálogo y reutiliza los mismos términos.
 */
const queryVariantsCache = new Map<Token, Token[]>();

function queryVariants(term: Token): Token[] {
  const cached = queryVariantsCache.get(term);
  if (cached) return cached;

  const variants = new Set<Token>();
  for (const base of expandTerm(term)) {
    for (const variant of pluralVariants(base)) variants.add(variant);
  }
  const result = [...variants];
  if (queryVariantsCache.size > 5000) queryVariantsCache.clear();
  queryVariantsCache.set(term, result);
  return result;
}

/** Primer token de `variants` presente en `reference`, o null. */
function findVariant(variants: Token[], reference: Set<Token>): Token | null {
  for (const variant of variants) {
    if (reference.has(variant)) return variant;
  }
  return null;
}

/**
 * Tokens de una frase de tag, cacheados. La cohesión usa cuántos términos de
 * la query comparten un mismo tag: "fondo-azul" + "mesa-blanca" no debe
 * puntuar como "fondo blanco".
 */
const phraseTokensCache = new Map<Token, Set<Token>>();

function phraseTokens(phrase: Token): Set<Token> {
  const cached = phraseTokensCache.get(phrase);
  if (cached) return cached;
  const tokens = new Set<Token>(phrase.split(' ').filter(Boolean));
  if (phraseTokensCache.size > 50_000) phraseTokensCache.clear();
  phraseTokensCache.set(phrase, tokens);
  return tokens;
}

/**
 * Máximo de términos de la query que aparecen juntos en un mismo tag.
 * Ej.: query de 3 términos con tag "fondo panel blanco" + tag "minimalista"
 * da 2; query de 2 términos con "fondo-azul" + "mesa-blanca" da 1.
 */
function maxTagCoverage(toks: TextTokens, variantsByTerm: Token[][]): number {
  let best = 0;
  for (const phrase of toks.tagPhrases) {
    const tokens = phraseTokens(phrase);
    let count = 0;
    for (const variants of variantsByTerm) {
      if (variants.some((v) => tokens.has(v))) count++;
    }
    if (count > best) best = count;
  }
  return best;
}

/** ¿Los dos términos aparecen juntos en alguna frase de tag? */
function sharesTag(
  toks: TextTokens,
  variantsA: Token[],
  variantsB: Token[],
): boolean {
  for (const phrase of toks.tagPhrases) {
    const tokens = phraseTokens(phrase);
    if (
      variantsA.some((v) => tokens.has(v)) &&
      variantsB.some((v) => tokens.has(v))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Un color debe estar pegado al sustantivo que califica. En español el
 * adjetivo suele ir después, así que se exige que comparta tag con el término
 * anterior no-color ("fondo blanco", "traje azul", "flores rojas"). Sin esto,
 * "fondo" + "rectángulos blancos" + "minimalista" parecería un fondo blanco.
 */
function colorsCohere(
  toks: TextTokens,
  terms: string[],
  variantsByTerm: Token[][],
): boolean {
  for (let i = 0; i < terms.length; i++) {
    if (!COLOR_TERMS.has(terms[i])) continue;

    let neighbor = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (!COLOR_TERMS.has(terms[j])) {
        neighbor = j;
        break;
      }
    }
    if (neighbor === -1) {
      for (let j = i + 1; j < terms.length; j++) {
        if (!COLOR_TERMS.has(terms[j])) {
          neighbor = j;
          break;
        }
      }
    }
    // Query compuesta solo por colores ("blanco y negro"): no hay sustantivo
    // que exigir; la cohesión normal decide.
    if (neighbor === -1) continue;
    if (!sharesTag(toks, variantsByTerm[i], variantsByTerm[neighbor])) return false;
  }
  return true;
}

// ── Coincidencia por metadatos (búsqueda por tramos) ────────────────────────

export type SearchTier = 'strong' | 'possible' | 'loose';

/** Campo donde se encontró un término de la búsqueda. */
export type MatchField =
  | 'tag'
  | 'tagToken'
  | 'subject'
  | 'style'
  | 'mood'
  | 'useCase'
  | 'original'
  | 'enhanced';

export interface MatchTerm {
  term: string;
  field: MatchField;
  /** Peso del campo: 1.00 es la coincidencia más fuerte. */
  weight: number;
}

export interface MatchInfo {
  /** Cobertura ponderada 0-100 (no es una probabilidad). */
  percent: number;
  tier: SearchTier;
  /** Nº de términos significativos encontrados. */
  matched: number;
  /** Nº total de términos significativos de la query. */
  queryTerms: number;
  /** Cobertura IDF 0-1 de los términos encontrados (para depurar/ordenar). */
  coverage: number;
  /** Nº de términos encontrados en campos curados (tag/subject/style/mood/useCase). */
  coreMatched: number;
  /** Algún término encontrado es poco frecuente, o hay un tag exacto. */
  distinctive: boolean;
  /** Evidencia cohesionada (mismo campo/tag, término distintivo o color+sustantivo). */
  cohesive: boolean;
  terms: MatchTerm[];
  /**
   * Similitud semántica 0-100 cuando la respuesta viene de semantic/hybrid.
   * Si supera el % de metadatos, `percent` toma este valor.
   */
  semanticPercent?: number;
}

/**
 * Pesos por campo. El tag es metadata curada y el prompt es texto generado:
 * un match en tag vale más que uno en prompt. Ajustar acá si cambia el criterio.
 */
export const MATCH_FIELD_WEIGHTS: Record<MatchField, number> = {
  tag: 1,
  tagToken: 0.95,
  subject: 0.9,
  style: 0.85,
  mood: 0.85,
  useCase: 0.85,
  original: 0.65,
  enhanced: 0.6,
};

/** Tramo al que pertenece un porcentaje (límites configurables por env). */
export function tierFor(percent: number): SearchTier {
  if (percent >= config.search.tierStrong) return 'strong';
  if (percent >= config.search.tierPossible) return 'possible';
  return 'loose';
}

/** Campos curados: pesan más y son requisito para el tramo strong. */
const CORE_FIELDS: ReadonlySet<MatchField> = new Set([
  'tag',
  'tagToken',
  'subject',
  'style',
  'mood',
  'useCase',
]);

export interface MetadataMatchOptions {
  /** Peso IDF por token; por defecto todos pesan igual (1). */
  idf?: (token: Token) => number;
  /** Define si un token es poco frecuente y sostiene un match parcial. */
  isDistinctive?: (token: Token) => boolean;
}

function metadataTier(percent: number, termCount: number, coreMatched: number): SearchTier {
  if (termCount <= 1) return tierFor(percent);
  // Strong exige que TODOS los términos estén en campos curados. Un prompt
  // puede completar cobertura, pero nunca convertir un resultado en strong.
  if (percent >= config.search.tierStrong && coreMatched === termCount) return 'strong';
  if (percent >= config.search.tierPossible) return 'possible';
  return 'loose';
}

/**
 * Calcula la coincidencia de una imagen contra los términos de la búsqueda.
 *
 * `percent = cobertura * calidad`, donde:
 * - cobertura = IDF de los términos encontrados / IDF de todos los términos
 * - calidad   = promedio del peso del mejor campo de cada término encontrado
 *
 * El IDF evita que términos genéricos ("fondo", "persona") "completen" una
 * query multi-término con poco esfuerzo. La cobertura se calcula sobre evidencia
 * real (incluye sinónimos/plurales), no sobre el número de tokens de la query.
 *
 * Es una medida explicable de "cuánto de lo buscado aparece en los metadatos",
 * no una probabilidad. Los tags con tilde/mayúscula y los multi-palabra se
 * comparan ya normalizados.
 */
export function computeMetadataMatch(
  toks: TextTokens,
  terms: string[],
  queryPhrase: string = terms.join(' '),
  opts: MetadataMatchOptions = {},
): MatchInfo {
  if (terms.length === 0) {
    return {
      percent: 0,
      tier: 'loose',
      matched: 0,
      queryTerms: 0,
      coverage: 0,
      coreMatched: 0,
      distinctive: false,
      cohesive: false,
      terms: [],
    };
  }

  const idf = opts.idf ?? (() => 1);
  const isDistinctive = opts.isDistinctive ?? (() => false);
  const exactTagPhrase = queryPhrase !== '' && toks.tagPhrases.has(queryPhrase);
  const totalIdf = terms.reduce((sum, term) => sum + idf(term), 0);
  const variantsByTerm = terms.map(queryVariants);

  let qualitySum = 0;
  let matchedIdf = 0;
  let matched = 0;
  let coreMatched = 0;
  let distinctive = exactTagPhrase;
  const matchedTerms: MatchTerm[] = [];

  for (let i = 0; i < terms.length; i++) {
    const term = terms[i];
    const variants = variantsByTerm[i];
    let bestWeight = 0;
    let bestField: MatchField | null = null;
    let bestToken: Token | null = null;

    const consider = (field: MatchField, weight: number, token: Token): void => {
      if (weight > bestWeight) {
        bestWeight = weight;
        bestField = field;
        bestToken = token;
      }
    };

    // Tags: frase exacta > tag de una palabra > token dentro de tag multi-palabra.
    if (exactTagPhrase) {
      const tagToken = findVariant(variants, toks.tags);
      if (tagToken) consider('tag', MATCH_FIELD_WEIGHTS.tag, tagToken);
    } else {
      const phraseToken = findVariant(variants, toks.tagPhrases);
      if (phraseToken) {
        consider('tag', MATCH_FIELD_WEIGHTS.tag, phraseToken);
      } else {
        const tagToken = findVariant(variants, toks.tags);
        if (tagToken) consider('tagToken', MATCH_FIELD_WEIGHTS.tagToken, tagToken);
      }
    }

    // Los campos están en orden de peso: si un término ya matcheó en tag
    // (1.00/0.95), los campos inferiores no pueden mejorar el resultado.
    if (bestWeight < MATCH_FIELD_WEIGHTS.subject) {
      const subjectToken = findVariant(variants, toks.subject);
      if (subjectToken) consider('subject', MATCH_FIELD_WEIGHTS.subject, subjectToken);
    }
    if (bestWeight < MATCH_FIELD_WEIGHTS.style) {
      const styleToken = findVariant(variants, toks.style);
      if (styleToken) consider('style', MATCH_FIELD_WEIGHTS.style, styleToken);
      const moodToken = findVariant(variants, toks.mood);
      if (moodToken) consider('mood', MATCH_FIELD_WEIGHTS.mood, moodToken);
      const useCaseToken = findVariant(variants, toks.useCase);
      if (useCaseToken) consider('useCase', MATCH_FIELD_WEIGHTS.useCase, useCaseToken);
    }
    if (bestWeight < MATCH_FIELD_WEIGHTS.original) {
      const originalToken = findVariant(variants, toks.original);
      if (originalToken) consider('original', MATCH_FIELD_WEIGHTS.original, originalToken);
    }
    if (bestWeight < MATCH_FIELD_WEIGHTS.enhanced) {
      const enhancedToken = findVariant(variants, toks.enhanced);
      if (enhancedToken) consider('enhanced', MATCH_FIELD_WEIGHTS.enhanced, enhancedToken);
    }

    if (bestField !== null && bestToken !== null) {
      matched++;
      qualitySum += bestWeight;
      // La cobertura pondera el término de la QUERY, no la variante que lo
      // encontró: así "gato" → tag "gatos" no se penaliza como término ausente,
      // y un sinónimo ("sonriendo" → "sonrisa") cuenta como el término pedido.
      matchedIdf += idf(term);
      if (CORE_FIELDS.has(bestField)) coreMatched++;
      // La rareza se mide sobre el término de la query, no sobre la variante
      // morfológica encontrada: "fondo" no se vuelve específico porque el tag
      // diga "fondos".
      if (isDistinctive(term)) distinctive = true;
      matchedTerms.push({ term, field: bestField, weight: bestWeight });
    }
  }

  if (matched === 0) {
    return {
      percent: 0,
      tier: 'loose',
      matched: 0,
      queryTerms: terms.length,
      coverage: 0,
      coreMatched: 0,
      distinctive: false,
      cohesive: false,
      terms: [],
    };
  }

  const coverage = totalIdf > 0 ? Math.min(1, matchedIdf / totalIdf) : 0;
  const quality = qualitySum / matched;
  let percent = Math.round(100 * coverage * quality);

  // Cohesión: para ser "strong", los términos deben aparecer juntos en un mismo
  // tag o en un mismo campo curado. Coincidir por separado en tags distintos
  // ("fondo-azul" + "mesa-blanca") no es lo mismo que "fondo blanco".
  const allTermsInTags = variantsByTerm.every(
    (variants) => findVariant(variants, toks.tags) !== null,
  );
  const tagCoverage =
    matched === terms.length && terms.length > 1 ? maxTagCoverage(toks, variantsByTerm) : 0;
  const cohesive =
    matched === terms.length &&
    (terms.length <= 1 ||
      exactTagPhrase ||
      [toks.subject, toks.style, toks.mood, toks.useCase].some((field) =>
        variantsByTerm.every((variants) => findVariant(variants, field) !== null),
      ) ||
      // Si hay un término específico, que todos estén en tags (aunque sean
      // tags distintos) es evidencia suficiente. Con solo términos genéricos
      // exigimos que casi todos compartan un mismo tag: "fondo-azul" +
      // "mesa-blanca" (cobertura 1/2) no pasa, pero "fondo panel blanco" +
      // "minimalista" (cobertura 2/3) sí. Los colores, además, deben compartir
      // tag con el sustantivo que califican.
      (allTermsInTags &&
        colorsCohere(toks, terms, variantsByTerm) &&
        (distinctive || tagCoverage >= Math.max(2, terms.length - 1))));

  // El % y el tramo deben ser coherentes con las reglas de evidencia:
  // - prompt-only multi-término no puede ser "possible" (se queda en loose);
  // - si falta algún término curado o no hay cohesión, no puede ser "strong".
  if (terms.length > 1) {
    if (coreMatched === 0) {
      percent = Math.min(percent, config.search.tierPossible - 1);
    } else if (coreMatched < terms.length || !cohesive) {
      percent = Math.min(percent, config.search.tierStrong - 1);
    }
  }

  return {
    percent,
    tier: metadataTier(percent, terms.length, coreMatched),
    matched,
    queryTerms: terms.length,
    coverage,
    coreMatched,
    distinctive,
    cohesive,
    terms: matchedTerms,
  };
}

/**
 * Un match multi-término parcial solo entra si aporta un término distintivo.
 * Los matches completos (todos los términos) y las queries de un término pasan
 * siempre el filtro; el piso de `percent` se valida aparte.
 */
export function passesMetadataFilter(match: MatchInfo): boolean {
  return match.queryTerms <= 1 || match.matched >= match.queryTerms || match.distinctive;
}

// ── Construcción del grafo ──────────────────────────────────────────────────

/** Prefijos para las keys de nodos de metadatos (evita colisiones con ids). */
const TAG = 'tag:';
const STYLE = 'style:';
const MOOD = 'mood:';
const USE_CASE = 'ucase:';
const COLOR = 'color:';

/**
 * Construye un snapshot completo a partir de filas de la BD.
 * Función pura — sin I/O. Se puede testear sin Postgres.
 */
export function buildGraph(rows: ImageRow[]): GraphSnapshot {
  const t0 = Date.now();
  const builder: SnapshotBuilder = {
    graph: new Graph({ type: 'undirected' }),
    byId: new Map(),
    tagIndex: new Map(),
    styleIndex: new Map(),
    moodIndex: new Map(),
    useCaseIndex: new Map(),
    colorIndex: new Map(),
    textIndex: new Map(),
    coWeights: new Map(),
  };

  for (const row of rows) {
    addRowToBuilder(builder, row);
  }

  // Aristas de co-ocurrencia entre tags.
  rebuildCoOccurrenceEdges(builder);

  const snap = finalizeSnapshot(builder, t0);
  attachCommunities(snap);
  return snap;
}

// ── Comunidades (Louvain) ───────────────────────────────────────────────────

/** Paleta cíclica para pintar comunidades. */
const COMMUNITY_COLORS = [
  '#6366f1', '#f59e0b', '#22c55e', '#a855f7', '#06b6d4', '#ef4444',
  '#ec4899', '#14b8a6', '#f97316', '#8b5cf6', '#84cc16', '#0ea5e9',
  '#d946ef', '#eab308', '#10b981', '#f43f5e',
];

/** RNG determinista (mulberry32) para que Louvain dé el mismo resultado siempre. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** ¿La key corresponde a un nodo de metadato (no imagen)? */
function isMetadataKey(key: string): boolean {
  return (
    key.startsWith(TAG) ||
    key.startsWith(STYLE) ||
    key.startsWith(MOOD) ||
    key.startsWith(USE_CASE) ||
    key.startsWith(COLOR)
  );
}

/** Top-N entradas de un contador, ordenadas por frecuencia. */
function topEntries(map: Map<string, number>, n: number): { value: string; count: number }[] {
  return [...map.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, n);
}

/**
 * Detecta comunidades con Louvain sobre el grafo imagen+metadatos y agrega los
 * resúmenes (tamaño, top tags, estilo/mood dominante) más las aristas entre
 * comunidades. Muta el snapshot. Desactivable con GRAPH_COMMUNITIES=false.
 */
function attachCommunities(snap: GraphSnapshot): void {
  if (process.env.GRAPH_COMMUNITIES === 'false' || snap.graph.order === 0) return;

  const t0 = Date.now();
  let mapping: Record<string, number>;
  try {
    mapping = louvain(snap.graph, { resolution: 1, rng: makeRng(42) }) as Record<string, number>;
  } catch (err) {
    console.error('[graph] louvain failed:', err);
    return;
  }

  const agg = new Map<
    number,
    {
      size: number;
      tags: Map<string, number>;
      style: Map<string, number>;
      mood: Map<string, number>;
      useCase: Map<string, number>;
    }
  >();

  for (const [id, row] of snap.byId) {
    const c = mapping[id];
    if (c === undefined) continue;
    snap.imageCommunity.set(id, c);
    let a = agg.get(c);
    if (!a) {
      a = { size: 0, tags: new Map(), style: new Map(), mood: new Map(), useCase: new Map() };
      agg.set(c, a);
    }
    a.size++;
    if (row.tags) for (const t of row.tags) if (t) a.tags.set(t, (a.tags.get(t) ?? 0) + 1);
    if (row.style) a.style.set(row.style, (a.style.get(row.style) ?? 0) + 1);
    if (row.mood) a.mood.set(row.mood, (a.mood.get(row.mood) ?? 0) + 1);
    if (row.use_case) a.useCase.set(row.use_case, (a.useCase.get(row.use_case) ?? 0) + 1);
  }

  snap.communities = [...agg.entries()]
    .map(([id, a]) => {
      const style = topEntries(a.style, 1)[0] ?? null;
      const mood = topEntries(a.mood, 1)[0] ?? null;
      const useCase = topEntries(a.useCase, 1)[0] ?? null;
      return {
        id,
        size: a.size,
        topTags: topEntries(a.tags, 6).map((e) => ({ tag: e.value, count: e.count })),
        style,
        mood,
        useCase,
        color: COMMUNITY_COLORS[id % COMMUNITY_COLORS.length],
      } satisfies CommunityInfo;
    })
    .sort((x, y) => y.size - x.size || x.id - y.id);

  // Aristas entre comunidades: por cada metadato, cuántas imágenes de cada
  // comunidad lo comparten; cada par (A,B) aporta |A|·|B| pares de imágenes.
  const edgeWeights = new Map<string, number>();
  for (const mkey of snap.graph.nodes()) {
    if (!isMetadataKey(mkey)) continue;
    const counts = new Map<number, number>();
    snap.graph.forEachNeighbor(mkey, (nbr) => {
      const c = snap.imageCommunity.get(nbr);
      if (c !== undefined) counts.set(c, (counts.get(c) ?? 0) + 1);
    });
    if (counts.size < 2) continue;
    const entries = [...counts.entries()];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const [ca, na] = entries[i];
        const [cb, nb] = entries[j];
        const a = ca < cb ? ca : cb;
        const b = ca < cb ? cb : ca;
        const key = `${a}:${b}`;
        edgeWeights.set(key, (edgeWeights.get(key) ?? 0) + na * nb);
      }
    }
  }
  snap.communityEdges = [...edgeWeights.entries()]
    .map(([key, weight]) => {
      const [a, b] = key.split(':').map(Number);
      return { a, b, weight };
    })
    .sort((x, y) => y.weight - x.weight);

  console.log(
    `[graph] louvain: ${snap.communities.length} communities in ${Date.now() - t0}ms`,
  );
}

// ── Construcción incremental (compartida por buildGraph y applyDelta) ───────

/**
 * Estructuras mutables que se llenan fila a fila. Es la parte "viva" del
 * snapshot; las derivadas (orderedIds, topByDegree, stats) se recalculan con
 * finalizeSnapshot. GraphSnapshot es este builder + las derivadas.
 */
interface SnapshotBuilder {
  graph: Graph;
  byId: Map<string, ImageRow>;
  tagIndex: Map<string, Set<string>>;
  styleIndex: Map<string, Set<string>>;
  moodIndex: Map<string, Set<string>>;
  useCaseIndex: Map<string, Set<string>>;
  colorIndex: Map<string, Set<string>>;
  textIndex: Map<string, TextTokens>;
  coWeights: Map<string, Map<string, number>>;
}

/** Aplica una fila a las estructuras mutables (nodo, índices, co-ocurrencias). */
function addRowToBuilder(b: SnapshotBuilder, row: ImageRow): void {
  b.byId.set(row.id, row);

  // Nodo Image.
  b.graph.addNode(row.id, { type: 'Image' });

  // Tags.
  if (row.tags) {
    for (const tag of row.tags) {
      if (!tag || tag === '') continue;
      const key = TAG + tag;

      // Nodo Tag.
      if (!b.graph.hasNode(key)) b.graph.addNode(key, { type: 'Tag', name: tag });
      b.graph.mergeUndirectedEdge(row.id, key, { type: 'TAGGED_WITH' });

      // Índice.
      let set = b.tagIndex.get(tag);
      if (!set) { set = new Set(); b.tagIndex.set(tag, set); }
      set.add(row.id);
    }

    // Co-ocurrencia.
    for (let i = 0; i < row.tags.length; i++) {
      for (let j = i + 1; j < row.tags.length; j++) {
        const tagA = row.tags[i];
        const tagB = row.tags[j];
        if (!tagA || !tagB || tagA === '' || tagB === '') continue;
        let mapA = b.coWeights.get(tagA);
        if (!mapA) { mapA = new Map(); b.coWeights.set(tagA, mapA); }
        mapA.set(tagB, (mapA.get(tagB) ?? 0) + 1);
        let mapB = b.coWeights.get(tagB);
        if (!mapB) { mapB = new Map(); b.coWeights.set(tagB, mapB); }
        mapB.set(tagA, (mapB.get(tagA) ?? 0) + 1);
      }
    }
  }

  // Style.
  if (row.style) {
    const key = STYLE + row.style;
    if (!b.graph.hasNode(key)) b.graph.addNode(key, { type: 'Style', name: row.style });
    b.graph.mergeUndirectedEdge(row.id, key, { type: 'HAS_STYLE' });
    let set = b.styleIndex.get(row.style);
    if (!set) { set = new Set(); b.styleIndex.set(row.style, set); }
    set.add(row.id);
  }

  // Mood.
  if (row.mood) {
    const key = MOOD + row.mood;
    if (!b.graph.hasNode(key)) b.graph.addNode(key, { type: 'Mood', name: row.mood });
    b.graph.mergeUndirectedEdge(row.id, key, { type: 'HAS_MOOD' });
    let set = b.moodIndex.get(row.mood);
    if (!set) { set = new Set(); b.moodIndex.set(row.mood, set); }
    set.add(row.id);
  }

  // Use case.
  if (row.use_case) {
    const key = USE_CASE + row.use_case;
    if (!b.graph.hasNode(key)) b.graph.addNode(key, { type: 'UseCase', name: row.use_case });
    b.graph.mergeUndirectedEdge(row.id, key, { type: 'FOR_USE_CASE' });
    let set = b.useCaseIndex.get(row.use_case);
    if (!set) { set = new Set(); b.useCaseIndex.set(row.use_case, set); }
    set.add(row.id);
  }

  // Colors (paleta completa).
  if (row.color_palette) {
    for (const hex of row.color_palette) {
      if (!hex || hex === '') continue;
      const key = COLOR + hex;
      if (!b.graph.hasNode(key)) b.graph.addNode(key, { type: 'Color', hex });
      b.graph.mergeUndirectedEdge(row.id, key, { type: 'HAS_COLOR' });
      let set = b.colorIndex.get(hex);
      if (!set) { set = new Set(); b.colorIndex.set(hex, set); }
      set.add(row.id);
    }
  }

  // Texto tokenizado por campo para search (Sets precomputados, sin re-tokenizar).
  b.textIndex.set(row.id, buildTextTokens(row));
}

/** (Re)crea las aristas CO_OCCURS_WITH a partir de los pesos acumulados. */
function rebuildCoOccurrenceEdges(b: SnapshotBuilder): void {
  for (const [tagA, partners] of b.coWeights) {
    for (const [tagB, weight] of partners) {
      const keyA = TAG + tagA;
      const keyB = TAG + tagB;
      if (b.graph.hasNode(keyA) && b.graph.hasNode(keyB)) {
        b.graph.mergeUndirectedEdge(keyA, keyB, { type: 'CO_OCCURS_WITH', weight });
      }
    }
  }
}

/**
 * Calcula las estructuras derivadas (orderedIds, topByDegree, stats) a partir
 * del builder y devuelve el snapshot final, listo para que las rutas lo lean.
 */
function finalizeSnapshot(b: SnapshotBuilder, t0: number): GraphSnapshot {
  // Lista ordenada (created_at DESC, id DESC).
  const orderedIds = [...b.byId.values()]
    .sort((a, b) => {
      const aTime = String(a.created_at);
      const bTime = String(b.created_at);
      const cmp = bTime.localeCompare(aTime);
      return cmp !== 0 ? cmp : b.id.localeCompare(a.id);
    })
    .map((r) => r.id);

  // Nodos ordenados por grado (para export sin center, evita O(n log n) por request).
  const topByDegree = b.graph.nodes()
    .map((n) => ({ id: n, degree: b.graph.degree(n) }))
    .sort((a, b) => b.degree - a.degree)
    .map((n) => n.id);

  // Stats.
  const tagStats = [...b.tagIndex.entries()]
    .map(([tag, ids]) => ({ tag, count: ids.size }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

  const styleStats = [...b.styleIndex.entries()]
    .map(([value, ids]) => ({ value, count: ids.size }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));

  const moodStats = [...b.moodIndex.entries()]
    .map(([value, ids]) => ({ value, count: ids.size }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));

  const useCaseStats = [...b.useCaseIndex.entries()]
    .map(([value, ids]) => ({ value, count: ids.size }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));

  return {
    graph: b.graph,
    byId: b.byId,
    tagIndex: b.tagIndex,
    styleIndex: b.styleIndex,
    moodIndex: b.moodIndex,
    useCaseIndex: b.useCaseIndex,
    colorIndex: b.colorIndex,
    textIndex: b.textIndex,
    tokenDf: buildTokenDf(b.textIndex.values()),
    coWeights: b.coWeights,
    orderedIds,
    topByDegree,
    imageCommunity: new Map(),
    communities: [],
    communityEdges: [],
    stats: {
      total: b.byId.size,
      styles: styleStats,
      moods: moodStats,
      tags: tagStats,
      useCases: useCaseStats,
    },
    builtAt: new Date(),
    buildMs: Date.now() - t0,
  };
}

// ── Búsqueda ────────────────────────────────────────────────────────────────

export interface SearchResult {
  items: ImageRow[];
  total: number;
}

/**
 * Búsqueda por token-match con ranking por cobertura ponderada por IDF.
 *
 * Cada término de la query se compara (con plural y sinónimos curados) contra
 * tags, subject, style, mood, use_case y prompts. El % combina la cobertura
 * (cuánto de lo buscado aparece) con la calidad del campo (tag > subject >
 * prompt). Los términos muy frecuentes pesan menos, y un match parcial de una
 * query multi-término solo entra si aporta algún término distintivo.
 *
 * Para queries de un término se mantiene el comportamiento OR: si el término
 * aparece, se devuelve. Para queries multi-término se prioriza el match completo
 * y se descartan los parciales genéricos que antes llenaban los tramos bajos.
 */
export function search(
  snap: GraphSnapshot,
  q: string,
  opts: { page?: number; limit?: number } = {},
): SearchResult & { page: number; limit: number; hasMore: boolean } {
  const page = Math.max(1, opts.page ?? 1);
  const limit = Math.min(100, Math.max(1, opts.limit ?? 24));
  const offset = (page - 1) * limit;

  const scored = scoreSearch(snap, q);
  const total = scored.total;
  const slice = scored.ids.slice(offset, offset + limit);
  const items = slice.map((id) => snap.byId.get(id)!).filter(Boolean);

  return {
    items,
    total,
    page,
    limit,
    hasMore: offset + items.length < total,
  };
}

export interface ScoredSearchItem extends MatchInfo {
  id: string;
  /**
   * Suma de pesos de los términos encontrados. Se usa como desempate cuando dos
   * imágenes tienen el mismo `percent` (más términos encontrados gana).
   */
  score: number;
}

export interface TierCounts {
  strong: number;
  possible: number;
  loose: number;
}

export interface ScoredSearch {
  /** Entradas rankeadas por coincidencia (percent DESC, score DESC, fecha DESC). */
  entries: ScoredSearchItem[];
  /** Compatibilidad: ids en el mismo orden que `entries`. */
  ids: string[];
  total: number;
  tierCounts: TierCounts;
}

function emptyScoredSearch(): ScoredSearch {
  return {
    entries: [],
    ids: [],
    total: 0,
    tierCounts: { strong: 0, possible: 0, loose: 0 },
  };
}

/**
 * Búsqueda léxica/metadata por coincidencia ponderada.
 *
 * Devuelve todos los resultados por encima de `SEARCH_MATCH_FLOOR`, agrupables
 * en tres tramos. Los tokens por campo vienen precomputados en `textIndex`, así
 * que no se re-tokeniza por request.
 */
export function scoreSearch(
  snap: GraphSnapshot,
  q: string,
  opts: { page?: number; limit?: number; minMatched?: number; topK?: number } = {},
): ScoredSearch {
  if (!q.trim()) return emptyScoredSearch();

  // Términos significativos normalizados (sin stopwords, sin tildes/puntuación).
  const terms = meaningfulTerms(q);
  // Frase normalizada para detectar un tag multi-palabra exacto.
  const queryPhrase = normalizePhrase(q);
  const minMatched = opts.minMatched ?? 1;
  const floor = config.search.floor;
  const idf = makeIdf(snap);
  const isDistinctive = makeDistinctive(snap);

  const entries: ScoredSearchItem[] = [];
  const tierCounts: TierCounts = { strong: 0, possible: 0, loose: 0 };

  for (const [id, toks] of snap.textIndex) {
    if (!snap.byId.has(id)) continue;

    const match = computeMetadataMatch(toks, terms, queryPhrase, { idf, isDistinctive });
    if (match.matched < minMatched || match.percent < floor) continue;
    if (!passesMetadataFilter(match)) continue;

    const score = match.terms.reduce((sum, t) => sum + t.weight, 0);
    entries.push({ id, score, ...match });
    tierCounts[match.tier]++;
  }

  // Orden: coincidencia DESC, campos curados DESC, riqueza de campos DESC,
  // fecha DESC, id DESC. La fecha queda al final: no debe decidir la relevancia.
  entries.sort((a, b) => {
    const cmpPercent = b.percent - a.percent;
    if (cmpPercent !== 0) return cmpPercent;
    const cmpCore = b.coreMatched - a.coreMatched;
    if (cmpCore !== 0) return cmpCore;
    const cmpScore = b.score - a.score;
    if (cmpScore !== 0) return cmpScore;
    const rowA = snap.byId.get(a.id)!;
    const rowB = snap.byId.get(b.id)!;
    const cmpDate = String(rowB.created_at).localeCompare(String(rowA.created_at));
    if (cmpDate !== 0) return cmpDate;
    return b.id.localeCompare(a.id);
  });

  if (opts.topK && opts.topK > 0 && entries.length > opts.topK) {
    const top = entries.slice(0, opts.topK);
    return {
      entries: top,
      ids: top.map((e) => e.id),
      total: entries.length,
      tierCounts,
    };
  }

  return {
    entries,
    ids: entries.map((e) => e.id),
    total: entries.length,
    tierCounts,
  };
}

// ── Related ─────────────────────────────────────────────────────────────────

export interface RelatedResult {
  items: ImageRow[];
}

/**
 * Imágenes relacionadas por similitud multihop:
 * 1. Intersección de vecinos en el grafo (Jaccard simplificado).
 * 2. Bonus por CO_OCCURS_WITH entre tags.
 */
export function related(
  snap: GraphSnapshot,
  id: string,
  limit: number = 8,
): RelatedResult {
  const baseRow = snap.byId.get(id);
  if (!baseRow) return { items: [] };

  // Vecinos del nodo Image: tags + style + mood + use_case + color.
  const baseNeighbors = new Set<string>();
  for (const n of snap.graph.neighbors(id)) {
    baseNeighbors.add(n);
  }

  // Scores de similitud.
  const scores = new Map<string, number>();

  for (const candidateId of snap.byId.keys()) {
    if (candidateId === id) continue;
    const candRow = snap.byId.get(candidateId)!;

    // Vecinos del candidato.
    const candNeighbors = new Set<string>();
    for (const n of snap.graph.neighbors(candidateId)) {
      candNeighbors.add(n);
    }

    // Intersección de vecinos compartidos (Jaccard-like).
    let shared = 0;
    for (const n of baseNeighbors) {
      if (candNeighbors.has(n)) shared++;
    }

    // Bonus por tags co-occurrentes fuertes (peso > 0).
    if (baseRow.tags && candRow.tags) {
      for (const tagA of baseRow.tags) {
        for (const tagB of candRow.tags) {
          if (tagA === tagB) continue;
          const weightA = snap.coWeights.get(tagA)?.get(tagB);
          const weightB = snap.coWeights.get(tagB)?.get(tagA);
          const weight = weightA ?? weightB ?? 0;
          if (weight > 0) shared += weight * 0.5;
        }
      }
    }

    if (shared > 0) scores.set(candidateId, shared);
  }

  // Ordenar por score DESC, created_at DESC.
  const sorted = [...scores.entries()]
    .sort((a, b) => {
      const cmp = b[1] - a[1];
      if (cmp !== 0) return cmp;
      const rowA = snap.byId.get(a[0])!;
      const rowB = snap.byId.get(b[0])!;
      return String(rowB.created_at).localeCompare(String(rowA.created_at));
    })
    .slice(0, limit)
    .map(([cid]) => snap.byId.get(cid)!);

  return { items: sorted };
}

// ── Tags ────────────────────────────────────────────────────────────────────

/**
 * Lista de tags con conteo, ordenados por count DESC, tag ASC.
 */
export function tagsList(
  snap: GraphSnapshot,
  limit: number = 200,
): { items: { tag: string; count: number }[] } {
  return { items: snap.stats.tags.slice(0, limit) };
}

/**
 * Imágenes filtradas por tag, paginadas.
 */
export function tagImages(
  snap: GraphSnapshot,
  tag: string,
  opts: { page?: number; limit?: number } = {},
): SearchResult & { page: number; limit: number; hasMore: boolean; tag: string } {
  const page = Math.max(1, opts.page ?? 1);
  const limit = Math.min(100, Math.max(1, opts.limit ?? 24));
  const offset = (page - 1) * limit;

  const ids = snap.tagIndex.get(tag) ?? new Set();

  // Filtrar y ordenar por created_at DESC, id DESC.
  const sorted = [...ids]
    .map((cid) => snap.byId.get(cid)!)
    .filter(Boolean)
    .sort((a, b) => {
      const cmp = String(b.created_at).localeCompare(String(a.created_at));
      if (cmp !== 0) return cmp;
      return b.id.localeCompare(a.id);
    });

  const total = sorted.length;
  const items = sorted.slice(offset, offset + limit);

  return { items, total, page, limit, hasMore: offset + items.length < total, tag };
}

// ── Filters / Facets ────────────────────────────────────────────────────────

export interface FiltersResult {
  styles: { value: string; count: number }[];
  moods: { value: string; count: number }[];
  useCases: { value: string; count: number }[];
}

export function filters(snap: GraphSnapshot): FiltersResult {
  return {
    styles: snap.stats.styles,
    moods: snap.stats.moods,
    useCases: snap.stats.useCases,
  };
}

export interface StatsResult {
  total: number;
  topStyles: { value: string; count: number }[];
  topMoods: { value: string; count: number }[];
  topTags: { tag: string; count: number }[];
}

export function stats(snap: GraphSnapshot): StatsResult {
  return {
    total: snap.stats.total,
    topStyles: snap.stats.styles.slice(0, 10),
    topMoods: snap.stats.moods.slice(0, 10),
    topTags: snap.stats.tags.slice(0, 20),
  };
}

// ── Graph export (para /api/graph) ───────────────────────────────────────────

export interface GraphNode {
  id: string;
  type: 'image' | 'tag' | 'style' | 'mood' | 'useCase' | 'color' | 'community';
  label: string;
  size: number;
  color: string;
  /** Info precisa para el panel/tooltip (comunidad o imagen). */
  meta?: {
    community?: number;
    size?: number;
    topTags?: string[];
    style?: string | null;
    mood?: string | null;
    useCase?: string | null;
    subject?: string | null;
  };
}

export interface GraphEdge {
  source: string;
  target: string;
  type: string;
  weight: number;
}

export interface GraphExport {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const NODE_COLORS: Record<string, string> = {
  image: '#6366f1',   // indigo
  tag: '#f59e0b',     // amber
  style: '#22c55e',   // green
  mood: '#a855f7',    // purple
  useCase: '#06b6d4', // cyan
  color: '#6b7280',   // gray
};

/** Opciones de exportación del grafo. */
export interface ExportOptions {
  types?: string[];
  limit?: number;
  center?: string;
  hops?: number;
  ids?: string[];
  /** `bipartite` (imagen+metadatos, por defecto), `atlas` (comunidades) o `images` (solo imágenes). */
  mode?: 'bipartite' | 'atlas' | 'images';
  /** Comunidad a exportar cuando `mode=images`. */
  community?: number;
}

/** Dispatcher de exportación según el modo pedido. */
function exportSnapshot(snap: GraphSnapshot, opts: ExportOptions): GraphExport {
  const mode = opts.mode ?? 'bipartite';
  if (mode === 'atlas') return exportAtlas(snap, opts);
  if (mode === 'images') return exportImages(snap, opts);
  return exportBipartite(snap, opts);
}

/** Familia de entrada de exportImages: solo imágenes (sin nodos de metadato). */
function exportImages(snap: GraphSnapshot, opts: ExportOptions): GraphExport {
  const limit = Math.min(600, Math.max(1, opts.limit ?? 300));
  const rank = (id: string) => snap.graph.degree(id);

  let ids: string[];
  if (opts.ids && opts.ids.length) {
    // Resultados de búsqueda: se respeta el orden del ranking.
    ids = opts.ids.filter((id) => snap.graph.hasNode(id)).slice(0, limit);
  } else if (opts.community !== undefined) {
    ids = [...snap.imageCommunity]
      .filter(([, c]) => c === opts.community)
      .map(([id]) => id)
      .sort((a, b) => rank(b) - rank(a))
      .slice(0, limit);
  } else {
    // Muestra global: las imágenes con más conexiones.
    ids = snap.topByDegree.filter((id) => snap.byId.has(id)).slice(0, limit);
  }

  const idSet = new Set(ids);

  // Aristas imagen↔imagen por metadatos compartidos dentro del set. Cada
  // metadato grande se recorta para no generar cliques gigantes.
  const MAX_PER_META = 40;
  const weights = new Map<string, number>();
  for (const mkey of snap.graph.nodes()) {
    if (!isMetadataKey(mkey)) continue;
    const members: string[] = [];
    snap.graph.forEachNeighbor(mkey, (nbr) => {
      if (idSet.has(nbr)) members.push(nbr);
    });
    if (members.length < 2) continue;
    const list =
      members.length > MAX_PER_META
        ? members.slice().sort((a, b) => rank(b) - rank(a)).slice(0, MAX_PER_META)
        : members;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i] < list[j] ? list[i] : list[j];
        const b = list[i] < list[j] ? list[j] : list[i];
        const key = `${a}|${b}`;
        weights.set(key, (weights.get(key) ?? 0) + 1);
      }
    }
  }

  const colorByCommunity = new Map(snap.communities.map((c) => [c.id, c.color]));
  const nodes: GraphNode[] = ids.map((id) => {
    const row = snap.byId.get(id);
    const c = snap.imageCommunity.get(id);
    const color = c !== undefined ? colorByCommunity.get(c) ?? NODE_COLORS.image : NODE_COLORS.image;
    return {
      id,
      type: 'image',
      label: row?.subject ?? id,
      size: Math.min(20, Math.max(3, Math.round(Math.sqrt(rank(id) + 1) * 2))),
      color,
      meta: {
        community: c,
        topTags: (row?.tags ?? []).slice(0, 6),
        style: row?.style ?? null,
        mood: row?.mood ?? null,
        useCase: row?.use_case ?? null,
        subject: row?.subject ?? null,
      },
    };
  });

  // KNN: cada imagen conserva solo sus K vecinos más similares. Sin esto, los
  // metadatos muy compartidos forman cliques y el cardumen se vuelve un ovillo.
  const K = 4;
  const byNode = new Map<string, { other: string; weight: number }[]>();
  const push = (from: string, other: string, weight: number) => {
    const list = byNode.get(from);
    if (list) list.push({ other, weight });
    else byNode.set(from, [{ other, weight }]);
  };
  for (const [key, weight] of weights) {
    const [a, b] = key.split('|');
    push(a, b, weight);
    push(b, a, weight);
  }

  const kept = new Set<string>();
  for (const [node, list] of byNode) {
    list.sort((x, y) => y.weight - x.weight || x.other.localeCompare(y.other));
    for (const { other } of list.slice(0, K)) {
      const lo = node < other ? node : other;
      const hi = node < other ? other : node;
      kept.add(`${lo}|${hi}`);
    }
  }

  return { nodes, edges: buildKeptEdges(kept, weights) };
}

function buildKeptEdges(
  kept: Set<string>,
  weights: Map<string, number>,
): GraphEdge[] {
  return [...kept]
    .map((key) => {
      const [source, target] = key.split('|');
      return { source, target, type: 'SIMILAR_TO', weight: weights.get(key) ?? 1 };
    })
    .sort((a, b) => b.weight - a.weight);
}

/** Atlas global: un super-nodo por comunidad + aristas entre comunidades. */
function exportAtlas(snap: GraphSnapshot, opts: ExportOptions): GraphExport {
  if (snap.communities.length === 0) return exportBipartite(snap, opts);

  const limit = Math.min(400, Math.max(1, opts.limit ?? 80));
  const top = snap.communities.slice(0, limit);
  const idSet = new Set(top.map((c) => c.id));

  const nodes: GraphNode[] = top.map((c) => ({
    id: `community:${c.id}`,
    type: 'community',
    label:
      c.topTags.slice(0, 2).map((t) => t.tag).join(' · ') ||
      c.style?.value ||
      `Grupo ${c.id}`,
    size: Math.min(40, Math.max(6, Math.round(Math.sqrt(c.size) * 2))),
    color: c.color,
    meta: {
      size: c.size,
      community: c.id,
      topTags: c.topTags.map((t) => t.tag),
      style: c.style?.value ?? null,
      mood: c.mood?.value ?? null,
      useCase: c.useCase?.value ?? null,
    },
  }));

  const edges: GraphEdge[] = snap.communityEdges
    .filter((e) => idSet.has(e.a) && idSet.has(e.b))
    .map((e) => ({
      source: `community:${e.a}`,
      target: `community:${e.b}`,
      type: 'COMMUNITY_LINK',
      weight: e.weight,
    }));

  return { nodes, edges };
}

function exportBipartite(
  snap: GraphSnapshot,
  opts: ExportOptions,
): GraphExport {
  const allowedTypes = new Set(opts.types ?? ['image', 'tag', 'style', 'mood', 'useCase', 'color']);
  const limit = opts.limit ?? 200;
  const hops = opts.hops ?? 1;

  // Si hay ids: subgrafo inducido por el conjunto de imágenes (búsqueda).
  // Los nodos metadato presentes cuentan con cuántas imágenes del set se
  // conectan (seedDegree), no con su frecuencia global.
  const seedSet = new Set(opts.ids ?? []);
  let nodeIds: Set<string>;
  if (seedSet.size) {
    nodeIds = new Set<string>();
    let frontier = new Set<string>();
    for (const id of seedSet) {
      if (!snap.graph.hasNode(id)) continue;
      nodeIds.add(id);
      frontier.add(id);
    }
    for (let h = 0; h < hops; h++) {
      const next = new Set<string>();
      for (const nid of frontier) {
        for (const neighbor of snap.graph.neighbors(nid)) {
          if (!nodeIds.has(neighbor)) {
            nodeIds.add(neighbor);
            next.add(neighbor);
          }
        }
      }
      frontier = next;
    }
  } else if (opts.center && snap.graph.hasNode(opts.center)) {
    nodeIds = new Set<string>();
    nodeIds.add(opts.center);
    let frontier = new Set([opts.center]);
    for (let h = 0; h < hops; h++) {
      const next = new Set<string>();
      for (const nid of frontier) {
        for (const neighbor of snap.graph.neighbors(nid)) {
          if (!nodeIds.has(neighbor)) {
            nodeIds.add(neighbor);
            next.add(neighbor);
          }
        }
      }
      frontier = next;
    }
  } else {
    // Sin center: usar precomputed topByDegree (O(1) vs O(n log n)).
    nodeIds = new Set(snap.topByDegree.slice(0, limit));
  }

  // Construir nodos.
  const nodes: GraphNode[] = [];
  // Cuando el subgrafo viene de un conjunto de imágenes (ids), el tamaño de
  // cada metadato es cuántas imágenes del set lo comparten (no su frecuencia
  // global). seedDegree se llena contando vecinos imagen por nodo.
  const seedDegree = new Map<string, number>();
  if (seedSet.size) {
    for (const id of seedSet) {
      if (!snap.graph.hasNode(id)) continue;
      for (const nb of snap.graph.neighbors(id)) {
        seedDegree.set(nb, (seedDegree.get(nb) ?? 0) + 1);
      }
    }
  }
  for (const nid of nodeIds) {
    const attrs = snap.graph.getNodeAttributes(nid);
    const type: GraphNode['type'] = attrs.type === 'Image' ? 'image'
      : attrs.type === 'Tag' ? 'tag'
      : attrs.type === 'Style' ? 'style'
      : attrs.type === 'Mood' ? 'mood'
      : attrs.type === 'UseCase' ? 'useCase'
      : 'color';

    if (!allowedTypes.has(type)) continue;
    // En modo ids (subgrafo de búsqueda) un metadato debe conectar al menos
    // 2 imágenes del set — si es único en la búsqueda no "une" nada y solo
    // añade ruido visual. Las imágenes siempre entran.
    if (seedSet.size && type !== 'image' && (seedDegree.get(nid) ?? 0) < 2) continue;

    const label = type === 'image'
      ? (snap.byId.get(nid)?.subject ?? nid)
      : (attrs.name ?? attrs.hex ?? nid);

    const size = type === 'image'
      ? Math.max(1, snap.graph.degree(nid))
      : seedSet.size
        // En modo ids, el tamaño refleja cuántas imágenes del set comparten
        // este metadato — el nodo "une" tantas imágenes de la búsqueda.
        ? (seedDegree.get(nid) ?? 1)
        : (snap.tagIndex.get(label)?.size ?? snap.styleIndex.get(label)?.size
          ?? snap.moodIndex.get(label)?.size ?? snap.useCaseIndex.get(label)?.size
          ?? snap.colorIndex.get(label)?.size ?? 1);

    nodes.push({
      id: nid,
      type,
      label,
      size: Math.min(20, Math.max(1, size)),
      color: NODE_COLORS[type],
    });
  }

  // Construir aristas.
  const edges: GraphEdge[] = [];
  const nodeSet = new Set(nodes.map((n) => n.id));
  for (const eid of snap.graph.edges()) {
    const [a, b] = snap.graph.extremities(eid);
    if (!nodeSet.has(a) || !nodeSet.has(b)) continue;
    const attrs = snap.graph.getEdgeAttributes(eid);
    edges.push({
      source: a,
      target: b,
      type: attrs.type ?? 'unknown',
      weight: attrs.weight ?? 1,
    });
  }

  return { nodes, edges };
}

// ── Store (manejo de snapshot + refresh) ────────────────────────────────────

/**
 * Watermark keyset: la última fila aplicada (created_at, id). El refresh
 * incremental consulta filas estrictamente mayores a este punto.
 */
export interface Watermark {
  created_at: string;
  id: string;
}

/**
 * Normaliza created_at para comparación de watermark. Si ya es string
 * (producido por to_char con .US, o fixtures ISO), se conserva tal cual para
 * no truncar microsegundos. Si es Date (pg sin to_char), se convierte a ISO.
 */
function created_at_string(v: string | Date): string {
  return typeof v === 'string' ? v : v.toISOString();
}

/** Calcula el watermark máximo a partir de las filas aplicadas. */
export function computeWatermark(rows: ImageRow[]): Watermark | null {
  if (rows.length === 0) return null;
  let max: Watermark | null = null;
  for (const row of rows) {
    const ts = created_at_string(row.created_at);
    if (!max || ts > max.created_at || (ts === max.created_at && row.id > max.id)) {
      max = { created_at: ts, id: row.id };
    }
  }
  return max;
}

/**
 * Aplica filas nuevas a un snapshot existente, mutando sus estructuras in situ
 * (por eso debe ejecutarse de forma síncrona, sin awaits entre escrituras).
 *
 * Solo maneja adiciones (append-only): las filas deben corresponder a ids que
 * aún no existen en el snapshot. Updates/deletes de filas antiguas los detecta
 * el rebuild completo periódico (GRAPH_FULL_RELOAD_MS).
 */
export function applyDelta(snap: GraphSnapshot, newRows: ImageRow[]): void {
  const t0 = Date.now();
  let added = 0;

  for (const row of newRows) {
    if (snap.byId.has(row.id)) continue; // ya existe; el rebuild la reconciliaría
    addRowToBuilder(snap, row);
    added++;
  }

  if (added === 0) return;

  // Recrear aristas CO_OCCURS_WITH con los pesos ya actualizados.
  rebuildCoOccurrenceEdges(snap);

  // Recalcular derivadas (ahora que el builder está completo).
  const next = finalizeSnapshot(snap, t0);
  snap.orderedIds = next.orderedIds;
  snap.topByDegree = next.topByDegree;
  snap.tokenDf = next.tokenDf;
  snap.stats = next.stats;
  snap.builtAt = next.builtAt;
  snap.buildMs = next.buildMs;
}

export class GraphStore {
  private _snapshot: GraphSnapshot | null = null;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _ready = false;
  private _watermark: Watermark | null = null;
  private _lastFullReload = 0;

  get snapshot(): GraphSnapshot | null { return this._snapshot; }
  get ready(): boolean { return this._ready; }
  get watermark(): Watermark | null { return this._watermark; }

  /** Carga el snapshot desde filas (pura, sin I/O). */
  load(rows: ImageRow[]): void {
    this._snapshot = buildGraph(rows);
    this._watermark = computeWatermark(rows);
    this._ready = true;
    this._lastFullReload = Date.now();
    console.log(
      `[graph] loaded ${rows.length} images, ${this._snapshot.graph.order} nodes, ${this._snapshot.graph.size} edges`,
    );
  }

  /**
   * Inicia el timer de refresh periódico.
   *
   * Cada tick decide: si pasó fullReloadMs (o aún no hay watermark), hace un
   * fetch completo + rebuild; si no, hace un fetch incremental (delta) y lo
   * aplica mutando el snapshot actual.
   */
  startRefresh(
    fetchAllFn: () => Promise<ImageRow[]>,
    fetchDeltaFn: (wm: Watermark) => Promise<ImageRow[]>,
    intervalMs: number,
    fullReloadMs: number,
  ): void {
    if (this._timer) clearInterval(this._timer);
    this._timer = setInterval(async () => {
      try {
        const needFull = !this._watermark || Date.now() - this._lastFullReload >= fullReloadMs;
        if (needFull) {
          const rows = await fetchAllFn();
          this.load(rows);
        } else {
          const rows = await fetchDeltaFn(this._watermark!);
          if (rows.length > 0) {
            applyDelta(this._snapshot!, rows);
            this._watermark = computeWatermark(rows) ?? this._watermark;
            console.log(`[graph] delta +${rows.length} refreshed (buildMs ${this._snapshot?.buildMs}ms)`);
          }
        }
      } catch (err) {
        console.error('[graph] refresh failed:', err);
      }
    }, intervalMs);
  }

  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /** Serializa el grafo para el endpoint /api/graph. */
  exportGraph(opts: ExportOptions = {}): GraphExport {
    if (!this._snapshot) return { nodes: [], edges: [] };
    return exportSnapshot(this._snapshot, opts);
  }
}

// ── Singleton global ────────────────────────────────────────────────────────

/**
 * Instancia singleton del store. Las rutas la importan para leer el snapshot.
 */
export const graphStore = new GraphStore();

/**
 * Normaliza filas de Postgres: pg devuelve timestamptz como `Date` (1ms de
 * precisión), pero el watermark y los ordenamientos necesitan el valor exacto
 * con microsegundos. Se selecciona `created_at` ya casteado a texto ISO UTC
 * (`to_char` con .US) para no perder precisión en la frontera JS. Este helper
 * solo defiende contra objetos Date residuales (mock/fixtures no aplican).
 */
function normalizeRows(rows: ImageRow[]): ImageRow[] {
  return rows.map((r) => {
    const ts = r.created_at as unknown;
    return typeof ts !== 'string'
      ? { ...r, created_at: (ts as Date).toISOString() }
      : r;
  });
}

/**
 * Fetch completo de generated_images desde Postgres.
 * Se usa para la carga inicial y el rebuild periódico (GRAPH_FULL_RELOAD_MS).
 */
export async function fetchAllRows(): Promise<ImageRow[]> {
  const { config } = await import('./config');
  if (config.mock) {
    const { getImageRows } = await import('./dataSource');
    return getImageRows();
  }
  const { pool } = await import('./db');
  const { rows } = await pool.query(
    `SELECT id, s3_key, s3_url, original_prompt, enhanced_prompt, tags, style, subject,
            mood, color_palette, use_case, filename,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
     FROM generated_images`,
  );
  return normalizeRows(rows as unknown as ImageRow[]);
}

/**
 * Fetch incremental: filas estrictamente mayores al watermark (created_at, id).
 *
 * En modo archivo (DB_FILE) las filas viven en dataSource y el auto-sync
 * (src/autoSync.ts / pnpm dump:sync) puede agregar nuevas al JSON — se filtra
 * por watermark en memoria para que entren en el tick de GRAPH_REFRESH_MS,
 * igual que haría el keyset SQL. En mock puro (MOCK_IMAGES estático) el filtro
 * no encuentra nada y devuelve [] como siempre.
 * En Postgres (DB_MOCK=false) hace el keyset SQL.
 */
export async function fetchDeltaRows(wm: Watermark): Promise<ImageRow[]> {
  const { config } = await import('./config');
  if (config.mock) {
    const { getImageRows } = await import('./dataSource');
    const rows = getImageRows();
    // Mismo contrato que el SQL: > watermark, orden ASC (created_at, id).
    return rows
      .filter((r) => {
        const ts = created_at_string(r.created_at);
        return ts > wm.created_at || (ts === wm.created_at && r.id > wm.id);
      })
      .sort((a, b) => {
        const ta = created_at_string(a.created_at);
        const tb = created_at_string(b.created_at);
        if (ta !== tb) return ta < tb ? -1 : 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
  }
  const { pool } = await import('./db');
  const { rows } = await pool.query(
    `SELECT id, s3_key, s3_url, original_prompt, enhanced_prompt, tags, style, subject,
            mood, color_palette, use_case, filename,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
     FROM generated_images
     WHERE (created_at, id::text) > ($1::timestamptz, $2::text)
     ORDER BY created_at ASC, id ASC`,
    [wm.created_at, wm.id],
  );
  return normalizeRows(rows as unknown as ImageRow[]);
}
