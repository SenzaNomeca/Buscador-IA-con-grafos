import { describe, it, expect } from 'vitest';
import { buildGraph, scoreSearch, tierFor } from '../src/graph';
import type { ImageRow } from '../src/types';

function row(overrides: Partial<ImageRow> & { id: string }): ImageRow {
  return {
    id: overrides.id,
    s3_key: `key/${overrides.id}.webp`,
    s3_url: `https://example.com/${overrides.id}.webp`,
    original_prompt: null,
    enhanced_prompt: null,
    tags: null,
    style: null,
    subject: null,
    mood: null,
    color_palette: null,
    use_case: null,
    filename: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function build(rows: ImageRow[]) {
  return buildGraph(rows);
}

function firstMatch(rows: ImageRow[], q: string) {
  const snap = build(rows);
  const scored = scoreSearch(snap, q);
  return scored.entries.find((e) => e.id === rows[0].id);
}

describe('computeMetadataMatch / scoreSearch', () => {
  it('tag exacto = 100% y tramo strong', () => {
    const match = firstMatch([row({ id: 'r1', tags: ['gato'] })], 'gato');
    expect(match?.percent).toBe(100);
    expect(match?.tier).toBe('strong');
    expect(match?.terms[0]).toMatchObject({ term: 'gato', field: 'tag', weight: 1 });
  });

  it('subject = 90% y tramo strong', () => {
    const match = firstMatch([row({ id: 'r1', subject: 'Gato en la ventana' })], 'gato');
    expect(match?.percent).toBe(90);
    expect(match?.tier).toBe('strong');
    expect(match?.terms[0].field).toBe('subject');
  });

  it('style = 85% y tramo strong', () => {
    const match = firstMatch([row({ id: 'r1', style: 'Fotorrealista' })], 'fotorrealista');
    expect(match?.percent).toBe(85);
    expect(match?.tier).toBe('strong');
    expect(match?.terms[0].field).toBe('style');
  });

  it('prompt original = 65% y tramo possible', () => {
    const match = firstMatch([row({ id: 'r1', original_prompt: 'un gato negro' })], 'gato');
    expect(match?.percent).toBe(65);
    expect(match?.tier).toBe('possible');
    expect(match?.terms[0].field).toBe('original');
  });

  it('cobertura parcial 1/2 pondera por IDF: 37% y tramo loose', () => {
    const match = firstMatch([row({ id: 'r1', tags: ['gato'] })], 'gato negro');
    // gato (df=1) pesa 1.0; negro (df=0) pesa log(2)+1 = 1.693.
    expect(match?.percent).toBe(37);
    expect(match?.tier).toBe('loose');
    expect(match?.matched).toBe(1);
    expect(match?.queryTerms).toBe(2);
  });

  it('cobertura parcial 1/3 pondera por IDF: 23% y tramo loose', () => {
    const match = firstMatch([row({ id: 'r1', tags: ['persona'] })], 'persona sala control');
    // persona (df=1) pesa 1.0; sala y control (df=0) pesan 1.693 cada uno.
    expect(match?.percent).toBe(23);
    expect(match?.tier).toBe('loose');
    expect(match?.matched).toBe(1);
    expect(match?.queryTerms).toBe(3);
  });

  it('normaliza tildes y mayúsculas', () => {
    const match = firstMatch([row({ id: 'r1', tags: ['Niño'] })], 'nino');
    expect(match?.percent).toBe(100);
  });

  it('matchea plural mínimo', () => {
    const match = firstMatch([row({ id: 'r1', tags: ['gatos'] })], 'gato');
    expect(match?.percent).toBe(100);
  });

  it('expande sinónimos curados (sonriendo → sonrisa)', () => {
    const match = firstMatch([row({ id: 'r1', tags: ['sonrisa'] })], 'sonriendo');
    expect(match?.percent).toBe(100);
    expect(match?.tier).toBe('strong');
    expect(match?.terms[0]).toMatchObject({ term: 'sonriendo', field: 'tag', weight: 1 });
  });

  it('un match multi-término solo en prompt no puede ser strong: queda loose', () => {
    const match = firstMatch(
      [row({ id: 'r1', original_prompt: 'persona en una oficina' })],
      'persona oficina',
    );
    expect(match?.percent).toBe(39);
    expect(match?.tier).toBe('loose');
    expect(match?.coreMatched).toBe(0);
  });

  it('exige cohesión: "fondo-azul" + "mesa-blanca" no es "fondo blanco"', () => {
    const filler = Array.from({ length: 200 }, (_, i) =>
      row({ id: `f${i}`, tags: ['fondo', 'blanco'] }),
    );
    const rows = [
      row({ id: 'exact', tags: ['fondo blanco'] }),
      row({ id: 'cross', tags: ['fondo-azul', 'mesa-blanca'] }),
      ...filler,
    ];
    const scored = scoreSearch(build(rows), 'fondo blanco');
    const exact = scored.entries.find((e) => e.id === 'exact');
    const cross = scored.entries.find((e) => e.id === 'cross');

    expect(exact?.percent).toBe(100);
    expect(exact?.tier).toBe('strong');
    expect(exact?.cohesive).toBe(true);
    expect(cross?.percent).toBe(79);
    expect(cross?.tier).toBe('possible');
    expect(cross?.cohesive).toBe(false);
  });

  it('con 3 términos acepta 2 en el mismo tag: fondo/blanco/minimalista', () => {
    const filler = Array.from({ length: 200 }, (_, i) =>
      row({ id: `f${i}`, tags: ['fondo', 'blanco', 'minimalista'] }),
    );
    const rows = [
      row({ id: 'exact', tags: ['fondo panel blanco', 'minimalista'] }),
      row({ id: 'cross', tags: ['fondo-azul', 'mesa-blanca', 'minimalista'] }),
      // El blanco pertenece a los rectángulos, no al fondo: no debe ser strong.
      row({ id: 'noise', tags: ['rectangulos blancos con garabatos', 'fondo beige minimalista'] }),
      ...filler,
    ];
    const scored = scoreSearch(build(rows), 'fondo blanco minimalista');
    const exact = scored.entries.find((e) => e.id === 'exact');
    const cross = scored.entries.find((e) => e.id === 'cross');
    const noise = scored.entries.find((e) => e.id === 'noise');

    expect(exact?.percent).toBe(97);
    expect(exact?.tier).toBe('strong');
    expect(exact?.cohesive).toBe(true);
    expect(cross?.percent).toBe(79);
    expect(cross?.tier).toBe('possible');
    expect(cross?.cohesive).toBe(false);
    expect(noise?.percent).toBe(79);
    expect(noise?.tier).toBe('possible');
    expect(noise?.cohesive).toBe(false);
  });

  it('descarta parciales multi-término sin ningún término distintivo', () => {
    const filler = Array.from({ length: 100 }, (_, i) =>
      row({ id: `f${i}`, tags: ['comun'] }),
    );
    const scored = scoreSearch(build([row({ id: 'r1', tags: ['comun'] }), ...filler]), 'comun raro');
    expect(scored.entries).toHaveLength(0);
  });

  it('mantiene parciales multi-término con un término distintivo', () => {
    const filler = Array.from({ length: 20 }, (_, i) => row({ id: `f${i}` }));
    const scored = scoreSearch(build([row({ id: 'r1', tags: ['gato'] }), ...filler]), 'gato raro');
    const match = scored.entries.find((e) => e.id === 'r1');

    expect(match?.percent).toBe(45);
    expect(match?.tier).toBe('possible');
    expect(match?.distinctive).toBe(true);
  });

  it('tag multi-palabra: "sala de control" y "sala control"', () => {
    const exact = firstMatch(
      [row({ id: 'r1', tags: ['sala de control'] })],
      'sala de control',
    );
    expect(exact?.percent).toBe(100);

    const withoutStopword = firstMatch(
      [row({ id: 'r1', tags: ['sala de control'] })],
      'sala control',
    );
    expect(withoutStopword?.percent).toBe(95);
    expect(withoutStopword?.tier).toBe('strong');
  });

  it('descarta coincidencias por debajo del piso del 10%', () => {
    const snap = build([
      row({ id: 'r1', original_prompt: 'gato' }),
      row({ id: 'r2', original_prompt: 'perro' }),
    ]);
    // 1 término de 11 en prompt → 6%, debajo del piso.
    const scored = scoreSearch(
      snap,
      'gato a b c d e f g h i j',
    );
    expect(scored.entries.map((e) => e.id)).not.toContain('r1');
    expect(scored.entries.map((e) => e.id)).not.toContain('r2');
  });

  it('ordena por percent y luego por riqueza de campos', () => {
    const rows = [
      row({ id: 'tag', tags: ['gato'] }),
      row({ id: 'tagSubject', tags: ['gato'], subject: 'Gato' }),
      row({ id: 'prompt', original_prompt: 'gato' }),
    ];
    const scored = scoreSearch(build(rows), 'gato');
    expect(scored.entries.map((e) => e.id)).toEqual(['tagSubject', 'tag', 'prompt']);
    expect(scored.tierCounts.strong).toBe(2);
    expect(scored.tierCounts.possible).toBe(1);
  });

  it('tierFor respeta los límites 80/40', () => {
    expect(tierFor(100)).toBe('strong');
    expect(tierFor(80)).toBe('strong');
    expect(tierFor(79)).toBe('possible');
    expect(tierFor(40)).toBe('possible');
    expect(tierFor(39)).toBe('loose');
    expect(tierFor(0)).toBe('loose');
  });
});
