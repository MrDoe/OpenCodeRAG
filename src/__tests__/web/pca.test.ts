import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computePCA } from "../../web/pca.js";

describe("computePCA", () => {
  it("returns 2D points by default, normalized per-axis to [0, 1]", () => {
    // Data with a clear dominant axis along [1,1]
    const vectors = Array.from({ length: 50 }, (_, i) => [i, i + 0.5, i % 3]);
    const out = computePCA(vectors);

    assert.equal(out.length, 50);
    for (const p of out) {
      assert.equal(typeof p.x, "number");
      assert.equal(typeof p.y, "number");
      assert.equal(p.z, undefined);
      assert.ok(p.x >= 0 && p.x <= 1);
      assert.ok(p.y >= 0 && p.y <= 1);
    }
    // Per-axis normalization maps both extremes onto [0, 1]
    assert.deepEqual(Math.min(...out.map(p => p.x)), 0);
    assert.deepEqual(Math.max(...out.map(p => p.x)), 1);
    assert.deepEqual(Math.min(...out.map(p => p.y)), 0);
    assert.deepEqual(Math.max(...out.map(p => p.y)), 1);
  });

  it("returns 3D points with z when dims=3, normalized to a unit cube", () => {
    const vectors = Array.from({ length: 50 }, (_, i) => [i, i + 0.5, -i, i % 3]);
    const out = computePCA(vectors, 3);

    assert.equal(out.length, 50);
    for (const p of out) {
      assert.equal(typeof p.x, "number");
      assert.equal(typeof p.y, "number");
      assert.equal(typeof p.z, "number");
      assert.ok(p.x >= 0 && p.x <= 1);
      assert.ok(p.y >= 0 && p.y <= 1);
      assert.ok(p.z! >= 0 && p.z! <= 1);
    }
    // Max-extent normalization: the dominant axis spans [0, 1]
    const ranges = [
      Math.max(...out.map(p => p.x)) - Math.min(...out.map(p => p.x)),
      Math.max(...out.map(p => p.y)) - Math.min(...out.map(p => p.y)),
      Math.max(...out.map(p => p.z!)) - Math.min(...out.map(p => p.z!)),
    ];
    assert.ok(Math.abs(Math.max(...ranges) - 1) < 1e-6);
  });

  it("returns 2D points for dims=3 request on 2-dimensional input", () => {
    const out = computePCA([[1, 2], [3, 4], [5, 6]], 3);
    assert.equal(out.length, 3);
    assert.ok(out.every(p => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1));
  });

  it("handles empty and single-vector input", () => {
    assert.deepEqual(computePCA([]), []);
    assert.deepEqual(computePCA([[1, 2, 3]]), [{ x: 0.5, y: 0.5 }]);
    assert.deepEqual(computePCA([[1, 2, 3]], 3), [{ x: 0.5, y: 0.5, z: 0.5 }]);
  });

  it("handles zero-variance (constant) input without dividing by zero", () => {
    const out = computePCA([[2, 2], [2, 2], [2, 2]], 3);
    assert.equal(out.length, 3);
    for (const p of out) {
      assert.ok(Number.isFinite(p.x));
      assert.ok(Number.isFinite(p.y));
      assert.ok(Number.isFinite(p.z));
    }
  });

  it("preserves relative ordering along the dominant direction in 3D", () => {
    // Points lie on a line in 3D: x = y = z scaled by i
    const vectors = Array.from({ length: 20 }, (_, i) => [i, i, i]);
    const out = computePCA(vectors, 3);
    const xs = out.map(p => p.x);
    // PC1 is sign-ambiguous, so check the ordering is monotone either way
    const deltas = xs.slice(1).map((v, i) => v - xs[i]!);
    assert.ok(
      deltas.every(d => d >= 0) || deltas.every(d => d <= 0),
      "x should be monotone along the dominant direction"
    );
    // A 1-D dataset has zero variance on PC2/PC3
    const zs = out.map(p => p.z!);
    assert.ok(Math.abs(zs[0]! - zs[19]!) < 1e-3, "z is near-constant for a 1-D dataset");
  });
});
