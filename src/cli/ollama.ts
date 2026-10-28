/**
 * @fileoverview Ollama detection hints shared by `setup` and the wizard.
 */

/**
 * Platform-specific command that installs Ollama.
 *
 * The CLI never installs Ollama itself (it is a native application with a
 * service), but printing the exact command removes the "what now?" step.
 */
export function ollamaInstallHint(): string {
  switch (process.platform) {
    case "win32":
      return "Install it with: winget install Ollama.Ollama";
    case "darwin":
      return "Install it with: brew install ollama (or download it from https://ollama.com)";
    default:
      return "Install it with: curl -fsSL https://ollama.com/install.sh | sh";
  }
}

/** Whether an error message looks like a refused/unreachable Ollama connection. */
export function isOllamaConnectionError(message: string | undefined): boolean {
  if (!message) return false;
  return /connection refused|ECONNREFUSED|fetch failed|cannot reach|not reachable/i.test(message);
}
