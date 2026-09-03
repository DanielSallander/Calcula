//! FILENAME: app/src/api/scriptHost/__tests__/formSubmitVerdict.test.ts
// PURPOSE: The onSubmit verdict normalizer and the preview payload table for
//          form hooks.
// CONTEXT: The verdict keeps `errors` and `message` (the workbook lifecycle
//          normalizer deliberately drops them), so a script CAN say which
//          widget is wrong — and the strings are clamped here, because they
//          are painted by trusted code and a script must not push an
//          unbounded string at it. Keys are validated as widget names for the
//          same reason `result.__proto__` is refused everywhere else.

import { describe, it, expect, vi } from "vitest";

// The mount path touches the backend for grants and snapshot seeds; none of it
// is under test here and all of it is defensive against failure.
vi.mock("../../backend", () => ({
  invokeBackend: vi.fn().mockResolvedValue(null),
  getWorkbookProperties: vi.fn().mockRejectedValue(new Error("no backend in test")),
  emitTauriEvent: vi.fn().mockResolvedValue(undefined),
  listenTauriEvent: vi.fn().mockResolvedValue(() => undefined),
}));
vi.mock("../capabilities", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  restoreAndSyncGrants: vi.fn().mockResolvedValue(undefined),
  revokeBackendCapabilities: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../mountGate", () => ({
  assertMountAllowed: vi.fn().mockResolvedValue(undefined),
}));

import { normalizeFormSubmitVerdict } from "../host";
import { MAX_FORM_ERROR_CHARS } from "../scriptFormSpec";
import { synthesizableHookPayload } from "../scriptPreview/runShape";

describe("normalizeFormSubmitVerdict", () => {
  it("accepts on nothing, undefined, true, and objects that do not cancel", () => {
    expect(normalizeFormSubmitVerdict(undefined)).toBeNull();
    expect(normalizeFormSubmitVerdict(null)).toBeNull();
    expect(normalizeFormSubmitVerdict(true)).toBeNull();
    expect(normalizeFormSubmitVerdict({ cancel: false, errors: { a: "x" } })).toBeNull();
    expect(normalizeFormSubmitVerdict("nope")).toBeNull();
  });

  it("cancels on false, 'cancel' and { cancel: true }", () => {
    expect(normalizeFormSubmitVerdict(false)).toEqual({ cancel: true });
    expect(normalizeFormSubmitVerdict("cancel")).toEqual({ cancel: true });
    expect(normalizeFormSubmitVerdict({ cancel: true })).toEqual({ cancel: true });
  });

  it("keeps per-widget errors and the message, clamped and name-checked", () => {
    const long = "x".repeat(MAX_FORM_ERROR_CHARS + 50);
    const verdict = normalizeFormSubmitVerdict({
      cancel: true,
      errors: { region: "Not in APAC", __proto__: "poison", "bad name": "no", qty: 7, total: long },
      message: long,
    });
    expect(verdict).toEqual({
      cancel: true,
      errors: { region: "Not in APAC", total: "x".repeat(MAX_FORM_ERROR_CHARS) },
      message: "x".repeat(MAX_FORM_ERROR_CHARS),
    });
  });

  it("drops an errors object with nothing usable in it", () => {
    expect(normalizeFormSubmitVerdict({ cancel: true, errors: { "__proto__": "p" }, message: "" })).toEqual({ cancel: true });
    expect(normalizeFormSubmitVerdict({ cancel: true, errors: ["a"] })).toEqual({ cancel: true });
  });
});

describe("preview payloads for form hooks", () => {
  it("a form's onClick is a WIDGET click, never a button's { x, y }", () => {
    expect(synthesizableHookPayload("onClick", "form")).toEqual({ payload: { name: "", values: {} } });
    expect(synthesizableHookPayload("onClick", "button")).toEqual({ payload: { x: 0, y: 0 } });
    expect(synthesizableHookPayload("onClick")).toEqual({ payload: { x: 0, y: 0 } });
  });

  it("a form hook with no synthesizable payload is skipped, not guessed", () => {
    expect(synthesizableHookPayload("onSubmit", "form")).toBeNull();
    expect(synthesizableHookPayload("onDoubleClick", "form")).toBeNull();
  });

  it("form.onShow / onChange / onClose mirror the registry's shapes", () => {
    expect(synthesizableHookPayload("onShow", "form")).toEqual({ payload: { values: {} } });
    expect(synthesizableHookPayload("onChange", "form")).toEqual({
      payload: { name: "", value: null, values: {}, source: "user" },
    });
    expect(synthesizableHookPayload("onClose", "form")).toEqual({ payload: { reason: "cancel", values: {} } });
  });
});
