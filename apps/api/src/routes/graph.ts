import { Router, Request, Response, NextFunction } from 'express';
import { graphStore } from '../graph';

export const graphRouter = Router();

// GET /api/graph?types=image,tag,style&limit=200&center=<id>&hops=1
// GET /api/graph?ids=id1,id2,id3&hops=1        → subgrafo inducido por la búsqueda
// GET /api/graph?mode=atlas&limit=80           → atlas de comunidades (cardúmenes)
// GET /api/graph?mode=images&community=3       → imágenes de una comunidad
graphRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!graphStore.ready) {
      res.json({ nodes: [], edges: [] });
      return;
    }

    const typesRaw = typeof req.query.types === 'string' ? req.query.types : '';
    const types = typesRaw
      ? typesRaw.split(',').map((t) => t.trim()).filter(Boolean)
      : undefined;

    const limit = Math.min(600, Math.max(1, Number(req.query.limit ?? 200)));
    const center = typeof req.query.center === 'string' ? req.query.center : undefined;
    const hops = Math.min(3, Math.max(1, Number(req.query.hops ?? 1)));
    const ids = typeof req.query.ids === 'string'
      ? req.query.ids.split(',').map((id) => id.trim()).filter(Boolean)
      : undefined;

    const modeRaw = typeof req.query.mode === 'string' ? req.query.mode : '';
    const mode =
      modeRaw === 'atlas' || modeRaw === 'images' || modeRaw === 'bipartite'
        ? modeRaw
        : undefined;
    const community =
      req.query.community !== undefined && req.query.community !== ''
        ? Number(req.query.community)
        : undefined;

    const result = graphStore.exportGraph({ types, limit, center, hops, ids, mode, community });
    res.json(result);
  } catch (err) {
    next(err);
  }
});
