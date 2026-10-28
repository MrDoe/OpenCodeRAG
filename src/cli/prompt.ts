/**
 * @fileoverview Minimal interactive prompt layer for the `setup` wizard.
 *
 * Deliberately dependency-free: the CLI only needs text input, masked input,
 * yes/no confirmations and a numbered list selection. `@inquirer/prompts`
 * would add a runtime dependency tree for a single command, so this module
 * implements the small subset on top of `node:readline`.
 *
 * Every prompt resolves `undefined` when the user aborts (Ctrl+C, Ctrl+D or a
 * closing stdin). Callers must treat `undefined` as "cancel the wizard" and
 * leave the configuration untouched.
 *
 * Non-TTY safety: {@link createPrompter} returns a non-interactive prompter
 * when stdin is not a TTY, so a piped/CI invocation can never block forever.
 */

import { createInterface } from "node:readline";

/** One selectable entry in {@link Prompter.select}. */
export interface SelectOption<T> {
  /** Text shown to the user. */
  label: string;
  /** Value returned when the entry is picked. */
  value: T;
  /** Optional dimmed second line shown under the label. */
  description?: string;
}

/** Options for {@link Prompter.text}. */
export interface TextPromptOptions {
  /** Question shown to the user. */
  message: string;
  /** Value returned when the user presses Enter without typing anything. */
  defaultValue?: string;
  /** Hint printed under the question (e.g. an example). */
  hint?: string;
  /** Return an error message to re-ask, or `undefined` when the value is valid. */
  validate?: (value: string) => string | undefined;
}

/** Options for {@link Prompter.confirm}. */
export interface ConfirmPromptOptions {
  /** Question shown to the user. */
  message: string;
  /** Answer used when the user presses Enter without typing anything. Defaults to `true`. */
  defaultValue?: boolean;
}

/** Options for {@link Prompter.select}. */
export interface SelectPromptOptions<T> {
  /** Question shown to the user. */
  message: string;
  /** Entries to choose from. */
  options: readonly SelectOption<T>[];
  /** Index selected when the user presses Enter without typing anything. Defaults to the first entry. */
  defaultIndex?: number;
  /** Entries per page. Larger lists are paged with `n`/`p`. Defaults to 15. */
  pageSize?: number;
  /** Extra hint printed above the list. */
  hint?: string;
}

/**
 * The prompt surface used by the setup wizard.
 *
 * All methods resolve `undefined` when the user cancels; a canceled wizard
 * must not write any configuration.
 */
export interface Prompter {
  /** Whether this prompter can actually interact with a user. */
  readonly interactive: boolean;
  /** Ask for a line of text. */
  text(options: TextPromptOptions): Promise<string | undefined>;
  /** Ask for a secret (input is masked on a TTY). */
  password(message: string): Promise<string | undefined>;
  /** Ask a yes/no question. */
  confirm(options: ConfirmPromptOptions): Promise<boolean | undefined>;
  /** Pick one of a list of entries (numbered menu, `n`/`p` to page). */
  select<T>(options: SelectPromptOptions<T>): Promise<T | undefined>;
  /** Release any resources held by the prompter. Safe to call twice. */
  close(): void;
}

/** Whether the process is attached to an interactive terminal. */
export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY) && process.stdout.isTTY !== false;
}

/**
 * A prompter for non-interactive runs.
 *
 * It never reads stdin; `text`/`select`/`password` resolve the supplied
 * default (or `undefined` when there is none) and `confirm` resolves its
 * default. `interactive` is `false` so callers can skip the wizard entirely.
 */
class NonInteractivePrompter implements Prompter {
  readonly interactive = false;

  async text(options: TextPromptOptions): Promise<string | undefined> {
    return options.defaultValue;
  }

  async password(): Promise<string | undefined> {
    return undefined;
  }

  async confirm(options: ConfirmPromptOptions): Promise<boolean | undefined> {
    return options.defaultValue ?? true;
  }

  async select<T>(options: SelectPromptOptions<T>): Promise<T | undefined> {
    const index = options.defaultIndex ?? 0;
    return options.options[index]?.value;
  }

  close(): void {
    // Nothing to release.
  }
}

/**
 * Write a line to stdout, tolerating a closed/broken pipe.
 *
 * The wizard must not crash when stdout is redirected to a closed pager.
 */
function writeLine(output: NodeJS.WriteStream, line: string): void {
  try {
    output.write(line);
  } catch {
    // Ignore EPIPE — the caller is already gone.
  }
}

/**
 * Prompt implementation backed by `node:readline`.
 *
 * A readline interface is created lazily for each text/select prompt and
 * closed in a `finally` block; this keeps cancellation (SIGINT) and terminal
 * state predictable even when the user aborts halfway through the wizard.
 */
class ReadlinePrompter implements Prompter {
  readonly interactive = true;

  constructor(
    private readonly input: NodeJS.ReadStream,
    private readonly output: NodeJS.WriteStream,
  ) {}

  /** Ask one line, resolving `undefined` on abort. */
  private ask(question: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      const rl = createInterface({ input: this.input, output: this.output, terminal: true });
      let settled = false;
      const finish = (value: string | undefined): void => {
        if (settled) return;
        settled = true;
        rl.close();
        resolve(value);
      };
      rl.once("SIGINT", () => {
        writeLine(this.output, "\n");
        finish(undefined);
      });
      rl.once("close", () => finish(undefined));
      rl.question(question, (answer) => finish(answer));
    });
  }

  async text(options: TextPromptOptions): Promise<string | undefined> {
    const suffix = options.defaultValue !== undefined && options.defaultValue !== ""
      ? ` [${options.defaultValue}]`
      : "";
    if (options.hint) writeLine(this.output, `  ${options.hint}\n`);
    for (;;) {
      const answer = await this.ask(`  ${options.message}${suffix}: `);
      if (answer === undefined) return undefined;
      const value = answer.trim() === "" ? (options.defaultValue ?? "") : answer.trim();
      const error = options.validate?.(value);
      if (error) {
        writeLine(this.output, `  ${error}\n`);
        continue;
      }
      return value;
    }
  }

  async password(message: string): Promise<string | undefined> {
    if (!this.input.isTTY || typeof this.input.setRawMode !== "function") {
      // Piped stdin: read a plain line (still masked in the transcript by the caller).
      return this.ask(`  ${message}: `);
    }

    writeLine(this.output, `  ${message}: `);
    this.input.setRawMode(true);
    this.input.resume();
    return new Promise((resolve) => {
      let value = "";
      const cleanup = (): void => {
        this.input.removeListener("data", onData);
        this.input.setRawMode(false);
        this.input.pause();
        writeLine(this.output, "\n");
      };
      const onData = (chunk: Buffer): void => {
        const text = chunk.toString("utf8");
        for (const char of text) {
          if (char === "\u0003") {
            cleanup();
            resolve(undefined);
            return;
          }
          if (char === "\r" || char === "\n") {
            cleanup();
            resolve(value);
            return;
          }
          if (char === "\u007f" || char === "\b") {
            if (value.length > 0) {
              value = value.slice(0, -1);
              writeLine(this.output, "\b \b");
            }
            continue;
          }
          if (char >= " ") {
            value += char;
            writeLine(this.output, "*");
          }
        }
      };
      this.input.on("data", onData);
    });
  }

  async confirm(options: ConfirmPromptOptions): Promise<boolean | undefined> {
    const hint = options.defaultValue === false ? "y/N" : "Y/n";
    for (;;) {
      const answer = await this.ask(`  ${options.message} (${hint}): `);
      if (answer === undefined) return undefined;
      const normalized = answer.trim().toLowerCase();
      if (normalized === "") return options.defaultValue ?? true;
      if (normalized === "y" || normalized === "yes") return true;
      if (normalized === "n" || normalized === "no") return false;
      writeLine(this.output, "  Please answer y or n.\n");
    }
  }

  async select<T>(options: SelectPromptOptions<T>): Promise<T | undefined> {
    const all = options.options;
    if (all.length === 0) return undefined;
    const pageSize = Math.max(1, options.pageSize ?? 15);
    const defaultIndex = Math.min(Math.max(options.defaultIndex ?? 0, 0), all.length - 1);
    let start = Math.floor(defaultIndex / pageSize) * pageSize;

    if (options.hint) writeLine(this.output, `  ${options.hint}\n`);

    for (;;) {
      const end = Math.min(start + pageSize, all.length);
      writeLine(this.output, "");
      for (let i = start; i < end; i += 1) {
        const entry = all[i];
        if (!entry) continue;
        const marker = i === defaultIndex ? "*" : " ";
        const label = `${marker} ${i + 1}) ${entry.label}`;
        writeLine(this.output, `  ${label}\n`);
        if (entry.description) {
          writeLine(this.output, `       ${entry.description}\n`);
        }
      }
      const nav: string[] = [];
      if (start > 0) nav.push("p = previous page");
      if (end < all.length) nav.push("n = next page");
      nav.push("number = choose");
      if (all.length > 1) nav.push("Enter = default (*)");
      writeLine(this.output, `  ${nav.join(" · ")}\n`);

      const answer = await this.ask(`  ${options.message}: `);
      if (answer === undefined) return undefined;
      const value = answer.trim().toLowerCase();
      if (value === "") return all[defaultIndex]?.value;
      if (value === "n" && end < all.length) {
        start = Math.min(start + pageSize, all.length - 1);
        continue;
      }
      if (value === "p" && start > 0) {
        start = Math.max(0, start - pageSize);
        continue;
      }
      const index = Number.parseInt(value, 10);
      if (Number.isInteger(index) && index >= 1 && index <= all.length) {
        return all[index - 1]?.value;
      }
      // Accept the literal value too (e.g. a model name typed by hand).
      const exact = all.find((entry) => String(entry.value) === answer.trim());
      if (exact !== undefined) return exact.value;
      writeLine(this.output, "  Not a valid selection.\n");
    }
  }

  close(): void {
    // Interfaces are per-prompt; nothing persistent to release.
  }
}

/**
 * Create a prompter for the current process.
 *
 * When `interactive` is false (or stdin is not a TTY), a non-interactive
 * prompter is returned — the wizard then applies defaults instead of hanging.
 */
export function createPrompter(interactive: boolean = isInteractiveTerminal()): Prompter {
  if (!interactive) return new NonInteractivePrompter();
  return new ReadlinePrompter(process.stdin, process.stdout);
}
