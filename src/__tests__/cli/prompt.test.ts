import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { ReadlinePrompter } from "../../cli/prompt.js";

function createTestPrompter(): { input: PassThrough; prompter: ReadlinePrompter } {
  const input = new PassThrough();
  const output = new PassThrough();
  const prompter = new ReadlinePrompter(
    input as unknown as NodeJS.ReadStream,
    output as unknown as NodeJS.WriteStream,
  );
  return { input, prompter };
}

/** Reject instead of hanging the test file when a prompt never resolves. */
function withTimeout<T>(promise: Promise<T>, ms = 2000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("prompt did not resolve")), ms);
      timer.unref?.();
    }),
  ]);
}

describe("readline prompter", () => {
  it("replays several pasted answers instead of dropping them", async () => {
    const { input, prompter } = createTestPrompter();
    try {
      // A paste (or a piped/pty script) delivers every line at once, then EOF.
      input.write("alice\nbob\n");
      input.end();
      assert.equal(await withTimeout(prompter.text({ message: "First name" })), "alice");
      assert.equal(await withTimeout(prompter.text({ message: "Second name" })), "bob");
      assert.equal(await withTimeout(prompter.text({ message: "Third name" })), undefined);
    } finally {
      prompter.close();
    }
  });

  it("consumes buffered lines for confirm and select", async () => {
    const { input, prompter } = createTestPrompter();
    try {
      input.write("n\n2\n");
      assert.equal(await withTimeout(prompter.confirm({ message: "Continue?", defaultValue: true })), false);
      assert.equal(
        await withTimeout(
          prompter.select({
            message: "Pick one",
            options: [
              { label: "a", value: "a" },
              { label: "b", value: "b" },
            ],
          }),
        ),
        "b",
      );
    } finally {
      prompter.close();
    }
  });

  it("resolves a pending question with undefined on close", async () => {
    const { prompter } = createTestPrompter();
    const pending = prompter.text({ message: "Name" });
    await new Promise((resolve) => setImmediate(resolve));
    prompter.close();
    assert.equal(await withTimeout(pending), undefined);
  });

  it("resolves pending questions with undefined when stdin ends", async () => {
    const { input, prompter } = createTestPrompter();
    try {
      const pending = prompter.text({ message: "Name" });
      await new Promise((resolve) => setImmediate(resolve));
      input.end();
      assert.equal(await withTimeout(pending), undefined);
    } finally {
      prompter.close();
    }
  });
});
