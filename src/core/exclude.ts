import { Minimatch } from "minimatch";

const GLOB_MAGIC = /[*?{}()\[\]]/;

export interface ExcludeMatcher {
  excluded(relPath: string): boolean;
}

export interface IncludedMatcher {
  included(relPath: string): boolean;
  shouldTraverse(relDir: string): boolean;
}

export function createExcludeMatcher(patterns: string[]): ExcludeMatcher {
  const plainBasenames = new Set<string>();
  const basenameGlobMatchers: Minimatch[] = [];
  const pathMatchers: Minimatch[] = [];

  for (const pattern of patterns) {
    const pat = pattern.trim().replace(/\\/g, "/");
    if (!pat) continue;

    const hasSep = pat.includes("/");
    const isGlob = GLOB_MAGIC.test(pat);

    if (!hasSep && !isGlob) {
      plainBasenames.add(pat.toLowerCase());
    } else if (!hasSep && isGlob) {
      basenameGlobMatchers.push(new Minimatch(pat, { nocase: true, dot: true }));
    } else {
      pathMatchers.push(new Minimatch(pat, { nocase: true, dot: true }));
    }
  }

  function excluded(relPath: string): boolean {
    const normalized = relPath.replace(/\\/g, "/");
    const segments = normalized.split("/");

    let prefix = "";
    for (const seg of segments) {
      const segLower = seg.toLowerCase();
      prefix = prefix ? `${prefix}/${seg}` : seg;

      if (plainBasenames.has(segLower)) return true;

      for (const mm of basenameGlobMatchers) {
        if (mm.match(seg)) return true;
      }

      for (const mm of pathMatchers) {
        if (mm.match(prefix)) return true;
      }
    }

    return false;
  }

  return { excluded };
}

/**
 * Create a matcher for `indexing.includeDirs`.
 *
 * Semantics differ from {@link createExcludeMatcher}: every pattern is
 * **anchored to the workspace root** — it is matched as a glob against each
 * ancestor prefix of the path, so `docs` includes `<root>/docs` and all its
 * contents, but never a nested `docs` elsewhere in the tree. The workspace
 * root itself (`""`) is always included so a walk can descend into it.
 * Empty pattern lists include everything.
 */
export function createIncludeMatcher(patterns: string[]): IncludedMatcher {
  const matchers: Minimatch[] = [];
  const patternsClean: string[] = [];
  for (const pattern of patterns) {
    const pat = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (!pat) continue;
    patternsClean.push(pat);
    matchers.push(new Minimatch(pat, { nocase: true, dot: true }));
  }
  if (matchers.length === 0) {
    return { included: () => true, shouldTraverse: () => true };
  }

  function included(relPath: string): boolean {
    const normalized = relPath.replace(/\\/g, "/");
    if (!normalized) return true;

    let prefix = "";
    for (const seg of normalized.split("/")) {
      prefix = prefix ? `${prefix}/${seg}` : seg;
      for (const mm of matchers) {
        if (mm.match(prefix) || mm.match(`${prefix}/`)) return true;
      }
    }
    return false;
  }

  function shouldTraverse(relDir: string): boolean {
    const normalized = relDir.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (!normalized) return true;

    // If the directory itself (or an ancestor) matches an include pattern, descend.
    if (included(normalized)) return true;

    // If the directory is an ancestor of ANY pattern, we must descend to reach it
    // (e.g. `infra` is an ancestor of `infra/icarus-observability`).
    const dirPrefix = `${normalized.toLowerCase()}/`;
    for (const pat of patternsClean) {
      const patLower = pat.toLowerCase();
      if (patLower.startsWith(dirPrefix)) return true;
      const firstGlobIdx = patLower.search(GLOB_MAGIC);
      if (firstGlobIdx !== -1) {
        const staticPrefix = patLower.slice(0, firstGlobIdx).replace(/\/+$/, "");
        if (staticPrefix.startsWith(dirPrefix) || staticPrefix === normalized.toLowerCase()) {
          return true;
        }
      }
    }

    return false;
  }

  return { included, shouldTraverse };
}

/**
 * Test whether a file path falls within the current indexing scope.
 *
 * Scoped by both the workspace root (`cwd`) and any active `includeDirs`
 * (e.g. the `-d` option). Accepts paths in either form the codebase produces:
 * absolute paths (from git, and from stores written before paths were
 * relativised) and workspace-relative paths (`normalizeFilePath`'s output).
 *
 * @param filePath    - Path to test; absolute or relative to `cwd`.
 * @param cwd         - Workspace root.
 * @param includeDirs - Optional restrict-to directories, workspace-relative.
 * @returns `true` when the path is inside the workspace and any includeDirs.
 */
export function isInScanScope(filePath: string, cwd: string, includeDirs?: string[]): boolean {
  if (!filePath || !cwd) return false;
  const normPath = filePath.replace(/\\/g, "/");
  const cleanCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "");

  // Relative keys are already anchored at the workspace root; absolute ones
  // must still be checked against it (and yield the relative remainder).
  const isAbsolute = normPath.startsWith("/") || /^[A-Za-z]:\//.test(normPath);
  let rel: string;
  if (isAbsolute) {
    const inCwd = normPath === cleanCwd || normPath.startsWith(cleanCwd + "/");
    if (!inCwd) return false;
    rel = normPath.slice(cleanCwd.length).replace(/^\/+/, "");
  } else {
    // Escaping the workspace root is never in scope.
    if (normPath === ".." || normPath.startsWith("../")) return false;
    rel = normPath;
  }

  if (!includeDirs || includeDirs.length === 0) return true;
  const matcher = createIncludeMatcher(includeDirs);
  return matcher.included(rel);
}
