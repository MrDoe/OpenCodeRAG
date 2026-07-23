/** Quirk sub-type labels. */
export type QuirkType = "gotcha" | "preference" | "decision" | "environment-constraint";

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
}
