/**
 * Self-contained, zero-dependency PCA implementation for 2D embedding projection.
 */
export function computePCA(vectors: number[][]): { x: number; y: number }[] {
  const n = vectors.length;
  if (n === 0) return [];
  const dim = vectors[0]!.length;
  if (n === 1) return [{ x: 0.5, y: 0.5 }];

  // 1. Compute column means
  const means = new Array(dim).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < dim; j++) {
      means[j]! += vectors[i]![j]!;
    }
  }
  for (let j = 0; j < dim; j++) means[j]! /= n;

  // 2. Center data
  const centered = vectors.map(v => v.map((val, j) => val - means[j]!));

  // 3. Compute covariance matrix (dim x dim), upper triangle
  const cov: number[][] = Array.from({ length: dim }, () => new Array(dim).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < dim; j++) {
      for (let k = j; k < dim; k++) {
        cov[j]![k]! += centered[i]![j]! * centered[i]![k]!;
      }
    }
  }
  for (let j = 0; j < dim; j++) {
    for (let k = j; k < dim; k++) {
      cov[j]![k]! /= n - 1;
    }
  }

  // 4. Power iteration to find top-2 eigenvectors
  const pc1 = powerIteration(cov, dim, 50);

  // Deflate: subtract PC1's contribution to find PC2
  const deflated = cov.map((row, i) => {
    const pc1DotRow = pc1.reduce((sum, v, idx) => sum + v * cov[i]![idx]!, 0);
    const pc1NormSq = pc1.reduce((sum, v) => sum + v * v, 0);
    return row.map((val, j) => val - (pc1DotRow / pc1NormSq) * pc1[j]!);
  });
  const pc2 = powerIteration(deflated, dim, 50);

  // 5. Project centered data onto PCs
  const projected = centered.map(v => ({
    x: v.reduce((sum, val, j) => sum + val * pc1[j]!, 0),
    y: v.reduce((sum, val, j) => sum + val * pc2[j]!, 0),
  }));

  // 6. Normalize to [0, 1]
  const xs = projected.map(p => p.x);
  const ys = projected.map(p => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;

  return projected.map(p => ({
    x: (p.x - minX) / rangeX,
    y: (p.y - minY) / rangeY,
  }));
}

/** Power iteration to find the dominant eigenvector of a symmetric matrix. */
function powerIteration(matrix: number[][], dim: number, maxIter: number): number[] {
  let v = new Array(dim).fill(0).map(() => Math.random() * 2 - 1);
  const normalize = (vec: number[]) => {
    const len = Math.sqrt(vec.reduce((s, val) => s + val * val, 0));
    return len > 1e-10 ? vec.map(val => val / len) : vec;
  };

  for (let iter = 0; iter < maxIter; iter++) {
    const w = new Array(dim).fill(0);
    for (let i = 0; i < dim; i++) {
      for (let j = 0; j < dim; j++) {
        w[i]! += matrix[i]![j]! * v[j]!;
      }
    }
    v = normalize(w);
    if (iter > 5) {
      const change = Math.sqrt(v.reduce((s, val, i) => s + (val - w[i]!) * (val - w[i]!), 0));
      if (change < 1e-6) break;
    }
  }
  return v;
}
