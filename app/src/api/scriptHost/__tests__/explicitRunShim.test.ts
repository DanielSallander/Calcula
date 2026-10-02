//! FILENAME: app/src/api/scriptHost/__tests__/explicitRunShim.test.ts
// PURPOSE: The worker half of owner decision B. A realm an explicit run of an
//          approved application macro mounted gets the normal `context.api`
//          object -- so a RECORDED macro (`if (!context.api) ...; return
//          macro(context.api)`) runs unchanged -- while its tier stays
//          "restricted"; and it is RUN-ONLY: registering a hook or exposing a
//          method throws the script's own error instead of silently wiring a
//          door other code could call through.
// CONTEXT: contextShims.ts buildBase / registerHook / expose. The shim only
//          SHAPES; the broker enforces the grant host-side (brokerPolicy.ts),
//          which explicitRunGrant.test.ts pins.

import { describe, it, expect } from "vitest";
import { buildWorkerContext } from "../worker/contextShims";
import type { MountSpec, W2H } from "../protocol";

function realm(overrides: Partial<MountSpec> = {}) {
  const spec: MountSpec = {
    protocolVersion: 1,
    scriptId: "__calcula_macro_test",
    objectType: "workbook",
    tier: "restricted",
    capabilities: [],
    apiVersion: "1.0",
    source: "",
    scriptName: "Macro B",
    snapshot: {},
    ...overrides,
  };
  const posted: W2H[] = [];
  const { context } = buildWorkerContext(spec, (m) => posted.push(m));
  return {
    context: context as Record<string, unknown> & {
      api: Record<string, (...a: unknown[]) => unknown> | null;
      accessLevel: string;
      onOpen: (h: () => void) => unknown;
      expose: (name: string, fn: () => unknown) => unknown;
    },
    posted,
  };
}

const calls = (posted: W2H[]): string[] =>
  posted.filter((m) => m.t === "call").map((m) => (m as { method: string }).method);

describe("a restricted realm WITHOUT the grant (today's behaviour)", () => {
  it("has no context.api", () => {
    expect(realm().context.api).toBeNull();
  });
});

describe("a realm an explicit run mounted (explicitRunCells)", () => {
  // SABOTAGE (a): revert the api line to `spec.tier === "unlocked" ? ... : null`
  // -> context.api is null and a recorded macro reports "restricted".
  it("gets context.api, still says it is restricted, and a call goes to the broker", () => {
    const { context, posted } = realm({ explicitRunCells: true });
    expect(context.api).not.toBeNull();
    expect(typeof context.api!.setCellValue).toBe("function");
    expect(context.accessLevel).toBe("restricted");
    void (context.api!.setCellValue(0, 0, "OWNER-B") as Promise<unknown>).catch(() => undefined);
    expect(calls(posted)).toContain("api.setCellValue");
  });

  // SABOTAGE (b): remove the guard at the top of registerHook -> onOpen is wired.
  it("refuses a hook with the script's own error, and tells the host nothing", () => {
    const { context, posted } = realm({ explicitRunCells: true });
    expect(() => context.onOpen(() => undefined)).toThrow(/cell access only while it runs/);
    expect(posted.filter((m) => m.t === "hookRegistered")).toEqual([]);
  });

  it("refuses expose, and posts no base.expose", () => {
    const { context, posted } = realm({ explicitRunCells: true });
    expect(() => context.expose("x", () => 1)).toThrow(/cell access only while it runs/);
    expect(calls(posted)).not.toContain("base.expose");
  });

  it("refuses api.onEvent too (it is a hook underneath)", () => {
    const { context, posted } = realm({ explicitRunCells: true });
    const api = context.api as unknown as { onEvent: (n: string, h: () => void) => unknown };
    expect(() => api.onEvent("x", () => undefined)).toThrow(/cell access only while it runs/);
    expect(calls(posted)).not.toContain("events.subscribe");
  });
});

describe("CONTROL: an unlocked realm is untouched", () => {
  it("hooks and expose still work", () => {
    const { context, posted } = realm({ tier: "unlocked" });
    expect(context.api).not.toBeNull();
    expect(() => context.onOpen(() => undefined)).not.toThrow();
    expect(posted.some((m) => m.t === "hookRegistered")).toBe(true);
    expect(() => context.expose("x", () => 1)).not.toThrow();
    expect(calls(posted)).toContain("base.expose");
  });
});
