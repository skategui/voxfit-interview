/**
 * ManualReview service tests — the stateful edge.
 * Covers idempotent enqueue (duplicate / out-of-order events collapse to one row),
 * local-file persistence + reload, resolve(), and the orchestrator routing loop.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleCallCompleted } from "../src/services/orchestrator";
import {
  ManualReviewStore,
  ReviewStatus,
  reviewItemId,
} from "../src/services/manualReview";
import type { ManualReviewItem } from "../src/services/manualReview";
import { NormalizedOutcome } from "../src/decision/types";
import { makeInput } from "./helpers";

const makeReviewItem = (reason: string): ManualReviewItem => ({
  id: reviewItemId("CASE_1", "CA_1", reason),
  caseId: "CASE_1",
  callSid: "CA_1",
  reason,
  normalizedOutcome: NormalizedOutcome.Disputed,
  warnings: [],
  createdAt: "2025-07-10T08:00:00+02:00",
  status: ReviewStatus.Open,
});

describe("ManualReviewStore (in-memory)", () => {
  it("enqueue is idempotent — duplicate id stores once", () => {
    const store = new ManualReviewStore(null);
    expect(store.enqueue(makeReviewItem("conflict"))).toBe(true);
    expect(store.enqueue(makeReviewItem("conflict"))).toBe(false); // duplicate / replayed event
    expect(store.size()).toBe(1);
  });

  it("resolve flips open → resolved, and is a no-op the second time", () => {
    const store = new ManualReviewStore(null);
    store.enqueue(makeReviewItem("disputed"));
    const reviewId = reviewItemId("CASE_1", "CA_1", "disputed");
    expect(store.resolve(reviewId, "handled")).toBe(true);
    expect(store.get(reviewId)?.status).toBe(ReviewStatus.Resolved);
    expect(store.resolve(reviewId)).toBe(false);
  });

  it("list filters by status", () => {
    const store = new ManualReviewStore(null);
    store.enqueue(makeReviewItem("first"));
    store.enqueue(makeReviewItem("second"));
    store.resolve(reviewItemId("CASE_1", "CA_1", "first"));
    expect(store.list({ status: ReviewStatus.Open })).toHaveLength(1);
    expect(store.list({ status: ReviewStatus.Resolved })).toHaveLength(1);
  });
});

describe("ManualReviewStore (local file persistence — no DB)", () => {
  let directory: string;
  let storeFile: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "voxfit-"));
    storeFile = join(directory, "manual-review.json");
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("persists to disk and reloads into a fresh store", () => {
    const writerStore = new ManualReviewStore(storeFile);
    writerStore.enqueue(makeReviewItem("conflict"));
    expect(existsSync(storeFile)).toBe(true);
    expect(JSON.parse(readFileSync(storeFile, "utf8"))).toHaveLength(1);

    const reloadedStore = new ManualReviewStore(storeFile); // fresh instance reads the file
    expect(reloadedStore.size()).toBe(1);
    expect(reloadedStore.enqueue(makeReviewItem("conflict"))).toBe(false); // still idempotent across reload
  });
});

describe("orchestrator routing", () => {
  it("routes a manual_review action into the store, idempotently", () => {
    const store = new ManualReviewStore(null);
    const input = makeInput({ insights: { outcome: "Debt dispute" } });

    const firstDelivery = handleCallCompleted(input, store);
    expect(firstDelivery.enqueued).toHaveLength(1);
    expect(store.size()).toBe(1);

    // Re-deliver the SAME event (at-least-once bus) → no new row.
    const secondDelivery = handleCallCompleted(input, store);
    expect(secondDelivery.enqueued).toHaveLength(0);
    expect(store.size()).toBe(1);
  });

  it("a non-review outcome enqueues nothing", () => {
    const store = new ManualReviewStore(null);
    const input = makeInput({
      insights: {
        outcome: "Accepted full payment later",
        paymentDate: "2025-07-20",
      },
    });
    const result = handleCallCompleted(input, store);
    expect(result.enqueued).toHaveLength(0);
    expect(store.size()).toBe(0);
  });
});
