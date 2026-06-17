/**
 * Tiny in-process event bus — the orchestrator glue.
 *
 * Built on Node's stdlib EventEmitter (no dependency). In production this would
 * be a real broker (SQS / Redis Streams / Kafka) with at-least-once delivery;
 * the point here is to demonstrate the event-driven shape: the decision function
 * stays pure, and side effects happen in subscribers.
 *
 * ponytail: single in-memory emitter — fine for local/dev; swap for a durable
 * broker when crossing process boundaries.
 */

import { EventEmitter } from "node:events";
import type { ManualReviewItem } from "./manualReview";

export type BusEvents = {
  "manual_review.requested": ManualReviewItem;
};

const emitter = new EventEmitter();

export const bus = {
  emit<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): void {
    emitter.emit(event, payload);
  },
  on<K extends keyof BusEvents>(
    event: K,
    handler: (payload: BusEvents[K]) => void,
  ): void {
    emitter.on(event, handler);
  },
  off<K extends keyof BusEvents>(
    event: K,
    handler: (payload: BusEvents[K]) => void,
  ): void {
    emitter.off(event, handler);
  },
};
