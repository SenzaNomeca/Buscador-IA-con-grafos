import { describe, it, expect, beforeEach } from 'vitest';
import { buildGraph, GraphStore } from '../src/graph';
import { sampleRows, resetCounter } from './fixtures/images';

beforeEach(() => {
  resetCounter();
});

describe('communities (Louvain)', () => {
  it('assigns a community to every image and summarizes them', () => {
    const snap = buildGraph(sampleRows);
    expect(snap.imageCommunity.size).toBe(sampleRows.length);
    expect(snap.communities.length).toBeGreaterThan(0);

    const total = snap.communities.reduce((s, c) => s + c.size, 0);
    expect(total).toBe(sampleRows.length);

    for (const c of snap.communities) {
      expect(c.size).toBeGreaterThan(0);
      expect(c.color).toMatch(/^#/);
    }
    // Ordenadas por tamaño descendente.
    for (let i = 1; i < snap.communities.length; i++) {
      expect(snap.communities[i - 1].size).toBeGreaterThanOrEqual(snap.communities[i].size);
    }
  });

  it('atlas mode returns community nodes and inter-community edges', () => {
    const store = new GraphStore();
    store.load(sampleRows);
    const g = store.exportGraph({ mode: 'atlas', limit: 80 });

    expect(g.nodes.length).toBeGreaterThan(0);
    for (const n of g.nodes) {
      expect(n.type).toBe('community');
      expect(n.id.startsWith('community:')).toBe(true);
      expect(typeof n.meta?.community).toBe('number');
    }
    for (const e of g.edges) {
      expect(e.type).toBe('COMMUNITY_LINK');
      expect(e.source.startsWith('community:')).toBe(true);
      expect(e.target.startsWith('community:')).toBe(true);
    }
    store.stop();
  });

  it('images mode returns only image nodes (metadata hidden)', () => {
    const store = new GraphStore();
    store.load(sampleRows);
    const g = store.exportGraph({ mode: 'images', limit: 300 });

    expect(g.nodes.length).toBeGreaterThan(0);
    for (const n of g.nodes) {
      expect(n.type).toBe('image');
      expect(typeof n.meta?.community).toBe('number');
    }

    const ids = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges) {
      expect(e.type).toBe('SIMILAR_TO');
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
    store.stop();
  });

  it('images mode can be scoped to a single community', () => {
    const snap = buildGraph(sampleRows);
    const c0 = snap.communities[0].id;

    const store = new GraphStore();
    store.load(sampleRows);
    const g = store.exportGraph({ mode: 'images', community: c0, limit: 300 });

    expect(g.nodes.length).toBeGreaterThan(0);
    for (const n of g.nodes) {
      expect(n.meta?.community).toBe(c0);
    }
    store.stop();
  });

  it('default mode stays bipartite (metadata nodes present)', () => {
    const store = new GraphStore();
    store.load(sampleRows);
    const g = store.exportGraph({ limit: 200 });

    const types = new Set(g.nodes.map((n) => n.type));
    expect([...types].some((t) => t === 'tag' || t === 'style')).toBe(true);
    store.stop();
  });
});
