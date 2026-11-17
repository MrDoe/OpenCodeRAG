/**
 * @fileoverview Parses wiki pages — frontmatter, `[[wikilinks]]`, titles.
 *
 * Pure functions over strings: no filesystem access here (scanning lives in
 * `graph.ts`). The frontmatter reader is deliberately minimal — the wiki
 * protocol (built-in `wikiMode.systemPrompt`) defines exactly four keys, so a
 * purpose-built parser beats a YAML dependency.
 *
 * Link extraction ignores fenced code blocks and inline code spans: the wiki
 * protocol and doc-style pages quote literal `[[wiki/page-name]]` examples,
 * and counting those as links would poison every orphan/dangling report.
 */

/** A single `[[target]]`, `[[target|alias]]` or `[[target#anchor]]` link. */
export interface WikiLink {
  /** Text inside the brackets, as written (e.g. `wiki/plugin#usage`). */
  raw: string;
  /** Link target without alias/anchor, trimmed (e.g. `wiki/plugin`). */
  target: string;
  /** Optional `#section` suffix. */
  anchor?: string;
  /** Optional `|display text` suffix. */
  alias?: string;
}

/** One problem found while parsing a page's frontmatter block. */
export interface FrontmatterIssue {
  key?: string;
  message: string;
}

/** Frontmatter of a wiki page, parsed against the four protocol keys. */
export interface ParsedFrontmatter {
  /** Whether a `---` delimited block was present at the top of the file. */
  present: boolean;
  title?: string;
  tags: string[];
  sourceRefs: string[];
  /** Raw `lastReviewed` value as written (kept for display). */
  lastReviewedRaw?: string;
  /** Parsed `lastReviewed` as epoch milliseconds, or undefined when unparseable. */
  lastReviewedMs?: number;
  /** Parse problems (missing/placeholder date, duplicate key, unknown shape). */
  issues: FrontmatterIssue[];
}

/** A parsed wiki page: metadata, links, and the first H1 title if any. */
export interface ParsedWikiPage {
  frontmatter: ParsedFrontmatter;
  /** Best display title: frontmatter title → first `# heading` → file name. */
  headingTitle?: string;
  /** Links in document order, fenced code and inline code excluded. */
  links: WikiLink[];
  /** Number of inbound/outbound-relevant non-empty links (diagnostics). */
  wordCount: number;
}

/**
 * Normalize a path or link target for comparison: posix separators, no
 * `.md`/`.markdown` suffix, no leading `.opencode/wiki/`, `wiki/` or `./`
 * prefix, lowercased. `entities/plugin.md`, `wiki/entities/plugin` and
 * `.opencode/wiki/entities/plugin` all normalize to `entities/plugin`.
 *
 * @param target - A path or wikilink target.
 * @returns The normalized page id, or an empty string when nothing remains.
 */
export function normalizePageId(target: string): string {
  let id = target.trim().replace(/\\/g, "/");
  id = id.replace(/\.(md|markdown)$/i, "");
  id = id.replace(/^\.\//, "");
  id = id.replace(/^(\.opencode\/)?wiki\//i, "");
  id = id.replace(/\/+$/, "").replace(/^\/+/, "");
  return id.toLowerCase();
}

/**
 * Extract the basename of a normalized page id (`entities/plugin` → `plugin`).
 *
 * @param pageId - A normalized page id.
 * @returns The last path segment.
 */
export function pageBasename(pageId: string): string {
  const idx = pageId.lastIndexOf("/");
  return idx >= 0 ? pageId.slice(idx + 1) : pageId;
}

/** Strip surrounding single/double quotes and whitespace from a scalar value. */
function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1).trim();
  }
  return v;
}

/** Parse an inline `[a, b, c]` array or a comma-separated scalar into items. */
function splitList(value: string): string[] {
  const inner = /^\[(.*)\]$/.exec(value)?.[1] ?? value;
  return inner
    .split(",")
    .map((s) => unquote(s))
    .filter((s) => s.length > 0);
}

/**
 * Parse `lastReviewed` leniently: bare `YYYY-MM-DD`, optional time, or any
 * string `Date.parse` accepts. Placeholder values like `<date>` (copied from
 * the protocol template by seeding agents) are reported, not parsed.
 */
function parseReviewDate(raw: string): { ms?: number; issue?: string } {
  const v = unquote(raw);
  if (v.length === 0) return { issue: "lastReviewed is empty" };
  if (/^<.*>$/.test(v)) return { issue: `lastReviewed is an unreplaced placeholder ("${v}")` };
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(v);
  if (!m) {
    const fallback = Date.parse(v);
    return Number.isFinite(fallback)
      ? { ms: fallback }
      : { issue: `lastReviewed is not a date ("${v}")` };
  }
  const ms = Date.parse(m[0].includes("T") ? m[0] : `${m[0]}T00:00:00`);
  return Number.isFinite(ms) ? { ms } : { issue: `lastReviewed is not a real date ("${v}")` };
}

/**
 * Parse the YAML frontmatter block of a wiki page.
 *
 * Accepts only the protocol keys (`title`, `tags`, `sourceRefs`,
 * `lastReviewed`); other keys are ignored. Handles scalar values, inline
 * arrays, comma lists, and `- item` block lists. Does NOT enforce the
 * protocol — missing frontmatter is a finding for the lint layer, not an
 * error here.
 *
 * @param content - Full page content (CRLF normalized internally).
 * @returns Parsed frontmatter; `present: false` when the block is absent.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const text = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const result: ParsedFrontmatter = { present: false, tags: [], sourceRefs: [], issues: [] };

  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return result;
  result.present = true;

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t === "---" || t === "...") { end = i; break; }
  }
  if (end < 0) {
    result.issues.push({ message: "frontmatter block is never closed" });
    end = lines.length;
  }

  const seen = new Set<string>();
  let currentListKey: string | undefined;
  let pendingList: string[] = [];

  const flushPending = () => {
    if (currentListKey && pendingList.length > 0) {
      if (currentListKey === "tags") result.tags = pendingList.slice();
      else if (currentListKey === "sourceRefs") result.sourceRefs = pendingList.slice();
    }
    pendingList = [];
    currentListKey = undefined;
  };

  for (let i = 1; i < end; i++) {
    const line = lines[i]!;
    const itemMatch = /^\s+-\s+(.*)$/.exec(line);
    if (itemMatch && currentListKey) {
      pendingList.push(unquote(itemMatch[1]!));
      continue;
    }
    flushPending();

    const kv = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    const value = kv[2]!.trim();
    if (seen.has(key)) result.issues.push({ key, message: `duplicate key "${key}" (last one wins)` });
    seen.add(key);

    switch (key) {
      case "title":
        result.title = unquote(value) || undefined;
        break;
      case "tags":
      case "sourceRefs": {
        if (value.length === 0) {
          // Block list may follow: collect `- item` lines until the next key.
          currentListKey = key;
          pendingList = [];
        } else if (value === "[]") {
          // explicit empty list
        } else {
          const items = splitList(value);
          if (key === "tags") result.tags = items;
          else result.sourceRefs = items;
        }
        break;
      }
      case "lastReviewed": {
        result.lastReviewedRaw = unquote(value);
        const parsed = parseReviewDate(value);
        if (parsed.ms !== undefined) result.lastReviewedMs = parsed.ms;
        if (parsed.issue) result.issues.push({ key, message: parsed.issue });
        break;
      }
      default:
        break; // unknown keys are legal, just not protocol keys
    }
  }
  flushPending();
  return result;
}

/**
 * Extract wikilinks from page content, skipping fenced code blocks (``` /
 * ~~~) and inline backtick spans.
 *
 * @param content - Full page content.
 * @returns Links in document order.
 */
export function parseWikiLinks(content: string): WikiLink[] {
  const text = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const links: WikiLink[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // Drop inline code spans so `[[wiki/example]]` in prose is not a link.
    const scrubbed = line.replace(/`[^`\n]*`/g, "");
    for (const m of scrubbed.matchAll(/\[\[([^\][\n]+)\]\]/g)) {
      const raw = m[1]!.trim();
      if (raw.length === 0) continue;
      const [targetPart, ...aliasParts] = raw.split("|");
      const alias = aliasParts.length > 0 ? aliasParts.join("|").trim() : undefined;
      const [target, ...anchorParts] = (targetPart ?? "").split("#");
      const anchor = anchorParts.length > 0 ? anchorParts.join("#").trim() : undefined;
      const targetClean = (target ?? "").trim();
      if (targetClean.length === 0) continue;
      links.push({ raw, target: targetClean, anchor, alias });
    }
  }
  return links;
}

/**
 * Parse a wiki page from its raw content.
 *
 * @param content - The full file content.
 * @returns Frontmatter, best title, links, and a rough word count.
 */
export function parseWikiPage(content: string): ParsedWikiPage {
  const frontmatter = parseFrontmatter(content);
  const links = parseWikiLinks(content);
  const body = frontmatter.present ? content.replace(/^---[\s\S]*?\n---/, "") : content;
  const h1 = /^#\s+(.+)$/m.exec(body);
  const wordCount = body.split(/\s+/).filter((w) => w.length > 0).length;
  return {
    frontmatter,
    headingTitle: h1?.[1]?.trim(),
    links,
    wordCount,
  };
}
