import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getDescriptionThinkingWarning } from "../../indexer/pipeline.js";

describe("getDescriptionThinkingWarning", () => {
  it("warns when think is explicitly true", () => {
    const warning = getDescriptionThinkingWarning({ provider: "openai", think: true });
    assert.ok(warning, "expected a warning");
    assert.ok(warning.includes("description.think=true"));
    assert.ok(warning.includes("description.think=false"));
  });

  it("warns for OpenAI-compatible providers when think is unset (model default applies)", () => {
    const warning = getDescriptionThinkingWarning({ provider: "openai" });
    assert.ok(warning, "expected a warning");
    assert.ok(warning.includes("description.think=unset"));
  });

  it("warns for Ollama when think is explicitly true", () => {
    const warning = getDescriptionThinkingWarning({ provider: "ollama", think: true });
    assert.ok(warning, "expected a warning");
  });

  it("does not warn when think is false", () => {
    assert.equal(getDescriptionThinkingWarning({ provider: "openai", think: false }), null);
  });

  it("does not warn for Ollama default (thinking off by default)", () => {
    assert.equal(getDescriptionThinkingWarning({ provider: "ollama" }), null);
  });

  it("does not warn without a description config", () => {
    assert.equal(getDescriptionThinkingWarning(undefined), null);
  });
});
