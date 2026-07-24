interface Point2D { x: number; y: number; }

function dist(a: Point2D, b: Point2D): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

export function kmeans(points: Point2D[], k: number = 8, maxIter: number = 20): number[] {
  const n = points.length;
  if (n <= k) return points.map((_, i) => i);
  const assignments = new Array(n).fill(0);
  const centroids: Point2D[] = [];

  // k-means++ initialization
  centroids.push(points[Math.floor(Math.random() * n)]!);
  for (let c = 1; c < k; c++) {
    const dists = points.map((p) =>
      Math.min(...centroids.map((cent) => dist(p, cent)))
    );
    const totalDist = dists.reduce((s, d) => s + d * d, 0);
    let r = Math.random() * totalDist;
    for (let i = 0; i < n; i++) {
      r -= dists[i]! * dists[i]!;
      if (r <= 0) { centroids.push(points[i]!); break; }
    }
  }

  for (let iter = 0; iter < maxIter; iter++) {
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestDist = dist(points[i]!, centroids[0]!);
      for (let c = 1; c < centroids.length; c++) {
        const d = dist(points[i]!, centroids[c]!);
        if (d < bestDist) { bestDist = d; best = c; }
      }
      assignments[i] = best;
    }

    const sums = centroids.map(() => ({ x: 0, y: 0, count: 0 }));
    for (let i = 0; i < n; i++) {
      const c = assignments[i]!;
      sums[c]!.x += points[i]!.x;
      sums[c]!.y += points[i]!.y;
      sums[c]!.count++;
    }
    centroids.forEach((cent, i) => {
      if (sums[i]!.count > 0) {
        cent.x = sums[i]!.x / sums[i]!.count;
        cent.y = sums[i]!.y / sums[i]!.count;
      }
    });
  }
  return assignments;
}

export function findOutliers(points: Point2D[], assignments: number[], centroids: Point2D[]): Set<number> {
  const stds = centroids.map((cent, ci) => {
    const clusterPoints = points.filter((_, i) => assignments[i] === ci);
    const dists = clusterPoints.map((p) => dist(p, cent));
    const mean = dists.reduce((s, d) => s + d, 0) / dists.length;
    const variance = dists.reduce((s, d) => s + (d - mean) ** 2, 0) / dists.length;
    return Math.sqrt(variance);
  });

  const outliers = new Set<number>();
  for (let i = 0; i < points.length; i++) {
    const c = assignments[i]!;
    if (dist(points[i]!, centroids[c]!) > 2 * (stds[c] ?? 0)) outliers.add(i);
  }
  return outliers;
}
