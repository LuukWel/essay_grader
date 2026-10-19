import { describe, expect, it } from 'vitest';
import { cosineSimilarity, nearestNeighbours } from '@/lib/similarity';

describe('cosineSimilarity', () => {
  it('is 1 for the same direction, 0 for orthogonal and -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 2], [2, 4])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 3])).toBe(0);
    expect(cosineSimilarity([1, 1], [-1, -1])).toBeCloseTo(-1);
  });

  it('stays within [-1, 1] despite rounding', () => {
    const v = [0.1, 0.2, 0.3, 0.7, 0.9, 0.333333];
    const s = cosineSimilarity(v, v);
    expect(s).toBeLessThanOrEqual(1);
    expect(s).toBeGreaterThanOrEqual(-1);
  });

  it('is 0 for a zero vector or mismatched lengths', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });
});

describe('nearestNeighbours', () => {
  const items = [
    { id: 'a', vec: [1, 0] },
    { id: 'b', vec: [0.9, 0.1] },
    { id: 'c', vec: [0, 1] },
    { id: 'd', vec: [-1, 0] },
  ];

  it('lists the n most similar other items per item, best first', () => {
    const rows = nearestNeighbours(items, 2);
    expect(rows.filter((r) => r.essayIdA === 'a').map((r) => r.essayIdB)).toEqual(['b', 'c']);
    expect(rows.filter((r) => r.essayIdA === 'd').map((r) => r.essayIdB)).toEqual(['c', 'b']);
    expect(rows.every((r) => r.essayIdA !== r.essayIdB)).toBe(true);
    expect(rows).toHaveLength(8);
  });

  it('breaks ties by ID, so the result does not depend on input order', () => {
    // y and z are equally similar to x; with n = 1, x must always get y (the lower ID).
    const tied = [{ id: 'x', vec: [1, 1] }, { id: 'z', vec: [0, 1] }, { id: 'y', vec: [1, 0] }];
    const pairs = (rows: { essayIdA: string; essayIdB: string }[]) => rows.map((r) => `${r.essayIdA}>${r.essayIdB}`).sort();
    expect(pairs(nearestNeighbours(tied, 1))).toEqual(pairs(nearestNeighbours([...tied].reverse(), 1)));
    expect(pairs(nearestNeighbours(tied, 1))).toContain('x>y');
  });

  it('refuses embeddings of different dimensions', () => {
    expect(() => nearestNeighbours([{ id: 'a', vec: [1, 0] }, { id: 'b', vec: [1, 0, 0] }], 1))
      .toThrow('different dimensions');
  });
});
