import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassProgress } from "../../indexer/progress.js";

describe("PassProgress (whole-pass percentage)", () => {
	it("is 100% for a pass with no active files", () => {
		const p = new PassProgress(0);
		assert.equal(p.percent, 100);
		assert.equal(p.label, "100.0%");
		const w = p.beginWindow(0);
		w.fill("describe");
		assert.equal(p.percent, 100);
	});

	it("credits each stage as one quarter of every window file", () => {
		const p = new PassProgress(8);
		const w1 = p.beginWindow(4);
		for (let i = 0; i < 4; i++) w1.chunkFile();
		assert.equal(p.percent, 12.5, "4 files × chunk quarter of 8 total");
		w1.fill("describe");
		assert.equal(p.percent, 25);
		w1.fill("embed");
		assert.equal(p.percent, 37.5);
		w1.stage("store", 4, 4);
		assert.equal(p.percent, 50);
		const w2 = p.beginWindow(4);
		for (let i = 0; i < 4; i++) w2.chunkFile();
		w2.fill("describe");
		w2.fill("embed");
		w2.stage("store", 4, 4);
		assert.equal(p.percent, 100);
	});

	it("advances the describe stage proportionally to its work queue", () => {
		const p = new PassProgress(4);
		const w = p.beginWindow(4);
		w.stage("describe", 1, 4);
		assert.equal(p.percent, 6.25, "one quarter of the describe quarter");
		w.stage("describe", 2, 4);
		assert.equal(p.percent, 12.5);
	});

	it("fills the stage credit when a stage has no work (total 0)", () => {
		const p = new PassProgress(4);
		const w = p.beginWindow(4);
		w.stage("describe", 0, 0);
		assert.equal(p.percent, 25, "an empty stage is a completed stage");
	});

	it("never moves backwards on repeated or out-of-order callbacks", () => {
		const p = new PassProgress(4);
		const w = p.beginWindow(4);
		w.stage("embed", 3, 4);
		assert.equal(p.percent, 18.75, "3/4 of the embed quarter of 4 files");
		w.stage("embed", 1, 4);
		w.stage("embed", 3, 4);
		w.fill("embed");
		w.fill("embed");
		assert.equal(p.percent, 25, "only the forward delta from 3/4 to 4/4 is credited");
	});

	it("clamps overshooting counters and caps the percentage at 100", () => {
		const p = new PassProgress(2);
		const w = p.beginWindow(2);
		w.chunkFile();
		w.chunkFile();
		w.chunkFile();
		assert.equal(p.percent, 25, "third chunkFile of a 2-file window is ignored");
		w.stage("store", 10, 2);
		assert.equal(p.percent, 50, "done > total is treated as done === total");
		w.fill("describe");
		w.fill("embed");
		assert.equal(p.percent, 100);
		const p2 = new PassProgress(1);
		const w2 = p2.beginWindow(4);
		w2.fill("describe");
		w2.fill("embed");
		w2.fill("store");
		assert.equal(p2.percent, 100, "window larger than the pass total still caps at 100");
	});

	it("stays monotonic when windows interleave (store overlapping the next window)", () => {
		const p = new PassProgress(6);
		const w1 = p.beginWindow(3);
		const w2 = p.beginWindow(3);
		let last = -1;
		const assertMonotonic = (step: string) => {
			assert.ok(p.percent >= last, `${step}: percent went backwards`);
			last = p.percent;
		};
		w1.stage("embed", 1, 3);
		assertMonotonic("w1 embed 1/3");
		w2.chunkFile();
		assertMonotonic("w2 chunk 1");
		w1.stage("store", 1, 2);
		assertMonotonic("w1 store 1/2");
		w1.stage("embed", 3, 3);
		assertMonotonic("w1 embed done (late, after store started)");
		w2.fill("describe");
		assertMonotonic("w2 describe");
		w1.fill("embed");
		assertMonotonic("w1 embed fill");
		w1.stage("store", 2, 2);
		assertMonotonic("w1 store done");
	});
});
