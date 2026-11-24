import { Router, Request, Response, NextFunction } from 'express';
import {
  graphStore,
  scoreSearch,
  computeMetadataMatch,
  buildTextTokens,
  buildTokenDf,
  idfFromDf,
  makeDistinctiveFromDf,
  makeIdf,
  makeDistinctive,
  normalizePhrase,
  passesMetadataFilter,
  tierFor,
  type MatchInfo,
  type SearchTier,
} from '../graph';
import { meaningfulTerms } from '../stopwords';
import { config } from '../config';
import type { ImageRow } from '../types';

export const searchRouter = Router();

const TIERS: SearchTier[] = ['strong', 'possible', 'loose'];

const TIER_LABELS: Record<SearchTier, string> = {
  strong: 'Resultados parecidos',
  possible: 'Podría encajar',
  loose: 'Podrían ser similares',
};

interface RankedItem {
  id: string;
  percent: number;
  tier: SearchTier;
  /** Suma de pesos de los términos encontrados (desempate). */
  metadataScore: number;
  /** Coseno semántico 0-100 (0 si el modo es léxico). */
  semanticScore: number;
  createdAt: string;
  match: MatchInfo;
}

function isTier(value: unknown): value is SearchTier {
  return value === 'strong' || value === 'possible' || value === 'loose';
}

function emptyTierCounts(): Record<SearchTier, number> {
  return { strong: 0, possible: 0, loose: 0 };
}

function tierCountsOf(items: RankedItem[]): Record<SearchTier, number> {
  const counts = emptyTierCounts();
  for (const item of items) counts[item.tier]++;
  return counts;
}

function tierRange(tier: SearchTier): { min: number; max: number } {
  if (tier === 'strong') {
    return { min: config.search.tierStrong, max: 100 };
  }
  if (tier === 'possible') {
    return { min: config.search.tierPossible, max: config.search.tierStrong - 1 };
  }
  return { min: config.search.floor, max: config.search.tierPossible - 1 };
}

function toItem(row: ImageRow, match: MatchInfo): ImageRow & { match: MatchInfo } {
  return { ...row, match };
}

/** Entero positivo tolerante: `?page=abc` cae al default, no a NaN. */
function positiveInt(value: unknown, fallback: number, max?: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.max(1, Math.floor(n));
  return max ? Math.min(max, v) : v;
}

function compareRanked(a: RankedItem, b: RankedItem): number {
  const cmpPercent = b.percent - a.percent;
  if (cmpPercent !== 0) return cmpPercent;
  const cmpCore = (b.match.coreMatched ?? 0) - (a.match.coreMatched ?? 0);
  if (cmpCore !== 0) return cmpCore;
  const cmpMetadata = b.metadataScore - a.metadataScore;
  if (cmpMetadata !== 0) return cmpMetadata;
  const cmpSemantic = b.semanticScore - a.semanticScore;
  if (cmpSemantic !== 0) return cmpSemantic;
  const cmpDate = String(b.createdAt).localeCompare(String(a.createdAt));
  if (cmpDate !== 0) return cmpDate;
  return b.id.localeCompare(a.id);
}

/** Ranking puramente léxico/metadata (modo lexical o fallback sin embeddings). */
function rankLexical(
  snap: NonNullable<typeof graphStore.snapshot>,
  q: string,
): RankedItem[] {
  const scored = scoreSearch(snap, q);
  const ranked: RankedItem[] = [];
  for (const entry of scored.entries) {
    const row = snap.byId.get(entry.id);
    if (!row) continue;
    ranked.push({
      id: entry.id,
      percent: entry.percent,
      tier: entry.tier,
      metadataScore: entry.score,
      semanticScore: 0,
      createdAt: String(row.created_at),
      match: {
        percent: entry.percent,
        tier: entry.tier,
        matched: entry.matched,
        queryTerms: entry.queryTerms ?? entry.matched,
        coverage: entry.coverage ?? 1,
        coreMatched: entry.coreMatched ?? entry.matched,
        distinctive: entry.distinctive ?? false,
        cohesive: entry.cohesive ?? true,
        terms: entry.terms,
      },
    });
  }
  return ranked;
}

/**
 * Ranking para semantic/hybrid: une el feed léxico con el top-100 semántico y
 * asigna al % el máximo de ambas señales. Así un sinónimo encontrado solo por
 * embeddings no cae injustamente en el último tramo.
 */
async function rankWithSemantic(
  snap: NonNullable<typeof graphStore.snapshot>,
  q: string,
  mode: 'semantic' | 'hybrid',
): Promise<RankedItem[]> {
  const ranked = rankLexical(snap, q);

  const { getSemanticIndex, embedQuery, searchSemantic } = await import('../embeddings');
  const semIndex = await getSemanticIndex();
  const qVec = await embedQuery(q);

  if (!semIndex || semIndex.dim === 0 || !qVec) return ranked;

  // En hybrid el feed semántico se filtra con SEMANTIC_MIN_SCORE (anti-ruido).
  // En semantic puro no: el usuario quiere el top-k directo por coseno.
  const minScore = mode === 'hybrid' ? config.semantic.minScore : 0;
  const semantic = searchSemantic(semIndex, qVec, 100, minScore);
  const semanticIds = new Set(semantic.map((hit) => hit.id));
  const byId = new Map(ranked.map((item) => [item.id, item]));
  const terms = meaningfulTerms(q);
  const queryPhrase = normalizePhrase(q);
  const idf = makeIdf(snap);
  const isDistinctive = makeDistinctive(snap);

  for (const hit of semantic) {
    const semPercent = Math.round(Math.max(0, Math.min(1, hit.score)) * 100);
    const existing = byId.get(hit.id);

    if (existing) {
      existing.semanticScore = semPercent;
      existing.match = { ...existing.match, semanticPercent: semPercent };
      if (semPercent > existing.percent) {
        existing.percent = semPercent;
        existing.tier = tierFor(semPercent);
        existing.match = {
          ...existing.match,
          percent: semPercent,
          tier: existing.tier,
        };
      }
      continue;
    }

    const row = snap.byId.get(hit.id);
    if (!row) continue;

    const toks = snap.textIndex.get(hit.id) ?? buildTextTokens(row);
    const meta = computeMetadataMatch(toks, terms, queryPhrase, { idf, isDistinctive });
    const percent = Math.max(meta.percent, semPercent);
    if (percent < config.search.floor) continue;

    const tier = tierFor(percent);
    byId.set(hit.id, {
      id: hit.id,
      percent,
      tier,
      metadataScore: meta.terms.reduce((sum, t) => sum + t.weight, 0),
      semanticScore: semPercent,
      createdAt: String(row.created_at),
      match: { ...meta, percent, tier, semanticPercent: semPercent },
    });
  }

  const merged = [...byId.values()];
  // En semantic puro el feed léxico solo se usa para enriquecer el % de los
  // hits semánticos; no se cuelan resultados que el coseno no trajo.
  return mode === 'semantic' ? merged.filter((item) => semanticIds.has(item.id)) : merged;
}

/** Pagina/ordena y arma la respuesta para graph y SQL fallback. */
function respondRanked(
  req: Request,
  res: Response,
  ranked: RankedItem[],
  q: string,
  mode: string,
  rowsById: Map<string, ImageRow>,
  graph?: ReturnType<typeof graphStore.exportGraph>,
): void {
  ranked.sort(compareRanked);

  const tierParam = req.query.tier;
  const selectedTier = isTier(tierParam) ? tierParam : undefined;
  const grouped = req.query.grouped === '1' || req.query.grouped === 'true';
  const page = positiveInt(req.query.page, 1);
  const limit = positiveInt(req.query.limit, grouped ? 12 : 24, grouped ? 50 : 100);
  const tierCounts = tierCountsOf(ranked);

  const slice = (items: RankedItem[], pageNumber: number, pageLimit: number) => {
    const offset = (pageNumber - 1) * pageLimit;
    return {
      page: pageNumber,
      limit: pageLimit,
      total: items.length,
      hasMore: offset + pageLimit < items.length,
      items: items
        .slice(offset, offset + pageLimit)
        .map((item) => {
          const row = rowsById.get(item.id);
          return row ? toItem(row, item.match) : null;
        })
        .filter((item): item is ImageRow & { match: MatchInfo } => item !== null),
    };
  };

  if (grouped) {
    const tiers = TIERS.map((tier) => {
      const items = ranked.filter((item) => item.tier === tier);
      const pageData = slice(items, 1, limit);
      return {
        id: tier,
        label: TIER_LABELS[tier],
        ...tierRange(tier),
        count: items.length,
        page: pageData.page,
        limit: pageData.limit,
        hasMore: pageData.hasMore,
        items: pageData.items,
      };
    });

    res.json({
      q,
      mode,
      total: ranked.length,
      tierCounts,
      tiers,
      graph,
    });
    return;
  }

  const items = selectedTier ? ranked.filter((item) => item.tier === selectedTier) : ranked;
  const pageData = slice(items, page, limit);
  res.json({
    ...pageData,
    q,
    mode,
    grandTotal: ranked.length,
    tier: selectedTier,
    tierCounts,
    graph,
  });
}

// GET /api/search?q=...&page=1&limit=24&mode=hybrid&grouped=1&tier=possible
searchRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const mode =
      typeof req.query.mode === 'string' &&
      ['lexical', 'semantic', 'hybrid'].includes(req.query.mode)
        ? req.query.mode
        : config.semantic.mode;

    if (!q) {
      res.json({
        items: [],
        page: 1,
        limit: 24,
        total: 0,
        hasMore: false,
        grandTotal: 0,
        q,
        mode,
        tierCounts: emptyTierCounts(),
        tiers: TIERS.map((tier) => ({
          id: tier,
          label: TIER_LABELS[tier],
          ...tierRange(tier),
          count: 0,
          page: 1,
          limit: 12,
          hasMore: false,
          items: [],
        })),
      });
      return;
    }

    // En graph=1 devolvemos el subgrafo inducido por el top-100 del ranking.
    const wantGraph = req.query.graph === '1' || req.query.graph === 'true';

    if (config.graph.engine === 'graph' && graphStore.ready && graphStore.snapshot) {
      const snap = graphStore.snapshot;
      const ranked =
        mode === 'lexical'
          ? rankLexical(snap, q)
          : await rankWithSemantic(snap, q, mode === 'semantic' ? 'semantic' : 'hybrid');

      ranked.sort(compareRanked);
      const graph = wantGraph
        ? graphStore.exportGraph({
            mode: 'images',
            ids: ranked.slice(0, 100).map((item) => item.id),
            limit: 300,
          })
        : undefined;

      respondRanked(req, res, ranked, q, mode, snap.byId, graph);
      return;
    }

    // ── Fallback SQL ───────────────────────────────────────────────────────
    // Se calcula el % en JS sobre las filas candidatas (tope de seguridad).
    const { query } = await import('../db');
    const terms = meaningfulTerms(q);
    const queryPhrase = normalizePhrase(q);
    const ilike = `%${q}%`;
    const cap = 5000;

    const dataSql = `
      SELECT id, s3_key, s3_url, original_prompt, enhanced_prompt, tags, style, subject,
             mood, color_palette, use_case, filename, created_at
      FROM generated_images
      WHERE tags && $1::text[]
        OR array_to_string(tags, ' ') ILIKE $2
        OR EXISTS (
          SELECT 1 FROM unnest($1::text[]) AS term
          WHERE subject ILIKE '%' || term || '%'
             OR style ILIKE '%' || term || '%'
             OR mood ILIKE '%' || term || '%'
             OR use_case ILIKE '%' || term || '%'
             OR original_prompt ILIKE '%' || term || '%'
             OR enhanced_prompt ILIKE '%' || term || '%'
             OR EXISTS (
               SELECT 1 FROM unnest(tags) AS tag
               WHERE tag ILIKE '%' || term || '%'
             )
        )
      ORDER BY created_at DESC
      LIMIT ${cap}
    `;

    const dataRes = await query(dataSql, [terms, ilike]);
    const rows = dataRes.rows as ImageRow[];
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    const ranked: RankedItem[] = [];

    // En el fallback SQL no hay snapshot global: calculamos IDF y "distintivo"
    // sobre los candidatos (tope 5000) para mantener el mismo criterio.
    const textIndex = new Map(rows.map((row) => [row.id, buildTextTokens(row)]));
    const tokenDf = buildTokenDf(textIndex.values());
    const total = rows.length;
    const idf = (token: string) => idfFromDf(tokenDf, total, token);
    const isDistinctive = makeDistinctiveFromDf(tokenDf, total);

    for (const row of rows) {
      const toks = textIndex.get(row.id)!;
      const meta = computeMetadataMatch(toks, terms, queryPhrase, { idf, isDistinctive });
      if (meta.percent < config.search.floor || !passesMetadataFilter(meta)) continue;
      ranked.push({
        id: row.id,
        percent: meta.percent,
        tier: meta.tier,
        metadataScore: meta.terms.reduce((sum, t) => sum + t.weight, 0),
        semanticScore: 0,
        createdAt: String(row.created_at),
        match: meta,
      });
    }

    respondRanked(req, res, ranked, q, mode, rowsById);
  } catch (err) {
    next(err);
  }
});
