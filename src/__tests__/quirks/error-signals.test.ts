import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectOutputError,
  detectSessionError,
  extractErrorMessage,
  extractExitCode,
  stripAnsi,
} from "../../quirks/error-signals.js";

/**
 * The output shape OpenCode's shell tool produces for a failing command,
 * captured live on 2026-10-21 (the marker is emitted in red, hence the ANSI
 * codes).
 */
const SHELL_FAILURE = "some command output\n\n\u001b[31mExited with code 3\u001b[0m";

describe("detectOutputError", () => {
  it("detects a non-zero exit code reported by the shell tool", () => {
    const detected = detectOutputError("shell", SHELL_FAILURE);
    assert.ok(detected, "expected a detection");
    assert.equal(detected.source, "output");
    assert.equal(detected.tool, "shell");
    assert.equal(detected.causeClass, "exit-code");
    assert.match(detected.text, /Exited with code 3/);
  });

  it("keeps the command's own error output as the message", () => {
    const detected = detectOutputError("shell", "ls: cannot access '/nope': No such file or directory\n\nExited with code 2");
    assert.ok(detected);
    assert.match(detected.text, /cannot access/);
    assert.match(detected.text, /Exited with code 2/);
  });

  it("ignores a zero exit code", () => {
    assert.equal(detectOutputError("shell", "all good\n\nExited with code 0"), undefined);
  });

  it("detects an ENOENT in the output", () => {
    const detected = detectOutputError("shell", "cat: /missing: No such file or directory\nENOENT: no such file or directory");
    assert.ok(detected);
    assert.equal(detected.causeClass, "path");
    assert.match(detected.text, /ENOENT/);
  });

  it("detects a permission failure", () => {
    const detected = detectOutputError("shell", "EACCES: permission denied, open '/etc/shadow'");
    assert.ok(detected);
    assert.equal(detected.causeClass, "permissions");
  });

  it("detects a python traceback", () => {
    const detected = detectOutputError("shell", "Traceback (most recent call last):\n  File \"x.py\", line 1\nValueError: boom");
    assert.ok(detected);
    assert.equal(detected.causeClass, "runtime");
  });

  it("detects an uncaught JS exception", () => {
    const detected = detectOutputError("shell", "TypeError: x is not a function\n    at foo (a.js:1:1)");
    assert.ok(detected);
    assert.equal(detected.causeClass, "runtime");
  });

  it("detects an npm failure", () => {
    const detected = detectOutputError("shell", "npm ERR! code ERESOLVE\nnpm ERR! unable to resolve dependency tree");
    assert.ok(detected);
    assert.equal(detected.causeClass, "tooling");
  });

  it("detects a process crash", () => {
    const detected = detectOutputError("shell", "Segmentation fault (core dumped)");
    assert.ok(detected);
    assert.equal(detected.causeClass, "crash");
  });

  it("does not fire on a non-command tool whose output is file content", () => {
    // Measured live 2026-10-21: a `grep` whose match mentioned EACCES and a
    // `read` of a file documenting "EACCES / EPERM" were both reported as
    // failures — and each wrote a quirk. The text rules describe a failed
    // COMMAND; file content is not that.
    const fileContent =
      "| `EACCES` / `EPERM` | `permissions` | — the path may need different permissions";
    assert.equal(detectOutputError("grep", fileContent), undefined);
    assert.equal(detectOutputError("read", fileContent), undefined);
    assert.equal(detectOutputError("search_semantic", "ENOENT no such file or directory"), undefined);
  });

  it("still detects the plugin's own read failure", () => {
    const detected = detectOutputError("read", "Could not read file: ENOENT: no such file or directory");
    assert.ok(detected);
    assert.equal(detected.causeClass, "path");
  });

  it("does not fire on ordinary output", () => {
    assert.equal(detectOutputError("shell", "total 42\nREADME.md\n"), undefined);
  });

  it("does not fire on a generic 'Error:' line — false positives are expensive", () => {
    assert.equal(detectOutputError("shell", "Error: expected a value"), undefined);
  });

  it("does not fire on the word 'error' in prose", () => {
    assert.equal(detectOutputError("shell", "handling error cases gracefully\nerror handling is documented"), undefined);
  });

  it("does not fire on an empty output", () => {
    assert.equal(detectOutputError("shell", ""), undefined);
    assert.equal(detectOutputError("shell", "   \n  "), undefined);
  });

  it("ignores a marker that is not on its own line", () => {
    // The marker only counts when it stands on its own line — otherwise a
    // command that merely PRINTS the phrase would be a false positive.
    assert.equal(detectOutputError("shell", "grep -r 'Exited with code 3' ."), undefined);
  });

  it("treats a structured non-zero exit code as definitive", () => {
    // The shell tool reports the exit code structurally; the text carries no
    // marker at all in that case.
    const detected = detectOutputError("shell", "npm run build\nfail: script exited", { exitCode: 7 });
    assert.ok(detected);
    assert.equal(detected.causeClass, "exit-code");
    assert.match(detected.text, /fail: script exited/);
    assert.match(detected.text, /Exited with code 7/);
  });

  it("ignores a zero exit code even when the text looks like a failure", () => {
    const detected = detectOutputError("shell", "ENOENT in a doc example", { exitCode: 0 });
    assert.equal(detected, undefined);
  });

  it("scans only the tail of a very long output", () => {
    const padding = "x".repeat(30_000);
    // A marker buried at the START of a long output is outside the scanned
    // tail and is not seen.
    assert.equal(detectOutputError("shell", "Exited with code 1\n" + padding), undefined);
    // A marker at the end is found.
    assert.ok(detectOutputError("shell", padding + "\n\nExited with code 1"));
  });
});

describe("extractExitCode", () => {
  it("reads the shell tool's exit field", () => {
    assert.equal(extractExitCode({ status: "completed", truncated: false, exit: 9 }), 9);
  });

  it("reads exitCode", () => {
    assert.equal(extractExitCode({ exitCode: 3 }), 3);
  });

  it("ignores a non-numeric or missing exit", () => {
    assert.equal(extractExitCode({ status: "completed" }), undefined);
    assert.equal(extractExitCode({ exit: "boom" }), undefined);
    assert.equal(extractExitCode(undefined), undefined);
  });
});

describe("stripAnsi", () => {
  it("removes colour codes", () => {
    assert.equal(stripAnsi("\u001b[31mred\u001b[0m"), "red");
  });
});

describe("extractErrorMessage", () => {
  it("reads a string", () => {
    assert.equal(extractErrorMessage("boom"), "boom");
  });

  it("reads a message field", () => {
    assert.equal(extractErrorMessage({ message: "boom" }), "boom");
  });

  it("reads a nested error", () => {
    assert.equal(extractErrorMessage({ error: { message: "boom" } }), "boom");
  });

  it("returns undefined for nothing useful", () => {
    assert.equal(extractErrorMessage(undefined), undefined);
    assert.equal(extractErrorMessage({}), undefined);
  });
});

describe("detectSessionError", () => {
  it("detects a session error with a message", () => {
    const detected = detectSessionError({ name: "ProviderError", message: "model is overloaded" });
    assert.ok(detected);
    assert.equal(detected.source, "session");
    assert.match(detected.text, /model is overloaded/);
  });

  it("ignores a payload with no usable message", () => {
    assert.equal(detectSessionError({}), undefined);
    assert.equal(detectSessionError("   "), undefined);
  });
});
