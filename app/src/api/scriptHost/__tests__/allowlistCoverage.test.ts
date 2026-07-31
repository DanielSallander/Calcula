//! FILENAME: app/src/api/scriptHost/__tests__/allowlistCoverage.test.ts
// PURPOSE: Drift guard for the 5-file broker-method pattern. A broker method is
//          only real when ALL of its layers exist: an ALLOWLIST policy row, a
//          validator, a host executor, and a worker shim that calls it. This
//          test derives the layers from the SOURCE and fails when one is missing.
// CONTEXT: Written during the Wave B integration sweep, which found exactly the
//          failure this guards: `base.unexpose` was called by contextShims.ts
//          but had NO ALLOWLIST row, so checkPolicy() rejected it with
//          UnknownMethod before it could ever reach the host executor that was
//          sitting there waiting for it. Nothing failed loudly — the call was
//          fire-and-forget, so a script's `expose()` cleanup silently did
//          nothing and the host kept relaying to a withdrawn handler.
//
//          The asymmetry matters:
//            shim-without-row  = a FEATURE THAT DOES NOT WORK (fails closed).
//            row-without-caller = dead consent text (inflates what the
//                                 transparency panel tells the user a script
//                                 can do). Allowed, but only by name, below.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { ALLOWLIST } from "../allowlist";
import { EXTENSION_BROKER_METHODS } from "../extensionProtocol";

const HOST_DIR = path.resolve(__dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(HOST_DIR, rel), "utf8");

const contextShims = read("worker/contextShims.ts");
const extensionWorkerContext = read("worker/extensionWorkerContext.ts");
const hostSrc = read("host.ts");
const extensionWorkerHostSrc = read("extensionWorkerHost.ts");
const formulaUdfSrc = fs.readFileSync(
  path.resolve(__dirname, "../../formulaUdf.ts"),
  "utf8",
);

/** Method names the WORKER shims send to the broker. */
function shimInvokedMethods(src: string): Set<string> {
  const found = new Set<string>();
  // contextShims: call(rt, "m", ...) / callFire(rt, "m", ...)
  for (const m of src.matchAll(/\b(?:call|callFire)\(\s*rt\s*,\s*"([^"]+)"/g)) found.add(m[1]);
  // extensionWorkerContext: brokerCall("m", ...)
  for (const m of src.matchAll(/\bbrokerCall\(\s*"([^"]+)"/g)) found.add(m[1]);
  return found;
}

/** `case "m":` labels in a host dispatch switch. */
function switchCases(src: string): Set<string> {
  return new Set([...src.matchAll(/case\s+"([^"]+)"\s*:/g)].map((m) => m[1]));
}

const shimMethods = new Set([
  ...shimInvokedMethods(contextShims),
  ...shimInvokedMethods(extensionWorkerContext),
]);
const hostCases = switchCases(hostSrc);
const extensionHostCases = switchCases(extensionWorkerHostSrc);

/**
 * ALLOWLIST rows with no worker shim calling them by name. Each is here for a
 * stated reason, and the list is asserted EXACTLY — a new unreachable row (the
 * "I wrote the policy but forgot the shim" half of the pattern) fails here.
 */
const ROWS_WITH_NO_SHIM_CALLER: Record<string, string> = {
  // Policy/transparency rows for reach that is DISPATCHED THROUGH ANOTHER
  // METHOD, so the shim never names them:
  //   - the shape context calls object.setState with the
  //     "shape.declareProperties" aspect;
  //   - api.onEvent's subscription is carried by the audited events.subscribe
  //     row (host.ts documents this at the forwarder).
  "object.declareProperties": "dispatched as the object.setState 'shape.declareProperties' aspect",
  "api.onEvent": "subscription is carried by events.subscribe; this row is the policy/consent text",
  // Invoked by TRUSTED main-thread code (api/formulaUdf.ts) through
  // brokerCall(handle, method, args, executor) — a recalc pre-fetch, not
  // something a script asks for — so there is no worker shim and no host
  // switch case; the executor is inline at the call site.
  "formula.udf.invoke": "invoked host-side by api/formulaUdf.ts with an inline executor",
  // Reserved for sandboxed extensions. Their console is mirrored by the
  // {t:"console"} worker message (extensionBootstrap.ts forwardConsole), NOT by
  // the broker, so nothing calls this today. It stays because the host executor
  // exists and the row is what would gate it.
  "ext.log": "extension console is mirrored by the {t:'console'} worker message, not the broker",
};

/** ALLOWLIST rows whose work is NOT done by a `case` in executeImpl. */
const ROWS_WITH_NO_HOST_CASE = new Set([
  "object.declareProperties",
  "api.onEvent",
  "formula.udf.invoke",
]);

describe("broker method coverage (the 5-file pattern)", () => {
  it("every method a worker shim calls has an ALLOWLIST row", () => {
    // A missing row is not a missing feature — it is a feature that FAILS
    // CLOSED at runtime with UnknownMethod, which is invisible for the
    // fire-and-forget (callFire) paths.
    const orphans = [...shimMethods].filter((m) => !ALLOWLIST[m]).sort();
    expect(
      orphans,
      `worker shims call these, but the broker will reject them with UnknownMethod: ${orphans.join(", ")}`,
    ).toEqual([]);
  });

  it("base.unexpose specifically is allowlisted and executed (the found defect)", () => {
    expect(ALLOWLIST["base.unexpose"]).toBeDefined();
    expect(ALLOWLIST["base.unexpose"].tier).toBe("restricted");
    expect(ALLOWLIST["base.unexpose"].capability).toBeUndefined();
    expect(shimMethods.has("base.unexpose")).toBe(true);
    expect(hostCases.has("base.unexpose")).toBe(true);
    // It must actually withdraw the registration, not return undefined.
    expect(hostSrc).toContain("unregisterExposed(handle, name)");
  });

  it("every ALLOWLIST row has a host executor (exemptions named)", () => {
    const missing = Object.keys(ALLOWLIST)
      .filter((m) => !hostCases.has(m) && !extensionHostCases.has(m))
      .sort();
    expect(missing).toEqual([...ROWS_WITH_NO_HOST_CASE].sort());
    // The one exemption that claims an inline executor really has one.
    expect(formulaUdfSrc).toContain('"formula.udf.invoke"');
  });

  it("every ALLOWLIST row is reachable, or is exempt BY NAME", () => {
    const unreachable = Object.keys(ALLOWLIST)
      .filter((m) => !shimMethods.has(m))
      .sort();
    expect(unreachable).toEqual(Object.keys(ROWS_WITH_NO_SHIM_CALLER).sort());
  });

  it("every ALLOWLIST row carries user-readable consent text", () => {
    for (const [method, policy] of Object.entries(ALLOWLIST)) {
      expect(policy.desc.length, `${method} desc`).toBeGreaterThan(10);
      // The desc is what a NON-PROGRAMMER reads in the consent/transparency UI:
      // it must describe the reach, not name the wire method or the capability.
      expect(policy.desc, `${method} desc leaks its method id`).not.toContain(method);
      expect(policy.desc[0], `${method} desc starts lowercase`).toBe(
        policy.desc[0].toUpperCase(),
      );
      expect(typeof policy.validate, `${method} validator`).toBe("function");
    }
  });

  it("sandboxed extensions can only reach allowlisted, implemented methods", () => {
    for (const m of EXTENSION_BROKER_METHODS) {
      expect(ALLOWLIST[m], `${m} in EXTENSION_BROKER_METHODS but not ALLOWLIST`).toBeDefined();
      expect(
        extensionHostCases.has(m),
        `${m} is offered to sandboxed extensions but extensionWorkerHost has no case`,
      ).toBe(true);
    }
  });

  it("the sandboxed-extension context never calls a method outside its gate", () => {
    // extensionWorkerContext is a DIFFERENT, narrower door than contextShims:
    // whatever it calls must also be listed in EXTENSION_BROKER_METHODS, or the
    // extension host refuses it.
    const called = shimInvokedMethods(extensionWorkerContext);
    const outside = [...called].filter((m) => !EXTENSION_BROKER_METHODS.has(m)).sort();
    expect(outside).toEqual([]);
  });
});
