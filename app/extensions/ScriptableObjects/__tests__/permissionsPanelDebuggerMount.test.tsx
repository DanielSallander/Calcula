//! FILENAME: app/extensions/ScriptableObjects/__tests__/permissionsPanelDebuggerMount.test.tsx
// PURPOSE: The transparency panel's per-mount LABELS, which are the whole
//          reason the panel exists and must therefore never be able to lie: a
//          mount the DEBUGGER owns is labelled as such and the label tracks the
//          session live, and the ORIGIN chip names a package as a package even
//          when the publisher named their application `local`.
// CONTEXT: Debugging a recorded macro mounts it at the UNLOCKED tier for the
//          length of the session — a whole-workbook realm the workbook itself
//          does not keep. Untagged it is indistinguishable in this list from a
//          script the user actually installed, so an unlocked mount would appear
//          with no explanation of why it is there or how it goes away. That is
//          the invisible-code failure this panel exists to prevent, so the tag
//          is pinned here rather than left to survive by luck.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// --- The host's transient (debugger-owned) mount registry --------------------
let transientIds: string[] = [];
vi.mock("@api/scriptHost/host", () => ({
  hostTransientDebugMountIds: () => transientIds,
}));

// --- Debug session broadcasts ------------------------------------------------
let debugListeners: Array<() => void> = [];
vi.mock("../lib/debugger", () => ({
  onDebugStateChange: (cb: () => void) => {
    debugListeners.push(cb);
    return () => {
      debugListeners = debugListeners.filter((l) => l !== cb);
    };
  },
}));

vi.mock("../index", () => ({
  ScriptableObjectEvents: { EDIT_SCRIPT: "objscript:edit" },
}));

vi.mock("@api/events", () => ({ emitAppEvent: vi.fn() }));

// --- The host's mount table --------------------------------------------------
interface FakeHandle {
  scriptId: string;
  scriptName: string;
  tier: string;
  origin: { kind: string; name?: string };
  objectType: string;
  instanceId: string | null;
  grants: Set<string>;
}
let handles: FakeHandle[] = [];
let scriptChangeListeners: Array<() => void> = [];

vi.mock("@api", async () => ({
  // The panel branches on the origin KIND and renders its chip through the
  // scriptOrigin helpers. Spread the REAL module (a leaf that imports nothing,
  // so there is no cycle) rather than hand-copying them: a doubled `isLocalOrigin`
  // is a second policy, and this file's whole subject is a label that must not be
  // able to lie.
  ...(await vi.importActual<Record<string, unknown>>("@api/scriptHost/scriptOrigin")),
  ALLOWLIST: {},
  SCRIPT_SUBSCRIBABLE_APP_EVENTS: [],
  getAuditTail: () => [],
  getAuditTotal: () => 0,
  onAudit: () => () => {},
  listMountedHandles: () => handles,
  listExposed: () => [],
  ObjectScriptManager: {
    onScriptChange: (cb: () => void) => {
      scriptChangeListeners.push(cb);
      return () => {
        scriptChangeListeners = scriptChangeListeners.filter((l) => l !== cb);
      };
    },
  },
  getGrantedOrigins: () => [],
  revokeCapability: vi.fn(async () => {}),
}));

import { MountedScriptsSection } from "../components/PermissionsPanel";

function handle(overrides: Partial<FakeHandle> = {}): FakeHandle {
  return {
    scriptId: "macro-monthly-close",
    scriptName: "Monthly Close",
    tier: "unlocked",
    origin: { kind: "local" },
    objectType: "workbook",
    instanceId: null,
    grants: new Set<string>(),
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

function render(): void {
  act(() => {
    root.render(
      React.createElement(MountedScriptsSection, {
        placement: "sidebar",
      } as never),
    );
  });
}

/** The tag as the user reads it: text within the card for `scriptName`. */
function cardText(scriptName: string): string {
  const cards = [...container.querySelectorAll("div")].filter((d) =>
    d.textContent?.includes(scriptName),
  );
  return cards.length > 0 ? (cards[cards.length - 1].textContent ?? "") : "";
}

describe("PermissionsPanel — debugger-owned mounts are named", () => {
  beforeEach(() => {
    transientIds = [];
    handles = [];
    debugListeners = [];
    scriptChangeListeners = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("tags a mount the debugger owns", () => {
    handles = [handle()];
    transientIds = ["macro-monthly-close"];
    render();
    expect(container.textContent).toContain("Monthly Close");
    expect(container.textContent).toContain("debugger");
  });

  it("does NOT tag an ordinary object-script mount", () => {
    handles = [handle({ scriptId: "obj-chart-1", scriptName: "Chart Script" })];
    transientIds = [];
    render();
    expect(container.textContent).toContain("Chart Script");
    expect(container.textContent).not.toContain("debugger");
  });

  it("tags only the debugger-owned entry when both are mounted", () => {
    handles = [
      handle(),
      handle({ scriptId: "obj-chart-1", scriptName: "Chart Script" }),
    ];
    transientIds = ["macro-monthly-close"];
    render();
    expect(cardText("Monthly Close")).toContain("debugger");
    expect(cardText("Chart Script")).not.toContain("debugger");
  });

  // The tag has to FOLLOW the session. Starting/stopping a debug session mounts
  // and unmounts a macro without registering or removing an object script, so
  // `onScriptChange` never fires for it — the panel subscribes to debug state
  // for exactly this reason, and a stale tag would misreport what is running.
  it("drops the tag when the session stops, on a debug broadcast alone", () => {
    handles = [handle()];
    transientIds = ["macro-monthly-close"];
    render();
    expect(container.textContent).toContain("debugger");

    // Stop: the host unmounts it and clears the transient marker.
    handles = [];
    transientIds = [];
    act(() => {
      for (const l of [...debugListeners]) l();
    });
    expect(container.textContent).not.toContain("debugger");
    expect(container.textContent).toContain("No scripts are currently mounted.");
  });

  it("adds the tag when a session opens, on a debug broadcast alone", () => {
    render();
    expect(container.textContent).toContain("No scripts are currently mounted.");

    handles = [handle()];
    transientIds = ["macro-monthly-close"];
    act(() => {
      for (const l of [...debugListeners]) l();
    });
    expect(container.textContent).toContain("Monthly Close");
    expect(container.textContent).toContain("debugger");
  });

  it("unsubscribes from debug state on unmount", () => {
    handles = [handle()];
    render();
    expect(debugListeners.length).toBe(1);
    act(() => root.unmount());
    expect(debugListeners.length).toBe(0);
    // Re-created so afterEach's unmount is harmless.
    root = createRoot(container);
  });
});

// ===========================================================================
// The origin chip — the panel's other label that must not be able to lie
// ===========================================================================
//
// Beside the tier tag, each card carries a chip saying where the code came from:
// "local" for workbook-authored scripts, the package name otherwise, with a
// matching tooltip. It branched on `h.origin === "local"` against a string that
// carried EITHER that sentinel OR the publisher's chosen application name — so
// an application named `local` wore the local chip AND the "Authored in this
// workbook" tooltip, in the panel whose entire job is to say where code resides.
// `ScriptHandle.origin` is now a discriminated `ScriptOrigin`: the chip branches
// on `kind` and DISPLAYS `name`.

describe("PermissionsPanel — the origin chip", () => {
  beforeEach(() => {
    transientIds = [];
    handles = [];
    debugListeners = [];
    scriptChangeListeners = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  /** The chip's tooltip for the card carrying `scriptName`. */
  function chipTitle(scriptName: string): string {
    const card = [...container.querySelectorAll("div")]
      .filter((d) => d.textContent?.includes(scriptName))
      .pop();
    const chip = [...(card?.querySelectorAll("span") ?? [])].find((s) =>
      (s.getAttribute("title") ?? "").length > 0,
    );
    return chip?.getAttribute("title") ?? "";
  }

  it("says the workbook for workbook-authored code", () => {
    handles = [handle()];
    render();
    expect(chipTitle("Monthly Close")).toBe("Authored in this workbook");
  });

  it("names the package for distributed code", () => {
    handles = [
      handle({
        scriptId: "acme-1",
        scriptName: "Acme Sync",
        origin: { kind: "package", name: "Acme Reports" },
      }),
    ];
    render();
    expect(chipTitle("Acme Sync")).toBe('From package "Acme Reports"');
    expect(container.textContent).toContain("Acme Reports");
  });

  it("does not let an application NAMED `local` wear the workbook's chip", () => {
    // THE REGRESSION. Under the old bare-string origin this tooltip read
    // "Authored in this workbook" for somebody else's distributed code.
    handles = [
      handle({
        scriptId: "pkg-local-1",
        scriptName: "Quarterly Report",
        origin: { kind: "package", name: "local" },
      }),
    ];
    render();
    expect(chipTitle("Quarterly Report")).toBe('From package "local"');
    expect(chipTitle("Quarterly Report")).not.toBe("Authored in this workbook");
  });
});
