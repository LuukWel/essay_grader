/** Cosine similarity of two vectors, in [-1, 1]; 0 when lengths differ or a vector is all zeros. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const mag = Math.sqrt(magA) * Math.sqrt(magB);
  if (mag === 0) return 0;
  // Rounding can push identical vectors just past 1 (e.g. 1.0000000000000002).
  return Math.max(-1, Math.min(1, dot / mag));
}

/** The `n` most similar other items for each item (directed). Compares all pairs, so O(n²). */
export function nearestNeighbours(
  items: { id: string; vec: number[] }[],
  n: number,
): { essayIdA: string; essayIdB: string; score: number }[] {
  const dims = new Set(items.map((i) => i.vec.length));
  if (dims.size > 1) {
    throw new Error(`embeddings have different dimensions (${[...dims].join(', ')}); were they made by different models?`);
  }

  const rows: { essayIdA: string; essayIdB: string; score: number }[] = [];
  for (const a of items) {
    const scored = items
      .filter((b) => b.id !== a.id)
      .map((b) => ({ essayIdA: a.id, essayIdB: b.id, score: cosineSimilarity(a.vec, b.vec) }))
      // Break ties by ID for a stable order.
      .sort((x, y) => y.score - x.score || x.essayIdB.localeCompare(y.essayIdB));
    rows.push(...scored.slice(0, n));
  }
  return rows;
}
