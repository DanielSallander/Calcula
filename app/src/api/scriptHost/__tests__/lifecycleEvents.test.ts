//! FILENAME: app/src/api/scriptHost/__tests__/lifecycleEvents.test.ts
// PURPOSE: Pin what B5 exposed to scripts — the new bus events a script may
//          subscribe to, the THINNING applied to the distribution event, and the
//          read-only context.package provenance mirror.

import { describe, it, expect } from "vitest";
import { SCRIPT_SUBSCRIBABLE_APP_EVENTS, thinAppEventForScripts } from "../allowlist";
import { scriptSubscribeEventName } from "../broker";
import { AppEvents } from "../../events";
import { buildWorkerContext } from "../worker/contextShims";
import type { MountSpec, W2H } from "../protocol";

// ============================================================================
// Newly subscribable app events
// ============================================================================

describe("SCRIPT_SUBSCRIBABLE_APP_EVENTS", () => {
  const added = [
    AppEvents.SHEET_ADDED,
    AppEvents.SHEET_DELETED,
    AppEvents.SHEET_RENAMED,
    AppEvents.RECALCULATION_COMPLETED,
    AppEvents.PACKAGE_UPDATED,
  ];

  it("includes the sheet-collection, recalc and distribution events", () => {
    for (const name of added) {
      expect(SCRIPT_SUBSCRIBABLE_APP_EVENTS.has(name), name).toBe(true);
    }
  });

  it("lets api.onEvent name them RAW instead of namespacing them away", () => {
    for (const name of added) {
      expect(scriptSubscribeEventName(name), name).toBe(name);
    }
    // ...while an unknown name is still forced into the script namespace.
    expect(scriptSubscribeEventName("app:before-save")).toBe("userscript:app:before-save");
    expect(scriptSubscribeEventName("myThing")).toBe("userscript:myThing");
  });

  it("still withholds the control events a script must not observe", () => {
    for (const name of [
      AppEvents.BEFORE_SAVE,
      AppEvents.BEFORE_CLOSE,
      AppEvents.BEFORE_OPEN,
      AppEvents.BEFORE_NEW,
      AppEvents.MUTATION_REFRESH,
      AppEvents.CONTEXT_MENU_REQUEST,
    ]) {
      expect(SCRIPT_SUBSCRIBABLE_APP_EVENTS.has(name), name).toBe(false);
    }
  });

  it("every subscribable name is a real AppEvent", () => {
    const known = new Set<string>(Object.values(AppEvents));
    for (const name of SCRIPT_SUBSCRIBABLE_APP_EVENTS) {
      expect(known.has(name), name).toBe(true);
    }
  });
});

// ============================================================================
// Payload thinning
// ============================================================================

describe("thinAppEventForScripts — PACKAGE_UPDATED", () => {
  const full = {
    packageName: "q4-report",
    version: "2.4.1",
    kind: "subscribe",
    sheetsPulled: 3,
    scriptsPulled: 2,
    registryPath: "\\\\corp\\registry",
  };

  it("keeps only the package identity", () => {
    expect(thinAppEventForScripts(AppEvents.PACKAGE_UPDATED, full)).toEqual({
      packageName: "q4-report",
      version: "2.4.1",
    });
  });

  it("drops the subscriber-side counts and anything else added later", () => {
    const thinned = thinAppEventForScripts(AppEvents.PACKAGE_UPDATED, full) as Record<string, unknown>;
    expect(Object.keys(thinned).sort()).toEqual(["packageName", "version"]);
    for (const leaked of ["kind", "sheetsPulled", "scriptsPulled", "registryPath"]) {
      expect(thinned).not.toHaveProperty(leaked);
    }
  });

  it("normalizes a missing version to null rather than undefined", () => {
    expect(thinAppEventForScripts(AppEvents.PACKAGE_UPDATED, { packageName: "p" })).toEqual({
      packageName: "p",
      version: null,
    });
  });

  it("survives a bare/absent payload", () => {
    expect(thinAppEventForScripts(AppEvents.PACKAGE_UPDATED, undefined)).toEqual({
      packageName: undefined,
      version: null,
    });
  });

  it("passes the sheet and recalc payloads through UNCHANGED (nothing privileged in them)", () => {
    const sheet = { sheetIndex: 2, sheetName: "Q4", source: "new" };
    expect(thinAppEventForScripts(AppEvents.SHEET_ADDED, sheet)).toBe(sheet);
    const rename = { sheetIndex: 2, oldName: "Q4", newName: "Q4 final" };
    expect(thinAppEventForScripts(AppEvents.SHEET_RENAMED, rename)).toBe(rename);
    const recalc = { scope: "workbook", cellsUpdated: 12, durationMs: 4 };
    expect(thinAppEventForScripts(AppEvents.RECALCULATION_COMPLETED, recalc)).toBe(recalc);
  });
});

// ============================================================================
// context.package (provenance mirror)
// ============================================================================

function contextFor(packageInfo?: MountSpec["packageInfo"]): Record<string, unknown> {
  const posted: W2H[] = [];
  const spec: MountSpec = {
    protocolVersion: 1,
    scriptId: "s1",
    objectType: "workbook",
    tier: "restricted",
    capabilities: [],
    apiVersion: "1.0.0",
    source: "",
    scriptName: "Test",
    packageInfo,
    snapshot: {},
  };
  return buildWorkerContext(spec, (m) => posted.push(m)).context;
}

describe("context.package", () => {
  it("is null for a locally authored script", () => {
    expect(contextFor().package).toBeNull();
  });

  it("mirrors the package name, version and provenance for a distributed script", () => {
    expect(
      contextFor({ name: "q4-report", version: "2.4.1", provenance: "distributed" }).package,
    ).toEqual({ name: "q4-report", version: "2.4.1", provenance: "distributed" });
  });

  it("reports a null version for a package pulled before versions were stamped", () => {
    const pkg = contextFor({ name: "legacy", version: null, provenance: "distributed" })
      .package as { version: unknown };
    expect(pkg.version).toBeNull();
  });

  it("is FROZEN — a script cannot rewrite its own provenance before passing it on", () => {
    const pkg = contextFor({ name: "q4-report", version: "2.4.1", provenance: "distributed" })
      .package as { name: string };
    expect(Object.isFrozen(pkg)).toBe(true);
    try {
      (pkg as { name: string }).name = "trusted-corp-pkg";
    } catch {
      /* strict mode throws; sloppy mode silently ignores — both are fine */
    }
    expect(pkg.name).toBe("q4-report");
  });

  it("carries no extra members a script could mistake for authority", () => {
    const pkg = contextFor({ name: "p", version: "1.0.0", provenance: "distributed" })
      .package as object;
    expect(Object.keys(pkg).sort()).toEqual(["name", "provenance", "version"]);
  });
});
