/**
 * Trust-boundary parser tests — the layer types.ts names ("validated at the trust
 * boundary") but the engine assumed. Covers the silent-completion bug at its source
 * (non-finite amountRemaining), invalid timezone, malformed payloads (no throw),
 * open-field coercion, and the end-to-end parse → decide handoff.
 */

import { describe, expect, it } from "vitest";
import { buildPostCallDecision } from "../src/decision";
import { parsePostCallInput } from "../src/decision/parseInput";
import { makeInput } from "./helpers";

const raw = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...makeInput(),
  ...over,
});

describe("parsePostCallInput — trust boundary", () => {
  it("accepts a well-formed payload and returns the typed input", () => {
    const result = parsePostCallInput(makeInput());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.case.caseId).toBe("CASE_1");
  });

  it("rejects non-finite amountRemaining — the silent-completion bug at the source", () => {
    // Without this, undefined/NaN/"100" reach settledGuard, where `remaining > 0`
    // is false → the case is silently marked completed and collection stops.
    for (const bad of [undefined, null, "100", NaN, Infinity]) {
      const result = parsePostCallInput(
        raw({ case: { ...makeInput().case, amountRemaining: bad } }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.errors.some((e) => e.includes("amountRemaining"))).toBe(
          true,
        );
    }
  });

  it("rejects an invalid IANA timezone instead of degrading every call to invalid_now", () => {
    const result = parsePostCallInput(raw({ timezone: "Europe/Pari" }));
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors.some((e) => e.includes("timezone"))).toBe(true);
  });

  it("rejects a malformed payload (missing case / empty call) WITHOUT throwing", () => {
    const result = parsePostCallInput({
      now: "2025-07-10T08:00:00+02:00",
      timezone: "Europe/Paris",
      call: {},
      step: {},
      insights: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects a non-object input without throwing", () => {
    expect(parsePostCallInput(null).ok).toBe(false);
    expect(parsePostCallInput("nope").ok).toBe(false);
    expect(parsePostCallInput(42).ok).toBe(false);
  });

  it("rejects non-finite durationSec", () => {
    const result = parsePostCallInput(
      raw({ call: { ...makeInput().call, durationSec: NaN } }),
    );
    expect(result.ok).toBe(false);
  });

  it("coerces an unknown carrier call.status to undefined (open field) — still valid", () => {
    const result = parsePostCallInput(
      raw({ call: { ...makeInput().call, status: "carrier-specific-status" } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.call.status).toBeUndefined();
  });

  it("defaults missing insights to {}", () => {
    const { insights, ...rest } = makeInput();
    void insights;
    const result = parsePostCallInput(rest);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.insights).toEqual({});
  });

  it("parsed output drives buildPostCallDecision (end-to-end boundary)", () => {
    const result = parsePostCallInput(
      makeInput({ insights: { outcome: "Debt dispute" } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const decision = buildPostCallDecision(result.input);
      expect(decision.normalizedOutcome).toBeDefined();
    }
  });
});
