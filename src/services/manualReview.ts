/**
 * ManualReview service — the stateful edge of the event-driven system.
 *
 * The pure decision function never writes anywhere. When it emits a
 * `manual_review` scheduled action, the orchestrator turns it into a
 * ManualReviewItem and hands it here. This store persists to a LOCAL JSON file
 * (no database yet) and is IDEMPOTENT: a deterministic `id` collapses duplicate
 * or out-of-order `manual_review.requested` events into one row — which is what
 * makes it safe on an at-least-once bus.
 *
 * ponytail: whole-file rewrite + in-memory index is fine for local/dev. Swap for
 * a durable queue/DB + append log when this crosses a process boundary.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { NormalizedOutcome } from "../decision/types";

export enum ReviewStatus {
  Open = "open",
  Resolved = "resolved",
}

export interface ManualReviewItem {
  /** Deterministic dedupe key: `${caseId}:${callSid}:${reason}`. */
  id: string;
  caseId: string;
  callSid: string;
  reason: string; // e.g. "conflict", "unknown_outcome", "disputed", "no_answer_max_attempts"
  normalizedOutcome: NormalizedOutcome;
  warnings: string[]; // carried from the Decision so a human has the "why"
  createdAt: string; // from input.now → deterministic
  status: ReviewStatus;
  /** Raw transcript, when available — the human investigator's source of truth. */
  transcript?: string;
  resolutionNote?: string;
}

export interface ReviewFilter {
  status?: ReviewStatus;
}

/** Build the deterministic id for an item. */
export const reviewItemId = (
  caseId: string,
  callSid: string,
  reason: string,
): string => `${caseId}:${callSid}:${reason}`;

const isReviewStatus = (value: unknown): value is ReviewStatus =>
  value === ReviewStatus.Open || value === ReviewStatus.Resolved;

/** Runtime shape check for a row read from the (hand-editable) store file. */
const isManualReviewItem = (value: unknown): value is ManualReviewItem => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.caseId === "string" &&
    typeof candidate.callSid === "string" &&
    typeof candidate.reason === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.normalizedOutcome === "string" &&
    Array.isArray(candidate.warnings) &&
    isReviewStatus(candidate.status)
  );
};

export class ManualReviewStore {
  private readonly items = new Map<string, ManualReviewItem>();

  /** @param filePath JSON file to persist to, or `null` for in-memory only (tests). */
  constructor(private readonly filePath: string | null = "manual-review.json") {
    this.load();
  }

  /**
   * Idempotently add a review item. Returns `true` if newly stored, `false` if a
   * row with the same `id` already exists (duplicate / out-of-order event).
   */
  enqueue(item: ManualReviewItem): boolean {
    if (this.items.has(item.id)) return false;
    this.items.set(item.id, item);
    this.persist();
    return true;
  }

  /** List items, optionally filtered by status. Insertion-ordered (deterministic). */
  list(filter: ReviewFilter = {}): ManualReviewItem[] {
    const all = [...this.items.values()];
    return filter.status ? all.filter((i) => i.status === filter.status) : all;
  }

  get(id: string): ManualReviewItem | undefined {
    return this.items.get(id);
  }

  /** Mark an item resolved. Returns `false` if unknown or already resolved. */
  resolve(id: string, note?: string): boolean {
    const item = this.items.get(id);
    if (!item || item.status === ReviewStatus.Resolved) return false;
    this.items.set(id, {
      ...item,
      status: ReviewStatus.Resolved,
      resolutionNote: note,
    });
    this.persist();
    return true;
  }

  size(): number {
    return this.items.size;
  }

  // --- persistence --------------------------------------------------------
  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      // The file is hand-editable / version-driftable, so validate each row at the
      // trust boundary instead of casting. Invalid rows are skipped, not trusted.
      for (const row of parsed) {
        if (isManualReviewItem(row)) this.items.set(row.id, row);
      }
    } catch {
      // Corrupt store should not crash the consumer; start from what we have.
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    writeFileSync(
      this.filePath,
      JSON.stringify([...this.items.values()], null, 2),
      "utf8",
    );
  }
}
