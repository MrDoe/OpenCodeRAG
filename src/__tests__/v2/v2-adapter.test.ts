import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractContentText, extractStructuredOutput } from "../../v2/v2-adapter.js";

describe("extractStructuredOutput", () => {
  it("reads the shell tool's raw output field", () => {
    // The shell tool reports `{ exit, truncated, output, status }`.
    assert.equal(
      extractStructuredOutput({ exit: 9, truncated: false, output: "boom\n", status: "completed" }),
      "boom\n",
    );
  });

  it("returns undefined when there is no text", () => {
    assert.equal(extractStructuredOutput({ exit: 0 }), undefined);
    assert.equal(extractStructuredOutput(undefined), undefined);
    assert.equal(extractStructuredOutput("plain"), undefined);
  });
});

describe("extractContentText", () => {
  it("joins the text parts of a content array", () => {
    // Measured live 2026-10-21: the shell tool returns one text part per
    // output line plus a separate part for the `Exited with code N` marker.
    const content = [
      { type: "text", text: "build failed\n" },
      { type: "text", text: "Exited with code 9" },
    ];
    assert.equal(extractContentText(content), "build failed\n\nExited with code 9");
  });

  it("returns a string content unchanged", () => {
    assert.equal(extractContentText("plain text"), "plain text");
  });

  it("returns undefined when there is no text", () => {
    assert.equal(extractContentText([]), undefined);
    assert.equal(extractContentText(undefined), undefined);
    assert.equal(extractContentText([{ type: "image" }]), undefined);
  });
});
