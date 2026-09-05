//! FILENAME: app/extensions/ScriptableObjects/__tests__/scriptPaneHost.test.ts
// PURPOSE: The listeners that turn the pane registry's events into Shell
//          panels (M2 S4): request -> registerPanel + openPanel + "docked";
//          patch -> the pane's state / badge / reveal; the user's close ->
//          the registry FIRST; close -> unregisterPanel.
// CONTEXT: Two things are easy to get wrong here and are pinned by name. The
//          "docked" acknowledgement carries the EFFECTIVE placement read back
//          from the panel system (the registry answers reveal() honestly from
//          it — openPanel is a no-op on the ribbon), not the placement asked
//          for. And a user-owned close goes to the registry and the panel
//          comes down on the CLOSE it answers with — proven against the REAL
//          registry, so the script's onPaneClose fires with reason "user".

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PanelDefinition, PanelSectionProps } from "@api/uiTypes";
import { emitAppEvent, onAppEvent } from "@api/events";
import { registerToastSink, type ToastPayload } from "@api/notifications";
import type { FormSpec } from "@api/scriptHost/scriptFormSpec";
import {
  SCRIPT_PANE_CLOSE_EVENT,
  SCRIPT_PANE_INPUT_EVENT,
  SCRIPT_PANE_PATCH_EVENT,
  SCRIPT_PANE_REQUEST_EVENT,
  type ScriptPaneClosePayload,
  type ScriptPaneInputPayload,
  type ScriptPanePatchPayload,
  type ScriptPaneRequestPayload,
} from "@api/scriptHost/scriptPaneSpec";
import { closeScriptPane, dockScriptPane, resetScriptPanes, type PaneSessionDeps } from "@api/scriptHost/scriptPanes";
import {
  PANEL_PLACEMENT_CHANGED_EVENT,
  installScriptPaneHost,
  scriptPanePanelId,
  type ScriptPaneHostDeps,
} from "../lib/scriptPaneHost";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const SPEC: FormSpec = {
  title: "Status",
  children: [
    { type: "textbox", name: "note", label: "Note" },
    { type: "number", name: "amount", label: "Amount", default: 5 },
    { type: "button", name: "refresh", text: "Refresh" },
  ],
};

function request(over: Partial<ScriptPaneRequestPayload> = {}): ScriptPaneRequestPayload {
  return {
    paneId: "pane-1",
    paneKey: "0",
    scriptId: "script-1",
    scriptName: "Status board",
    origin: { kind: "local" },
    spec: SPEC,
    seeds: { note: { value: "hi" } },
    // The registry decides this from its gesture window; the default here is
    // the dock the user just triggered, which is the case most of this file is
    // about. The section below drives `open: false` on purpose.
    open: true,
    ...over,
  };
}

/** The panel id is the script and the pane's STABLE key ("0"), never `pane-1`. */
const PANEL_ID = scriptPanePanelId("script-1", "0");

interface MockDeps extends ScriptPaneHostDeps {
  register: ReturnType<typeof vi.fn>;
  unregister: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
  getPlacement: ReturnType<typeof vi.fn>;
  badge: ReturnType<typeof vi.fn>;
  registered: () => PanelDefinition;
}

function mockDeps(placement: "sidebar" | "ribbon" = "sidebar"): MockDeps {
  const register = vi.fn();
  const unregister = vi.fn();
  const open = vi.fn();
  const getPlacement = vi.fn(() => placement);
  const badge = vi.fn();
  return {
    register,
    unregister,
    open,
    getPlacement,
    badge,
    panels: {
      register: (d: PanelDefinition) => register(d),
      unregister: (id: string) => unregister(id),
      open: (id: string) => open(id),
      getPlacement: (id: string) => getPlacement(id),
    },
    setBadge: (id, text) => badge(id, text),
    registered: () => register.mock.calls[0][0] as PanelDefinition,
  };
}

let inputs: ScriptPaneInputPayload[] = [];
let offInput: (() => void) | null = null;
let uninstall: (() => void) | null = null;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}

/** Mount the section the wiring registered, as the Shell would in the sidebar. */
async function mountRegistered(deps: MockDeps, onClose?: () => void): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const Section = deps.registered().sections[0].component as React.ComponentType<PanelSectionProps>;
  await act(async () => {
    root!.render(React.createElement(Section, { placement: "sidebar", onClose }));
  });
  await settle();
  return container;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

beforeEach(() => {
  inputs = [];
  offInput = onAppEvent<ScriptPaneInputPayload>(SCRIPT_PANE_INPUT_EVENT, (d) => {
    inputs.push(d);
  });
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
  uninstall?.();
  uninstall = null;
  offInput?.();
  offInput = null;
  resetScriptPanes();
});

// ----------------------------------------------------------------------------
// request -> registerPanel + openPanel + docked
// ----------------------------------------------------------------------------

describe("request", () => {
  it("registers ONE panel per pane, opens it, and acknowledges 'docked' with the initial values", () => {
    const deps = mockDeps();
    uninstall = installScriptPaneHost(deps);
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request());

    expect(deps.register).toHaveBeenCalledTimes(1);
    const def = deps.registered();
    expect(def.id).toBe(PANEL_ID);
    expect(def.title).toBe("Status board");
    expect(def.defaultPlacement).toBe("sidebar");
    expect(def.sections).toHaveLength(1);
    expect(def.sections[0].ribbonPresentation).toBe("launcher");
    expect(deps.open).toHaveBeenCalledWith(PANEL_ID);

    expect(inputs).toEqual([
      { paneId: "pane-1", kind: "docked", placement: "sidebar", values: { note: "hi", amount: 5 } },
    ]);
  });

  it("the 'docked' placement is the EFFECTIVE one read back from the panel system", () => {
    const deps = mockDeps("ribbon");
    uninstall = installScriptPaneHost(deps);
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request());
    expect(deps.getPlacement).toHaveBeenCalledWith(PANEL_ID);
    expect(inputs[0]).toMatchObject({ kind: "docked", placement: "ribbon" });
  });

  it("two panes are two panels; a repeated pane id is ignored, never an upsert over a live pane", () => {
    const deps = mockDeps();
    uninstall = installScriptPaneHost(deps);
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request());
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request({ paneId: "pane-2", paneKey: "1" }));
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request());
    expect(deps.register).toHaveBeenCalledTimes(2);
    expect(deps.register.mock.calls.map((c) => (c[0] as PanelDefinition).id)).toEqual([
      PANEL_ID,
      scriptPanePanelId("script-1", "1"),
    ]);
    expect(inputs.filter((p) => p.kind === "docked")).toHaveLength(2);
  });

  it("the panel id is built from the pane's STABLE key, never its per-session id — so a re-dock finds the user's placement", () => {
    // The Shell persists the user's placement choice by panel id. `pane-7`
    // becomes `pane-8` on the next dock; the key stays "0", and so must the id.
    const deps = mockDeps();
    uninstall = installScriptPaneHost(deps);
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request({ paneId: "pane-7", paneKey: "0" }));
    expect(deps.registered().id).toBe(PANEL_ID);
    expect(deps.registered().id).not.toContain("pane-7");
    emitAppEvent(SCRIPT_PANE_CLOSE_EVENT, { paneId: "pane-7", reason: "user" } satisfies ScriptPaneClosePayload);
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request({ paneId: "pane-8", paneKey: "0" }));
    expect(deps.register.mock.calls.map((c) => (c[0] as PanelDefinition).id)).toEqual([PANEL_ID, PANEL_ID]);
    // ...and the placement the wiring reads back is asked for under that same id.
    expect(deps.getPlacement.mock.calls.map((c) => c[0])).toEqual([PANEL_ID, PANEL_ID]);
    // A script-chosen key is the segment verbatim.
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request({ paneId: "pane-9", paneKey: "status" }));
    expect(deps.register.mock.calls.at(-1)![0].id).toBe("scriptable-objects.pane.script-1.status");
  });

  it("a request whose PANEL id is already live is ignored — registerPanel upserts silently", () => {
    // The registry refuses a duplicate live key upstream; this is the wiring's
    // own refusal to replace a panel underneath a live store if that guard is gone.
    const deps = mockDeps();
    uninstall = installScriptPaneHost(deps);
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request({ paneId: "pane-1", paneKey: "0" }));
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request({ paneId: "pane-2", paneKey: "0" }));
    expect(deps.register).toHaveBeenCalledTimes(1);
    expect(inputs.filter((p) => p.kind === "docked").map((p) => p.paneId)).toEqual(["pane-1"]);
  });

  it("a malformed request registers nothing", () => {
    const deps = mockDeps();
    uninstall = installScriptPaneHost(deps);
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, { paneId: 7 });
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, null);
    // No key: there is nothing stable to build the panel id from.
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, { ...request(), paneKey: undefined });
    expect(deps.register).not.toHaveBeenCalled();
    expect(inputs).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// Registering is not opening, and the user's placement survives a key rotation
// ----------------------------------------------------------------------------

/**
 * Panel deps that answer `getPlacement` the way `panelRegistry` does — the
 * user's persisted override for that exact panel id, else the
 * `defaultPlacement` the panel was registered with. The fall-back under test
 * lives in that second half, so a mock that returned a constant (as `mockDeps`
 * does) could not see it at all.
 */
function placementAwareDeps(): MockDeps & {
  move: (panelId: string, to: "sidebar" | "ribbon") => void;
  preset: (panelId: string, to: "sidebar" | "ribbon") => void;
} {
  const overrides = new Map<string, "sidebar" | "ribbon">();
  const defaults = new Map<string, "sidebar" | "ribbon">();
  const base = mockDeps();
  const register = (d: PanelDefinition): void => {
    defaults.set(d.id, (d.defaultPlacement ?? "sidebar") as "sidebar" | "ribbon");
    base.register(d);
  };
  const getPlacement = (id: string): "sidebar" | "ribbon" =>
    overrides.get(id) ?? defaults.get(id) ?? "sidebar";
  const deps = {
    ...base,
    panels: { ...base.panels, register, getPlacement: (id: string) => getPlacement(id) },
    /** The user's own move: the Shell records it and announces it. */
    move: (panelId: string, to: "sidebar" | "ribbon") => {
      const from = getPlacement(panelId);
      overrides.set(panelId, to);
      emitAppEvent(PANEL_PLACEMENT_CHANGED_EVENT, { panelId, oldPlacement: from, newPlacement: to });
    },
    /** A choice made in an EARLIER session: already in the persisted store, announced by nobody. */
    preset: (panelId: string, to: "sidebar" | "ribbon") => {
      overrides.set(panelId, to);
    },
  };
  return deps;
}

describe("taking the screen", () => {
  it("a dock the registry did not admit to the screen registers and acknowledges, but never opens the panel", () => {
    const deps = mockDeps();
    uninstall = installScriptPaneHost(deps);
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request({ open: false }));
    // The pane exists: registered, listed, and the dock resolves honestly.
    expect(deps.register).toHaveBeenCalledTimes(1);
    expect(deps.registered().id).toBe(PANEL_ID);
    expect(inputs).toEqual([
      { paneId: "pane-1", kind: "docked", placement: "sidebar", values: { note: "hi", amount: 5 } },
    ]);
    // ...but the sidebar stayed where the user left it. `openPanel` forces it
    // open AND switches the active view away from whatever was there.
    expect(deps.open).not.toHaveBeenCalled();
  });

  it("a later reveal still opens it — the dock's bound is on the dock, not on the panel", () => {
    const deps = mockDeps();
    uninstall = installScriptPaneHost(deps);
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request({ open: false }));
    emitAppEvent(SCRIPT_PANE_PATCH_EVENT, { paneId: "pane-1", reveal: true } satisfies ScriptPanePatchPayload);
    expect(deps.open).toHaveBeenCalledWith(PANEL_ID);
  });
});

describe("the placement the user chose survives a key rotation", () => {
  it("a pane docked under a NEW key defaults to where the user last put a pane of that script", () => {
    // The Shell remembers a placement per PANEL id, and a pane's panel id
    // carries the key the SCRIPT chose. So "move it to the ribbon" — the user's
    // only escape from a pane they do not want in the sidebar — was undone by
    // one character: a new key is a new id with no override, and the registry's
    // "sidebar" default put it straight back.
    const deps = placementAwareDeps();
    uninstall = installScriptPaneHost(deps);
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request({ paneKey: "0" }));
    deps.move(PANEL_ID, "ribbon");
    emitAppEvent(SCRIPT_PANE_CLOSE_EVENT, { paneId: "pane-1", reason: "script" } satisfies ScriptPaneClosePayload);

    inputs = [];
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request({ paneId: "pane-2", paneKey: "rotated" }));
    const rotated = deps.register.mock.calls.at(-1)![0] as PanelDefinition;
    expect(rotated.id).toBe(scriptPanePanelId("script-1", "rotated"));
    expect(rotated.defaultPlacement).toBe("ribbon");
    // ...so the pane comes back on the ribbon, and the registry hears that:
    // `openPanel` does nothing there and reveal() answers honestly.
    expect(inputs).toEqual([
      { paneId: "pane-2", kind: "docked", placement: "ribbon", values: { note: "hi", amount: 5 } },
    ]);
  });

  it("a choice made in an EARLIER session carries too — it is read back off the first pane and remembered", () => {
    // Nothing announces a stored placement at start-up; the only place this
    // wiring can learn one is the placement it reads back after registering the
    // script's first pane. Without that seed the fall-back would know nothing
    // until the user moved a pane AGAIN, in this session, and a key rotation
    // straight after a restart would land in the sidebar.
    const deps = placementAwareDeps();
    deps.preset(PANEL_ID, "ribbon");
    uninstall = installScriptPaneHost(deps);
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request({ paneKey: "0" }));
    emitAppEvent(SCRIPT_PANE_CLOSE_EVENT, { paneId: "pane-1", reason: "script" } satisfies ScriptPaneClosePayload);
    inputs = [];
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request({ paneId: "pane-2", paneKey: "rotated" }));
    expect((deps.register.mock.calls.at(-1)![0] as PanelDefinition).defaultPlacement).toBe("ribbon");
    expect(inputs[0]).toMatchObject({ kind: "docked", placement: "ribbon" });
  });

  it("one script's choice is not another's, and an explicit choice for the new pane still wins", () => {
    const deps = placementAwareDeps();
    uninstall = installScriptPaneHost(deps);
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request({ paneKey: "0" }));
    deps.move(PANEL_ID, "ribbon");
    // A different script starts where every panel starts.
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request({ paneId: "pane-2", scriptId: "script-2", paneKey: "0" }));
    const other = deps.register.mock.calls.at(-1)![0] as PanelDefinition;
    expect(other.id).toBe(scriptPanePanelId("script-2", "0"));
    expect(other.defaultPlacement).toBe("sidebar");
    // And the user's own choice for a SPECIFIC pane outranks the fall-back: a
    // stored "sidebar" for script-1's "notes" pane wins over the remembered
    // "ribbon", because the fall-back is only what the panel system reaches for
    // when the user has said nothing about that id. The pane must be
    // acknowledged with what the panel system ACTUALLY decided, never with what
    // this wiring remembered.
    deps.preset(scriptPanePanelId("script-1", "notes"), "sidebar");
    inputs = [];
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request({ paneId: "pane-3", paneKey: "notes" }));
    expect(inputs[0]).toMatchObject({ kind: "docked", placement: "sidebar" });
  });
});

// ----------------------------------------------------------------------------
// patch -> state / badge / reveal
// ----------------------------------------------------------------------------

describe("patch", () => {
  it("a script patch reaches the mounted pane's state; a badge reaches the panel; a reveal re-opens it", async () => {
    const deps = mockDeps();
    uninstall = installScriptPaneHost(deps);
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request());
    const el = await mountRegistered(deps);
    expect(inputs.map((p) => p.kind)).toEqual(["docked", "visible"]);

    await act(async () => {
      const payload: ScriptPanePatchPayload = { paneId: "pane-1", patch: { values: { note: "patched" } } };
      emitAppEvent(SCRIPT_PANE_PATCH_EVENT, payload);
    });
    await settle();
    expect(el.querySelector<HTMLInputElement>('[data-form-widget="note"]')!.value).toBe("patched");
    // No echo: nothing left for the registry because of the patch.
    expect(inputs.map((p) => p.kind)).toEqual(["docked", "visible"]);

    emitAppEvent(SCRIPT_PANE_PATCH_EVENT, { paneId: "pane-1", badge: "3" } satisfies ScriptPanePatchPayload);
    expect(deps.badge).toHaveBeenCalledWith(PANEL_ID, "3");
    emitAppEvent(SCRIPT_PANE_PATCH_EVENT, { paneId: "pane-1", badge: null } satisfies ScriptPanePatchPayload);
    expect(deps.badge).toHaveBeenLastCalledWith(PANEL_ID, null);

    deps.open.mockClear();
    emitAppEvent(SCRIPT_PANE_PATCH_EVENT, { paneId: "pane-1", reveal: true } satisfies ScriptPanePatchPayload);
    expect(deps.open).toHaveBeenCalledWith(PANEL_ID);
  });

  it("a patch for a pane this renderer does not hold is ignored", () => {
    const deps = mockDeps();
    uninstall = installScriptPaneHost(deps);
    emitAppEvent(SCRIPT_PANE_PATCH_EVENT, { paneId: "pane-9", badge: "1" } satisfies ScriptPanePatchPayload);
    expect(deps.badge).not.toHaveBeenCalled();
    expect(deps.open).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------------
// placement
// ----------------------------------------------------------------------------

describe("placement", () => {
  it("the user moving the panel reaches the registry as a 'placement' input — for OUR panel only", () => {
    const deps = mockDeps();
    uninstall = installScriptPaneHost(deps);
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request());
    emitAppEvent(PANEL_PLACEMENT_CHANGED_EVENT, { panelId: "home", oldPlacement: "ribbon", newPlacement: "sidebar" });
    expect(inputs.filter((p) => p.kind === "placement")).toEqual([]);
    emitAppEvent(PANEL_PLACEMENT_CHANGED_EVENT, { panelId: PANEL_ID, oldPlacement: "sidebar", newPlacement: "ribbon" });
    expect(inputs.filter((p) => p.kind === "placement")).toEqual([
      { paneId: "pane-1", kind: "placement", placement: "ribbon", values: { note: "hi", amount: 5 } },
    ]);
  });
});

// ----------------------------------------------------------------------------
// close -> unregisterPanel
// ----------------------------------------------------------------------------

describe("close", () => {
  it("the host's CLOSE takes the panel down and later patches land nowhere", async () => {
    const deps = mockDeps();
    uninstall = installScriptPaneHost(deps);
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request());
    await mountRegistered(deps);
    inputs = [];
    emitAppEvent(SCRIPT_PANE_CLOSE_EVENT, { paneId: "pane-1", reason: "script" } satisfies ScriptPaneClosePayload);
    expect(deps.unregister).toHaveBeenCalledWith(PANEL_ID);
    emitAppEvent(SCRIPT_PANE_PATCH_EVENT, { paneId: "pane-1", badge: "9" } satisfies ScriptPanePatchPayload);
    expect(deps.badge).not.toHaveBeenCalled();
    // The store was disposed BEFORE the unregister could unmount the section:
    // no "hidden" for a pane that is already gone.
    await act(async () => {
      root!.unmount();
    });
    root = null;
    expect(inputs).toEqual([]);
  });

  it("teardown takes every live panel down", () => {
    const deps = mockDeps();
    const off = installScriptPaneHost(deps);
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request());
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request({ paneId: "pane-2", paneKey: "1" }));
    off();
    expect(deps.unregister.mock.calls.map((c) => c[0])).toEqual([PANEL_ID, scriptPanePanelId("script-1", "1")]);
    // ...and listens no more.
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request({ paneId: "pane-3", paneKey: "2" }));
    expect(deps.register).toHaveBeenCalledTimes(2);
  });

  it("a user close that no session answers still takes the orphaned panel down", async () => {
    const deps = mockDeps();
    uninstall = installScriptPaneHost(deps);
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request());
    const onHostClose = vi.fn();
    const el = await mountRegistered(deps, onHostClose);
    await click(el.querySelector("[data-script-pane-close]")!);
    expect(inputs.map((p) => p.kind)).toEqual(["docked", "visible", "close"]);
    expect(deps.unregister).toHaveBeenCalledWith(PANEL_ID);
    expect(onHostClose).toHaveBeenCalledTimes(1);
  });
});

// ----------------------------------------------------------------------------
// The user-owned close, against the REAL registry
// ----------------------------------------------------------------------------

describe("with the real registry", () => {
  function recordingDeps() {
    const closedWith: Array<{ paneId: string; reason: string }> = [];
    const forwarded: Array<{ hook: string; payload: unknown }> = [];
    const deps: PaneSessionDeps = {
      forward: (hook, payload) => forwarded.push({ hook, payload }),
      mirror: () => {},
      closed: (paneId, reason) => closedWith.push({ paneId, reason }),
    };
    return { deps, closedWith, forwarded };
  }

  it("dock() resolves on the wiring's acknowledgement, and the pane's X ends the session as 'user'", async () => {
    const panels = mockDeps();
    uninstall = installScriptPaneHost(panels);
    const rec = recordingDeps();

    const docked = await dockScriptPane({
      scriptId: "script-1",
      scriptName: "Status board",
      origin: { kind: "local" },
      spec: SPEC,
      deps: rec.deps,
    });
    expect(panels.register).toHaveBeenCalledTimes(1);
    // The registry's first slot for this script is "0" (the placement key), whatever the session id.
    const panelId = scriptPanePanelId("script-1", "0");
    expect(panels.registered().id).toBe(panelId);

    const el = await mountRegistered(panels);
    await click(el.querySelector("[data-script-pane-close]")!);

    // The registry ended the session as the USER's doing, told the worker, and
    // answered with CLOSE — which is what took the panel down.
    expect(rec.closedWith).toEqual([{ paneId: docked.paneId, reason: "user" }]);
    expect(rec.forwarded.map((f) => f.hook)).toContain("onPaneClose");
    const closeHook = rec.forwarded.find((f) => f.hook === "onPaneClose")!.payload as { reason: string };
    expect(closeHook.reason).toBe("user");
    expect(panels.unregister).toHaveBeenCalledWith(panelId);
  });

  it("a script's close (the registry's CLOSE) takes the panel down without any input from the renderer", async () => {
    const panels = mockDeps();
    uninstall = installScriptPaneHost(panels);
    const rec = recordingDeps();
    const docked = await dockScriptPane({
      scriptId: "script-1",
      scriptName: "Status board",
      origin: { kind: "local" },
      spec: SPEC,
      deps: rec.deps,
    });
    inputs = [];
    emitAppEvent(SCRIPT_PANE_CLOSE_EVENT, { paneId: docked.paneId, reason: "script" } satisfies ScriptPaneClosePayload);
    expect(panels.unregister).toHaveBeenCalledWith(scriptPanePanelId("script-1", "0"));
    expect(inputs).toEqual([]);
  });

  it("dock, close, dock again registers the SAME panel id under a new session id", async () => {
    const panels = mockDeps();
    uninstall = installScriptPaneHost(panels);
    const rec = recordingDeps();
    const owner = { scriptId: "script-1", scriptName: "Status board", origin: { kind: "local" } as const, spec: SPEC };
    const first = await dockScriptPane({ ...owner, deps: rec.deps });
    closeScriptPane("script-1", first.paneId);
    const second = await dockScriptPane({ ...owner, deps: rec.deps });
    expect(second.paneId).not.toBe(first.paneId);
    const ids = panels.register.mock.calls.map((c) => (c[0] as PanelDefinition).id);
    expect(ids).toEqual([scriptPanePanelId("script-1", "0"), scriptPanePanelId("script-1", "0")]);
    expect(panels.unregister.mock.calls.map((c) => c[0])).toEqual([scriptPanePanelId("script-1", "0")]);
  });
});

// ----------------------------------------------------------------------------
// S6 — the host banner's door, a reveal's (absent) focus, the throttled close
// ----------------------------------------------------------------------------

describe("the hostile-script hardening (S6)", () => {
  it("a hostBanner patch reaches the pane's own slot, and a script's message patch beside it leaves it alone", async () => {
    const deps = mockDeps();
    uninstall = installScriptPaneHost(deps);
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request());
    const el = await mountRegistered(deps);
    await act(async () => {
      emitAppEvent(SCRIPT_PANE_PATCH_EVENT, {
        paneId: "pane-1",
        hostBanner: { text: "Slowed down.", kind: "warning" },
      } satisfies ScriptPanePatchPayload);
    });
    await settle();
    expect(el.querySelector("[data-script-pane-host-banner]")?.textContent).toBe("Slowed down.");
    await act(async () => {
      emitAppEvent(SCRIPT_PANE_PATCH_EVENT, {
        paneId: "pane-1",
        patch: { message: { text: "Nothing to see", kind: "info" } },
      } satisfies ScriptPanePatchPayload);
    });
    await settle();
    expect(el.querySelector("[data-script-pane-host-banner]")?.textContent).toBe("Slowed down.");
    expect(el.querySelector("[data-script-pane-message]")?.textContent).toBe("Nothing to see");
    await act(async () => {
      emitAppEvent(SCRIPT_PANE_PATCH_EVENT, { paneId: "pane-1", hostBanner: null } satisfies ScriptPanePatchPayload);
    });
    await settle();
    expect(el.querySelector("[data-script-pane-host-banner]")).toBeNull();
  });

  it("a hostBindingNotice patch takes its own door too: the script's message stands beside it and survives its clear", async () => {
    const deps = mockDeps();
    uninstall = installScriptPaneHost(deps);
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request());
    const el = await mountRegistered(deps);
    const notice = 'The cells this pane is bound to are on "Sheet1" — switch back to see and save them';
    await act(async () => {
      emitAppEvent(SCRIPT_PANE_PATCH_EVENT, {
        paneId: "pane-1",
        hostBindingNotice: { text: notice, kind: "warning" },
      } satisfies ScriptPanePatchPayload);
    });
    await settle();
    expect(el.querySelector("[data-script-pane-binding-notice]")?.textContent).toBe(notice);
    // The script paints its own sentence: its own slot, below, and the host's
    // notice is untouched.
    await act(async () => {
      emitAppEvent(SCRIPT_PANE_PATCH_EVENT, {
        paneId: "pane-1",
        patch: { message: { text: "Everything is fine", kind: "info" } },
      } satisfies ScriptPanePatchPayload);
    });
    await settle();
    expect(el.querySelector("[data-script-pane-binding-notice]")?.textContent).toBe(notice);
    expect(el.querySelector("[data-script-pane-message]")?.textContent).toBe("Everything is fine");
    // The user returns to the pinned sheet: the host's clear names its slot
    // only, so the script's message is still on the pane.
    await act(async () => {
      emitAppEvent(SCRIPT_PANE_PATCH_EVENT, {
        paneId: "pane-1",
        hostBindingNotice: null,
      } satisfies ScriptPanePatchPayload);
    });
    await settle();
    expect(el.querySelector("[data-script-pane-binding-notice]")).toBeNull();
    expect(el.querySelector("[data-script-pane-message]")?.textContent).toBe("Everything is fine");
  });

  it("a reveal opens the panel and takes NO keyboard focus from where the user has it", async () => {
    const deps = mockDeps();
    uninstall = installScriptPaneHost(deps);
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request());
    const el = await mountRegistered(deps);
    const grid = document.createElement("input");
    document.body.appendChild(grid);
    try {
      await act(async () => {
        grid.focus();
      });
      deps.open.mockClear();
      await act(async () => {
        emitAppEvent(SCRIPT_PANE_PATCH_EVENT, { paneId: "pane-1", reveal: true } satisfies ScriptPanePatchPayload);
      });
      await settle();
      expect(deps.open).toHaveBeenCalledWith(PANEL_ID);
      expect(document.activeElement).toBe(grid);
      expect(el.contains(document.activeElement)).toBe(false);
    } finally {
      grid.remove();
    }
  });

  it("a CLOSE with reason 'throttled' tells the USER in a toast naming the script; every other reason is silent", () => {
    const toasts: ToastPayload[] = [];
    registerToastSink((t) => toasts.push(t));
    try {
      const deps = mockDeps();
      uninstall = installScriptPaneHost(deps);
      emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request());
      emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request({ paneId: "pane-2", paneKey: "1" }));
      emitAppEvent(SCRIPT_PANE_CLOSE_EVENT, { paneId: "pane-2", reason: "script" } satisfies ScriptPaneClosePayload);
      expect(toasts).toEqual([]);
      emitAppEvent(SCRIPT_PANE_CLOSE_EVENT, { paneId: "pane-1", reason: "throttled" } satisfies ScriptPaneClosePayload);
      expect(toasts).toHaveLength(1);
      expect(toasts[0].variant).toBe("warning");
      expect(toasts[0].message).toContain('"Status board"');
      expect(toasts[0].message).toContain("closed");
      // ...and says what is TRUE of every route into a throttled close. Three
      // different refusals climb that ladder (a dropped update or badge, a
      // refused reveal) and the CLOSE event carries only the reason, so a
      // toast that accused the script of "updating" would be a guess — and a
      // wrong one for a script that only ever looped `pane.reveal()`.
      expect(toasts[0].message).toContain("more task-pane calls than Calcula allows");
      expect(toasts[0].message).not.toContain("updating");
      // The refusal names what the user can do about it.
      expect(toasts[0].message).toContain("Run the script again to open it.");
      expect(deps.unregister.mock.calls.map((c) => c[0])).toEqual([scriptPanePanelId("script-1", "1"), PANEL_ID]);
      // A pane this renderer does not hold says nothing, whatever the reason.
      emitAppEvent(SCRIPT_PANE_CLOSE_EVENT, { paneId: "pane-9", reason: "throttled" } satisfies ScriptPaneClosePayload);
      expect(toasts).toHaveLength(1);
    } finally {
      registerToastSink(() => undefined);
    }
  });
});
