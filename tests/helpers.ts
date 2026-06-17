/**
 * Test helpers: a typed input factory with sensible defaults so each test only
 * states the fields it cares about. Defaults describe a "clean human-answered
 * call on an active case" — every test overrides from there.
 */

import {
  AmdStatus,
  CallStatus,
  CaseStatus,
  ToolEventStatus,
} from "../src/decision/types";
import type {
  CallInfo,
  CaseInfo,
  Insights,
  PostCallInput,
  StepInfo,
  ToolEvent,
} from "../src/decision/types";

export const PARIS = "Europe/Paris";

/** A fixed reference clock: Thursday 2025-07-10, 08:00 Paris (CEST, +02:00). */
export const NOW = "2025-07-10T08:00:00+02:00";

export interface InputOverrides {
  now?: string;
  timezone?: string;
  call?: Partial<CallInfo>;
  case?: Partial<CaseInfo>;
  step?: Partial<StepInfo>;
  insights?: Partial<Insights>;
  toolEvents?: ToolEvent[];
}

export const makeInput = (overrides: InputOverrides = {}): PostCallInput => ({
  now: overrides.now ?? NOW,
  timezone: overrides.timezone ?? PARIS,
  call: {
    callSid: "CA_test",
    status: CallStatus.Completed,
    amdStatus: AmdStatus.Human,
    durationSec: 60,
    performedAt: overrides.now ?? NOW,
    ...overrides.call,
  },
  case: {
    caseId: "CASE_1",
    status: CaseStatus.Active,
    amountRemaining: 100,
    currency: "EUR",
    ...overrides.case,
  },
  step: {
    stepActionId: "STEP_1",
    maxAttempts: 5,
    attemptsSoFar: 0,
    retryDelayHours: 24,
    ...overrides.step,
  },
  insights: { ...overrides.insights },
  toolEvents: overrides.toolEvents,
});

export const successPaymentLink = (
  createdAt: string,
  id = "te_1",
): ToolEvent => ({
  id,
  name: "send_payment_link",
  status: ToolEventStatus.Success,
  createdAt,
});
