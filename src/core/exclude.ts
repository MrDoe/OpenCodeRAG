import { Minimatch } from "minimatch";

const GLOB_MAGIC = /[*?{}()\[\]]/;

export interface ExcludeMatcher {
  excluded(relPath: string): boolean;
}

export interface IncludedMatcher {
  included(relPath: string): boolean;
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
  for (const pattern of patterns) {
    const pat = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (!pat) continue;
    matchers.push(new Minimatch(pat, { nocase: true, dot: true }));
  }
  if (matchers.length === 0) {
    return { included: () => true };
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

  return { included };
}
