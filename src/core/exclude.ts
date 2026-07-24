import { Minimatch } from "minimatch";

const GLOB_MAGIC = /[*?{}()\[\]]/;

export interface ExcludeMatcher {
  excluded(relPath: string): boolean;
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
