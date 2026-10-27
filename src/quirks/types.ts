/** Quirk sub-type labels. */
export type QuirkType = "gotcha" | "preference" | "decision" | "environment-constraint";

/** Tag every auto-created tool-error quirk carries. */
export const TOOL_ERROR_QUIRK_TAG = "tool-error";
/** Second tag marking the quirk as machine-created (not agent-authored). */
export const TOOL_ERROR_AUTO_TAG = "auto-created";
/** Prefix of the per-tool tag: `tool:<name>`. */
export const TOOL_ERROR_TOOL_TAG_PREFIX = "tool:";
/** Prefix of the cause-class tag: `cause:<class>`. */
export const TOOL_ERROR_CAUSE_TAG_PREFIX = "cause:";

/** Input for adding a new quirk. */
export interface QuirkInput {
  content: string;
  quirkType?: string;
  tags?: string[];
  confidence?: number;
  sourceRef?: string;
}

/** A quirk entry stored in the vectordb and audit log. */
export interface Quirk {
  id: string;
  content: string;
  quirkType?: string;
  tags: string[];
  confidence: number;
  lastObserved: string;
  sourceRef?: string;
  /**
   * Set when the quirk was deleted. The record is kept in `quirks.jsonl` as a
   * tombstone so the deletion survives `mergeQuirkJsonl` (which is a union by
   * id with no negative records) and therefore propagates to the central store
   * on both hydrate and flush. Tombstones are filtered out of every read path.
   */
  deletedAt?: string;
}
