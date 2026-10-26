import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { optimizeDue, resetOptimizeThrottle, MIN_OPTIMIZE_INTERVAL_MS } from "../../indexer/pipeline.js";

describe("optimizeDue (store optimize throttle)", () => {
	beforeEach(() => resetOptimizeThrottle());

	it("allows the first run and blocks runs inside the interval", () => {
		const t0 = 1_000_000;
		assert.equal(optimizeDue({ now: t0 }), true);
		assert.equal(optimizeDue({ now: t0 + 1000 }), false);
		assert.equal(optimizeDue({ now: t0 + MIN_OPTIMIZE_INTERVAL_MS - 1 }), false);
		assert.equal(optimizeDue({ now: t0 + MIN_OPTIMIZE_INTERVAL_MS }), true);
	});

	it("always allows a forced (aggressive) run and restarts the interval", () => {
		const t0 = 2_000_000;
		assert.equal(optimizeDue({ now: t0 }), true);
		assert.equal(optimizeDue({ now: t0 + 1, force: true }), true);
		assert.equal(optimizeDue({ now: t0 + 2 }), false, "a forced run must restart the interval");
	});

	it("caps optimize runs at four per hour", () => {
		const start = 5_000_000;
		let allowed = 0;
		for (let minute = 0; minute < 60; minute++) {
			if (optimizeDue({ now: start + minute * 60_000 })) allowed++;
		}
		assert.equal(allowed, 4, "minute 0 plus one run every 15 minutes");
	});
});
