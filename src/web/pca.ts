/**
 * Self-contained, zero-dependency PCA implementation for embedding projection.
 * Supports projecting to 2 or 3 dimensions (top-K eigenvectors via power
 * iteration + deflation).
 */
export function computePCA(vectors: number[][], dims: 2 | 3 = 2): { x: number; y: number; z?: number }[] {
  const n = vectors.length;
  if (n === 0) return [];
  const dim = vectors[0]!.length;
  if (n === 1) return dims === 3 ? [{ x: 0.5, y: 0.5, z: 0.5 }] : [{ x: 0.5, y: 0.5 }];

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

  // 3. Compute covariance matrix (dim x dim); fill the upper triangle then
  // mirror it so the matrix is symmetric (power iteration needs a symmetric
  // operator to find the true principal axes).
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
      cov[k]![j]! = cov[j]![k]!;
    }
  }

  // 4. Find the top-K eigenvectors: power iteration, then deflate the
  // covariance by each discovered eigenvector before finding the next.
  // Once the remaining matrix is numerically ~zero (degenerate / low-rank
  // input), the rest of the PCs are zero vectors — this keeps PC2/PC3 from
  // picking up deflation noise and avoids NaN from a 0/0 deflation.
  const pcs: number[][] = [];
  let deflated = cov;
  const threshold = maxAbs(cov) * 1e-12;
  for (let pc = 0; pc < dims; pc++) {
    if (maxAbs(deflated) <= threshold) {
      pcs.push(new Array(dim).fill(0));
      continue;
    }
    const eigen = powerIteration(deflated, dim, 50);
    pcs.push(eigen);
    deflated = deflate(deflated, eigen);
  }

  // 5. Project centered data onto the PCs
  const projected = centered.map(v => {
    const point: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
    for (let pc = 0; pc < dims; pc++) {
      const s = v.reduce((sum, val, j) => sum + val * pcs[pc]![j]!, 0);
      if (pc === 0) point.x = s;
      else if (pc === 1) point.y = s;
      else point.z = s;
    }
    return point;
  });

  // 6. Normalize to [0, 1]. 2D keeps per-axis normalization (unchanged);
  // 3D uses the max extent across all axes so the cube stays proportional.
  const xs = projected.map(p => p.x);
  const ys = projected.map(p => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;

  if (dims === 2) {
    return projected.map(p => ({
      x: (p.x - minX) / rangeX,
      y: (p.y - minY) / rangeY,
    }));
  }

  const zs = projected.map(p => p.z);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const maxRange = Math.max(rangeX, rangeY, maxZ - minZ || 1);

  return projected.map(p => ({
    x: (p.x - minX) / maxRange,
    y: (p.y - minY) / maxRange,
    z: (p.z - minZ) / maxRange,
  }));
}

/** Subtract the outer-product contribution of a principal component from a symmetric matrix. */
function deflate(matrix: number[][], pc: number[]): number[][] {
  const pcNormSq = pc.reduce((sum, v) => sum + v * v, 0);
  return matrix.map((row, i) => {
    const pcDotRow = pc.reduce((sum, v, idx) => sum + v * matrix[i]![idx]!, 0);
    const scale = pcNormSq > 1e-12 ? pcDotRow / pcNormSq : 0;
    return row.map((val, j) => val - scale * pc[j]!);
  });
}

/** Largest absolute entry of a matrix. */
function maxAbs(matrix: number[][]): number {
  let m = 0;
  for (const row of matrix) {
    for (const val of row) {
      const abs = Math.abs(val);
      if (abs > m) m = abs;
    }
  }
  return m;
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
