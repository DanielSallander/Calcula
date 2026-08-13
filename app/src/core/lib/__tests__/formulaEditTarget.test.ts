//! FILENAME: app/src/core/lib/__tests__/formulaEditTarget.test.ts
// PURPOSE: Tests for the external formula edit target seam.

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  registerExternalFormulaTarget,
  getExternalFormulaTarget,
  type ExternalFormulaTarget,
} from "../formulaEditTarget";

// ============================================================================
// Helpers
// ============================================================================

const cleanups: (() => void)[] = [];

function makeTarget(expecting = true): ExternalFormulaTarget {
  return {
    isExpectingReference: () => expecting,
    insertReference: vi.fn(),
  };
}

afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups.length = 0;
});

// ============================================================================
// Tests
// ============================================================================

describe("registerExternalFormulaTarget", () => {
  it("defaults to no target registered", () => {
    expect(getExternalFormulaTarget()).toBeNull();
  });

  it("exposes the registered target and unregisters via the cleanup", () => {
    const target = makeTarget();
    const cleanup = registerExternalFormulaTarget(target);
    cleanups.push(cleanup);

    expect(getExternalFormulaTarget()).toBe(target);

    cleanup();
    expect(getExternalFormulaTarget()).toBeNull();
  });

  it("replaces an earlier registration (single slot, last-writer-wins)", () => {
    const first = makeTarget();
    const second = makeTarget();
    cleanups.push(registerExternalFormulaTarget(first));
    cleanups.push(registerExternalFormulaTarget(second));

    expect(getExternalFormulaTarget()).toBe(second);
  });

  it("identity-checks the cleanup: a stale cleanup cannot tear down a newer registration", () => {
    const first = makeTarget();
    const second = makeTarget();
    const staleCleanup = registerExternalFormulaTarget(first);
    cleanups.push(registerExternalFormulaTarget(second));

    staleCleanup();
    expect(getExternalFormulaTarget()).toBe(second);
  });

  it("cleanup is idempotent", () => {
    const target = makeTarget();
    const cleanup = registerExternalFormulaTarget(target);

    cleanup();
    cleanup();
    expect(getExternalFormulaTarget()).toBeNull();
  });
});
