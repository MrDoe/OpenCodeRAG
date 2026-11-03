import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { shouldLaunchSetupUi } from "../../cli/setup-ui.js";
import { registerSetupCommand } from "../../cli/commands/setup.js";

describe("setup → Configuration UI hand-off", () => {
  it("opens the UI for an interactive run", () => {
    assert.equal(shouldLaunchSetupUi({}, true), true);
  });

  it("never opens the UI with --no-ui", () => {
    assert.equal(shouldLaunchSetupUi({ ui: false }, true), false);
  });

  it("never opens the UI for scripted runs (-y)", () => {
    assert.equal(shouldLaunchSetupUi({ yes: true }, true), false);
  });

  it("never opens the UI without a TTY", () => {
    assert.equal(shouldLaunchSetupUi({}, false), false);
  });

  it("registers a --no-ui option on the setup command", () => {
    const program = new Command();
    registerSetupCommand(program);
    const setup = program.commands.find((cmd) => cmd.name() === "setup");
    assert.ok(setup, "setup command should be registered");
    assert.ok(
      setup.options.some((option) => option.long === "--no-ui"),
      "setup should expose --no-ui",
    );
  });
});
