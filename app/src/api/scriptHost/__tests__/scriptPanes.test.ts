//! FILENAME: app/src/api/scriptHost/__tests__/scriptPanes.test.ts
// PURPOSE: The host half of script-defined TASK PANES (M2 S3), headless: the
//          per-script cap, the dock bucket, the update bucket, ownership, the
//          honest reveal, the multi-layout table, and the sweeps.
// CONTEXT: The invariant worth the most is the NEGATIVE one: a pane takes NONE
//          of the modal's machinery. Docking a pane must leave the app-wide
//          modal slot free (a dialog can still be asked while three panes are
//          up), must hold no worker deadline (the deps type has no such
//          member), and must run no idle clock (a pane untouched for hours is
//          still there). Every close path lands on `closed(paneId, reason)`
//          exactly once, and a script may act only on panes it owns.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  closeScriptPane,
  dockScriptPane,
  listScriptPanes,
  noteScriptGesture,
  refreshScriptPaneSeeds,
  resetScriptPanes,
  revealScriptPane,
  revokeScriptPanes,
  setScriptPaneBadge,
  updateScriptPane,
  type PaneRefusalAudit,
  type PaneSessionDeps,
} from "../scriptPanes";
import {
  MAX_PANES_PER_SCRIPT,
  PANE_DOCKED_ACK_TIMEOUT_MS,
  PANE_DOCKS_PER_MINUTE,
  PANE_REVEAL_GESTURE_WINDOW_MS,
  PANE_REVEALS_PER_MINUTE,
  PANE_THROTTLE_BANNER_AT,
  PANE_THROTTLE_BANNER_CLEAR_AT,
  PANE_THROTTLE_CLOSE_WINDOW_MS,
  PANE_THROTTLE_COOLDOWN_AT,
  PANE_THROTTLE_COOLDOWN_MS,
  PANE_UPDATE_PER_SECOND,
  PANE_UPDATE_WINDOW_MS,
  SCRIPT_PANE_CLOSE_EVENT,
  SCRIPT_PANE_INPUT_EVENT,
  SCRIPT_PANE_PATCH_EVENT,
  SCRIPT_PANE_REQUEST_EVENT,
  type PanePlacement,
  type ScriptPaneClosePayload,
  type ScriptPaneInputPayload,
  type ScriptPanePatchPayload,
  type ScriptPaneRequestPayload,
} from "../scriptPaneSpec";
import {
  FORM_TEXT_CHANGE_DEBOUNCE_MS,
  MAX_FORM_CHANGE_FANOUT,
  defineScriptForm,
  getScriptFormSpec,
  getScriptLayoutSpec,
  resetScriptForms,
  revokeScriptForms,
} from "../scriptForms";
import { type FormSpec } from "../scriptFormSpec";
import { getActiveModal, requestScriptDialog, resetScriptDialogs } from "../scriptDialogs";
import { emitAppEvent } from "../../events";
import { BrokerError } from "../broker";

// ----------------------------------------------------------------------------
// Harness
// ----------------------------------------------------------------------------

const SPEC: FormSpec = {
  title: "Status",
  children: [
    { type: "textbox", name: "note", label: "Note" },
    { type: "checkbox", name: "done", label: "Done" },
    { type: "button", name: "refresh", text: "Refresh" },
  ],
};

interface RecordingDeps extends PaneSessionDeps {
  forwarded: Array<{ hook: string; payload: unknown }>;
  mirrors: Array<{ path: string; value: unknown }>;
  closedWith: Array<{ paneId: string; reason: string }>;
  openedIds: string[];
  /** Every visibility transition the host was told about, in order. */
  visibility: Array<{ paneId: string; visible: boolean }>;
  /** Every write the session asked for (a `writeOn: "change"` widget). */
  writes: Array<{ paneId: string; names: string[]; values: Record<string, unknown> }>;
  /** What the next write answers: the names written, or a refusal. */
  nextWrite: (() => Promise<string[]>) | null;
  /** Every registry-decided refusal handed to the audit ring (S6). */
  audits: Array<{ paneId: string } & PaneRefusalAudit>;
}

function recordingDeps(): RecordingDeps {
  const deps: RecordingDeps = {
    forwarded: [],
    mirrors: [],
    closedWith: [],
    openedIds: [],
    visibility: [],
    writes: [],
    nextWrite: null,
    audits: [],
    audit: (paneId, refusal) => deps.audits.push({ paneId, ...refusal }),
    forward: (hook, payload) => deps.forwarded.push({ hook, payload }),
    mirror: (path, value) => deps.mirrors.push({ path, value }),
    closed: (paneId, reason) => deps.closedWith.push({ paneId, reason }),
    opened: (paneId) => deps.openedIds.push(paneId),
    visible: (paneId) => deps.visibility.push({ paneId, visible: true }),
    hidden: (paneId) => deps.visibility.push({ paneId, visible: false }),
    writeBindings: (paneId, values, names) => {
      deps.writes.push({ paneId, names, values });
      return deps.nextWrite ? deps.nextWrite() : Promise.resolve(names);
    },
  };
  return deps;
}

/** Stand in for the trusted renderer (S4): capture what the host emits, answer back. */
function renderer() {
  const requests: ScriptPaneRequestPayload[] = [];
  const patches: ScriptPanePatchPayload[] = [];
  const closes: ScriptPaneClosePayload[] = [];
  const onReq = (e: Event) => requests.push((e as CustomEvent).detail as ScriptPaneRequestPayload);
  const onPatch = (e: Event) => patches.push((e as CustomEvent).detail as ScriptPanePatchPayload);
  const onClose = (e: Event) => closes.push((e as CustomEvent).detail as ScriptPaneClosePayload);
  window.addEventListener(SCRIPT_PANE_REQUEST_EVENT, onReq);
  window.addEventListener(SCRIPT_PANE_PATCH_EVENT, onPatch);
  window.addEventListener(SCRIPT_PANE_CLOSE_EVENT, onClose);
  const input = (payload: ScriptPaneInputPayload) => emitAppEvent(SCRIPT_PANE_INPUT_EVENT, payload);
  return {
    requests,
    patches,
    closes,
    last: () => requests[requests.length - 1],
    docked: (paneId: string, placement: PanePlacement = "sidebar", values: Record<string, unknown> = {}) =>
      input({ paneId, kind: "docked", placement, values: values as ScriptPaneInputPayload["values"] }),
    visible: (paneId: string, values: Record<string, unknown> = {}) =>
      input({ paneId, kind: "visible", placement: "sidebar", values: values as ScriptPaneInputPayload["values"] }),
    hidden: (paneId: string) => input({ paneId, kind: "hidden", values: {} }),
    placement: (paneId: string, placement: PanePlacement) =>
      input({ paneId, kind: "placement", placement, values: {} }),
    change: (paneId: string, name: string, value: unknown, values: Record<string, unknown>) =>
      input({
        paneId,
        kind: "change",
        name,
        value: value as ScriptPaneInputPayload["value"],
        values: values as ScriptPaneInputPayload["values"],
      }),
    click: (paneId: string, name: string) => input({ paneId, kind: "click", name, values: {} }),
    close: (paneId: string) => input({ paneId, kind: "close", values: {} }),
    stop: () => {
      window.removeEventListener(SCRIPT_PANE_REQUEST_EVENT, onReq);
      window.removeEventListener(SCRIPT_PANE_PATCH_EVENT, onPatch);
      window.removeEventListener(SCRIPT_PANE_CLOSE_EVENT, onClose);
    },
  };
}

const OWNER = { scriptId: "form-1", scriptName: "Status board", origin: { kind: "local" } as const, spec: SPEC };

/**
 * Dock + acknowledge, the happy start every session shares. No gesture is
 * stamped, so these docks REGISTER the pane without taking the screen
 * (`opened: false`) — everything below is about what a docked pane does, and a
 * pane behaves identically either way. The section that is about taking the
 * screen stamps its own gestures.
 */
async function dock(
  r: ReturnType<typeof renderer>,
  deps: RecordingDeps,
  placement: PanePlacement = "sidebar",
  owner = OWNER,
): Promise<string> {
  const promise = dockScriptPane({ ...owner, deps });
  const { paneId } = r.last();
  r.docked(paneId, placement, { note: "", done: false });
  await expect(promise).resolves.toEqual({ paneId, opened: false, placement });
  return paneId;
}

/**
 * Dock a pane the USER just asked for: a gesture first, so the dock is allowed
 * to TAKE THE SCREEN, and its acknowledgement then renews the window the way a
 * dock the user triggered does. What every reveal test below needs, because a
 * dock that only registered the pane earns the script nothing.
 */
async function dockOpened(
  r: ReturnType<typeof renderer>,
  deps: RecordingDeps,
  placement: PanePlacement = "sidebar",
  owner = OWNER,
): Promise<string> {
  noteScriptGesture(owner.scriptId);
  const promise = dockScriptPane({ ...owner, deps });
  const { paneId, open } = r.last();
  expect(open, "a dock inside the gesture window must be told to open").toBe(true);
  r.docked(paneId, placement, { note: "", done: false });
  // On the ribbon the wiring's openPanel does nothing, so the dock did not take
  // the screen even though it was allowed to — and says so.
  await expect(promise).resolves.toEqual({ paneId, opened: placement !== "ribbon", placement });
  return paneId;
}

/**
 * Dock + acknowledge and say NOTHING about whether it opened. For the tests
 * whose subject IS that decision: a helper that asserted it would red inside
 * itself and hide which of a test's own assertions the change actually broke.
 */
async function dockAny(r: ReturnType<typeof renderer>, deps: RecordingDeps, owner = OWNER): Promise<string> {
  const promise = dockScriptPane({ ...owner, deps });
  const { paneId } = r.last();
  r.docked(paneId, "sidebar", { note: "", done: false });
  await promise;
  return paneId;
}

describe("scriptPanes — sessions", () => {
  let r: ReturnType<typeof renderer>;
  let deps: RecordingDeps;

  beforeEach(() => {
    resetScriptDialogs();
    resetScriptForms();
    resetScriptPanes();
    r = renderer();
    deps = recordingDeps();
  });
  afterEach(() => {
    r.stop();
    resetScriptPanes();
    resetScriptForms();
    resetScriptDialogs();
    vi.useRealTimers();
  });

  it("emits a data-only request with HOST-supplied identity and resolves when DOCKED", async () => {
    const promise = dockScriptPane({ ...OWNER, initial: { note: "hi", notAWidget: 1, refresh: "x" }, deps });
    expect(r.requests).toHaveLength(1);
    const req = r.last();
    expect(req.scriptName).toBe("Status board");
    expect(req.origin).toEqual({ kind: "local" });
    expect(req.spec).toBe(SPEC);
    // Only INPUT widgets are seeded — a button and an unknown name are dropped.
    expect(Object.keys(req.seeds)).toEqual(["note"]);
    expect(req.seeds.note).toEqual({ value: "hi" });
    expect(listScriptPanes()).toEqual([
      {
        paneId: req.paneId,
        scriptId: "form-1",
        scriptName: "Status board",
        docked: false,
        visible: false,
        placement: null,
        // A DOCKED pane names no sheet placement (M3c): the field exists so the
        // transparency panel can tell a task pane from a form the user embedded
        // on a sheet, and for a dock the honest answer is null.
        embedPlacementId: null,
        badge: null,
        boundCells: 0,
        updatesLastMinute: 0,
      },
    ]);
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    r.docked(req.paneId, "sidebar", { note: "hi", done: false });
    await expect(promise).resolves.toEqual({ paneId: req.paneId, opened: false, placement: "sidebar" });
    expect(deps.openedIds).toEqual([req.paneId]);
    expect(deps.mirrors).toContainEqual({ path: `pane.isOpen.${req.paneId}`, value: true });
    expect(deps.mirrors).toContainEqual({ path: `pane.values.${req.paneId}`, value: { note: "hi", done: false } });
    expect(listScriptPanes()[0].placement).toBe("sidebar");
    expect(listScriptPanes()[0].docked).toBe(true);
  });

  // A HOST-MARKED SEED OWNS ITS VALUE, ON THIS SURFACE TOO. `resolveFormBindings`
  // (host.ts) is ONE PIPELINE FEEDING THREE SURFACES, so the read-only seeds a
  // form meets arrive at a pane identically: a Controls binding ("a control
  // value can be read, not written") and every binding the host REFUSED, whose
  // seed is nothing but the sentence the widget is captioned with. A script's
  // own number landing under one of those makes the caption say where a figure
  // came from that the script invented.
  const SEALED_SEED = {
    note: { value: "from the control", readOnly: true, reason: "a control value can be read, not written" },
  };

  it("a dock's `initial` cannot overwrite a seed the host marked read-only", async () => {
    const promise = dockScriptPane({
      ...OWNER,
      seeds: SEALED_SEED,
      initial: { note: "invented", done: true },
      deps,
    });
    const req = r.last();
    // The host's seed survives WHOLE — value and the sentence beneath it are one
    // fact, and the merge used to keep the second while replacing the first.
    expect(req.seeds.note).toEqual(SEALED_SEED.note);
    // NARROW, not a blanket refusal of `initial`: the script's own unbound
    // widget still docks on the default it asked for.
    expect(req.seeds.done).toEqual({ value: true });
    r.docked(req.paneId, "sidebar", { note: "from the control", done: true });
    await promise;
  });

  it("nor can a patch once the pane is docked — the name never reaches the renderer", async () => {
    const promise = dockScriptPane({ ...OWNER, seeds: SEALED_SEED, deps });
    const { paneId } = r.last();
    r.docked(paneId, "sidebar", { note: "from the control", done: false });
    await promise;

    updateScriptPane(OWNER.scriptId, paneId, {
      values: { note: "invented", done: true },
      message: { text: "refreshed" },
    });

    const patch = r.patches.at(-1)?.patch;
    expect(patch, "the update must still have reached the renderer").toBeDefined();
    // STRIPPED FROM THE PAYLOAD, not merely from the host's copy of the values:
    // `landFormPatch` applies `patch.values` on its own and consults no seed, so
    // a name left standing here would paint the script's number in the widget a
    // tick after the dock refused it.
    expect(patch!.values).toEqual({ done: true });
    // One rule about one widget: the rest of the patch travels untouched.
    expect(patch!.message).toEqual({ text: "refreshed" });
    // ...and the host's own mirror never adopted it either, so `pane.values`
    // and what is painted still agree.
    expect(deps.mirrors.at(-1)).toEqual({
      path: `pane.values.${paneId}`,
      value: { note: "from the control", done: true },
    });
  });

  it("takes NONE of the modal machinery: a docked pane leaves the modal slot free and holds no clock", async () => {
    // Fake timers BEFORE the dock: a clock armed at dock time under real
    // timers would never fire under a fake clock installed afterwards, and
    // the 24-hour assertion below would pass against a pane that closes
    // itself after thirty minutes (found by sabotage: a modal-style idle
    // timer added at "docked" left this test green until the order changed).
    vi.useFakeTimers();
    const paneId = await dock(r, deps);
    // The slot is free — proved by TAKING it while the pane is up.
    expect(getActiveModal()).toBeNull();
    const dialog = requestScriptDialog({
      scriptId: OWNER.scriptId,
      scriptName: OWNER.scriptName,
      scriptOrigin: { kind: "local" },
      kind: "alert",
      message: "hi",
    });
    expect(getActiveModal()?.scriptName).toBe("Status board");
    resetScriptDialogs();
    await dialog;
    // No suspend/resume ever reached the worker: the deps type has no such
    // member, and no forwarded event or mirror mentions a deadline.
    expect(Object.keys(deps)).not.toContain("suspendDeadlines");
    expect(deps.forwarded.map((f) => f.hook)).not.toContain("onShow");
    // Nothing closes it on its own: hours pass, the pane is still there.
    vi.advanceTimersByTime(24 * 3_600_000);
    expect(r.closes).toHaveLength(0);
    expect(listScriptPanes().map((p) => p.paneId)).toEqual([paneId]);
  });

  it("the user's close ends the session as 'user': close event, mirror, onPaneClose, closed() — once", async () => {
    const paneId = await dock(r, deps);
    r.close(paneId);
    r.close(paneId);
    closeScriptPane(OWNER.scriptId, paneId);
    expect(r.closes).toEqual([{ paneId, reason: "user" }]);
    expect(deps.closedWith).toEqual([{ paneId, reason: "user" }]);
    expect(deps.mirrors.at(-1)).toEqual({ path: `pane.isOpen.${paneId}`, value: false });
    expect(deps.forwarded.at(-1)).toEqual({
      hook: "onPaneClose",
      payload: { paneId, reason: "user", values: { note: "", done: false } },
    });
    expect(listScriptPanes()).toEqual([]);
  });

  it("a script's close ends it as 'script'", async () => {
    const paneId = await dock(r, deps);
    closeScriptPane(OWNER.scriptId, paneId);
    expect(r.closes).toEqual([{ paneId, reason: "script" }]);
    expect(deps.closedWith).toEqual([{ paneId, reason: "script" }]);
  });

  it("refuses the N+1th pane: the per-script cap", async () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_PANES_PER_SCRIPT; i++) ids.push(await dock(r, deps));
    expect(ids).toHaveLength(3);
    await expect(dockScriptPane({ ...OWNER, deps })).rejects.toThrow(/3 panes open/);
    expect(r.requests).toHaveLength(MAX_PANES_PER_SCRIPT);
    // Closing one makes room for exactly one more.
    closeScriptPane(OWNER.scriptId, ids[0]);
    const fourth = await dock(r, deps);
    expect(listScriptPanes().map((p) => p.paneId)).toEqual([ids[1], ids[2], fourth]);
    // Another script is not counted against this one.
    const other = await dock(r, deps, "sidebar", { ...OWNER, scriptId: "form-2", scriptName: "Other" });
    expect(listScriptPanes()).toHaveLength(4);
    expect(listScriptPanes().at(-1)?.paneId).toBe(other);
  });

  it("a dock still reading its cells counts against the cap", async () => {
    // Otherwise a script could START MAX+1 docks in one turn and have every
    // one of them land once the reads finished.
    let unblock: (() => void) | null = null;
    const reading = new Promise<void>((res) => {
      unblock = res;
    });
    const pending: Array<Promise<{ paneId: string }>> = [];
    for (let i = 0; i < MAX_PANES_PER_SCRIPT; i++) {
      pending.push(dockScriptPane({ ...OWNER, resolve: async () => { await reading; return {}; }, deps }));
    }
    await Promise.resolve();
    await expect(dockScriptPane({ ...OWNER, deps })).rejects.toThrow(/3 panes open/);
    unblock?.();
    await vi.waitFor(() => expect(r.requests).toHaveLength(MAX_PANES_PER_SCRIPT));
    for (const req of r.requests) r.docked(req.paneId);
    await Promise.all(pending);
  });

  it("refuses the N+1th dock in a minute: the dock bucket", async () => {
    for (let i = 0; i < PANE_DOCKS_PER_MINUTE; i++) {
      const paneId = await dock(r, deps);
      closeScriptPane(OWNER.scriptId, paneId);
    }
    expect(listScriptPanes()).toEqual([]);
    await expect(dockScriptPane({ ...OWNER, deps })).rejects.toThrow(/in the last minute/);
    expect(r.requests).toHaveLength(PANE_DOCKS_PER_MINUTE);
  });

  it("refuses the N+1th update in a second: the update bucket, per pane", async () => {
    const paneId = await dock(r, deps);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (let i = 0; i < PANE_UPDATE_PER_SECOND + 5; i++) {
      updateScriptPane(OWNER.scriptId, paneId, { values: { note: `n${i}` } });
    }
    expect(r.patches).toHaveLength(PANE_UPDATE_PER_SECOND);
    expect(warn).toHaveBeenCalledTimes(1);
    // A SECOND pane has its own bucket.
    const second = await dock(r, deps);
    updateScriptPane(OWNER.scriptId, second, { values: { note: "x" } });
    expect(r.patches).toHaveLength(PANE_UPDATE_PER_SECOND + 1);
    expect(r.patches.at(-1)?.paneId).toBe(second);
    warn.mockRestore();
  });

  it("an update coerces values like the renderer and mirrors under the PANE's own path", async () => {
    const paneId = await dock(r, deps);
    updateScriptPane(OWNER.scriptId, paneId, { values: { done: "true", refresh: "no", note: 7 } });
    expect(r.patches).toEqual([{ paneId, patch: { values: { done: "true", refresh: "no", note: 7 } } }]);
    expect(deps.mirrors.at(-1)).toEqual({ path: `pane.values.${paneId}`, value: { note: "7", done: true } });
  });

  it("refuses a script acting on a pane it does not own — the same answer as for a pane that never existed", async () => {
    const paneId = await dock(r, deps);
    const intruder = "form-9";
    const noSuch = "pane-9999";
    for (const target of [paneId, noSuch]) {
      expect(() => updateScriptPane(intruder, target, { values: { note: "x" } })).toThrow(BrokerError);
      expect(() => setScriptPaneBadge(intruder, target, "1")).toThrow(BrokerError);
      expect(() => revealScriptPane(intruder, target)).toThrow(BrokerError);
      expect(() => closeScriptPane(intruder, target)).toThrow(BrokerError);
    }
    let own = "";
    let foreign = "";
    try {
      updateScriptPane(intruder, paneId, {});
    } catch (e) {
      foreign = (e as Error).message;
    }
    try {
      updateScriptPane(intruder, noSuch, {});
    } catch (e) {
      own = (e as Error).message;
    }
    expect(foreign.replace(paneId, "<id>")).toBe(own.replace(noSuch, "<id>"));
    // Nothing happened to the pane.
    expect(r.patches).toHaveLength(0);
    expect(r.closes).toHaveLength(0);
    expect(listScriptPanes()).toHaveLength(1);
  });

  it("a script's OWN closed pane is a no-op for update/badge/close and an honest 'no' for reveal", async () => {
    // The user closed it a moment ago; the script's next update must not turn
    // into a console error. A FOREIGN or unknown id still refuses (above).
    const paneId = await dock(r, deps);
    r.close(paneId);
    expect(() => updateScriptPane(OWNER.scriptId, paneId, { values: { note: "x" } })).not.toThrow();
    expect(() => setScriptPaneBadge(OWNER.scriptId, paneId, "1")).not.toThrow();
    expect(() => closeScriptPane(OWNER.scriptId, paneId)).not.toThrow();
    expect(revealScriptPane(OWNER.scriptId, paneId)).toEqual({ revealed: false, reason: "the pane is closed" });
    expect(r.patches).toHaveLength(0);
    expect(deps.closedWith).toHaveLength(1);
    // After the script's UNMOUNT the id is forgotten with everything else.
    revokeScriptPanes(OWNER.scriptId);
    expect(() => updateScriptPane(OWNER.scriptId, paneId, {})).toThrow(/no pane/);
  });

  it("setBadge emits once per change and rides the update bucket", async () => {
    const paneId = await dock(r, deps);
    setScriptPaneBadge(OWNER.scriptId, paneId, "3");
    setScriptPaneBadge(OWNER.scriptId, paneId, "3");
    setScriptPaneBadge(OWNER.scriptId, paneId, null);
    expect(r.patches).toEqual([
      { paneId, badge: "3" },
      { paneId, badge: null },
    ]);
    setScriptPaneBadge(OWNER.scriptId, paneId, "NEW");
    expect(listScriptPanes()[0].badge).toBe("NEW");
  });

  it("counts ADMITTED updates over a sliding minute for the inventory, and forgets the old ones", async () => {
    const paneId = await dock(r, deps);
    vi.useFakeTimers();
    updateScriptPane(OWNER.scriptId, paneId, { values: { note: "a" } });
    updateScriptPane(OWNER.scriptId, paneId, { values: { note: "b" } });
    setScriptPaneBadge(OWNER.scriptId, paneId, "2");
    expect(listScriptPanes()[0].updatesLastMinute).toBe(3);
    // Inside the window every stamp still counts...
    vi.advanceTimersByTime(PANE_UPDATE_WINDOW_MS - 1_000);
    expect(listScriptPanes()[0].updatesLastMinute).toBe(3);
    // ...one more just before the edge is the only one left once it passes.
    updateScriptPane(OWNER.scriptId, paneId, { values: { note: "c" } });
    vi.advanceTimersByTime(2_000);
    expect(listScriptPanes()[0].updatesLastMinute).toBe(1);
    vi.advanceTimersByTime(PANE_UPDATE_WINDOW_MS);
    expect(listScriptPanes()[0].updatesLastMinute).toBe(0);
  });

  it("a REFUSED update is not an update: the bucket's drops never reach the count", async () => {
    const paneId = await dock(r, deps);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (let i = 0; i < PANE_UPDATE_PER_SECOND + 5; i++) {
      updateScriptPane(OWNER.scriptId, paneId, { values: { note: `n${i}` } });
    }
    expect(r.patches).toHaveLength(PANE_UPDATE_PER_SECOND);
    expect(listScriptPanes()[0].updatesLastMinute).toBe(PANE_UPDATE_PER_SECOND);
    warn.mockRestore();
  });

  it("boundCells is the session's cell-binding record, per pane", async () => {
    const bound = await dock(r, deps, "sidebar", { ...OWNER, writeOnChange: ["note", "done"] });
    const unbound = await dock(r, deps);
    const rows = new Map(listScriptPanes().map((p) => [p.paneId, p.boundCells]));
    expect(rows.get(bound)).toBe(2);
    expect(rows.get(unbound)).toBe(0);
  });

  it("change forwards onPaneChange with the paneId (text debounced, others at once) and marks the widget touched", async () => {
    const paneId = await dock(r, deps);
    vi.useFakeTimers();
    r.change(paneId, "done", true, { note: "", done: true });
    expect(deps.forwarded.at(-1)).toEqual({
      hook: "onPaneChange",
      payload: { paneId, name: "done", value: true, values: { note: "", done: true }, source: "user" },
    });
    const before = deps.forwarded.length;
    r.change(paneId, "note", "a", { note: "a", done: true });
    r.change(paneId, "note", "ab", { note: "ab", done: true });
    expect(deps.forwarded).toHaveLength(before);
    vi.advanceTimersByTime(FORM_TEXT_CHANGE_DEBOUNCE_MS + 1);
    expect(deps.forwarded).toHaveLength(before + 1);
    expect((deps.forwarded.at(-1)?.payload as { value: unknown }).value).toBe("ab");
    // The mirror always says what is on screen, under the pane's own path.
    expect(deps.mirrors.at(-1)).toEqual({ path: `pane.values.${paneId}`, value: { note: "ab", done: true } });
  });

  it("click forwards onPaneClick with the paneId", async () => {
    const paneId = await dock(r, deps);
    r.click(paneId, "refresh");
    expect(deps.forwarded.at(-1)).toEqual({ hook: "onPaneClick", payload: { paneId, name: "refresh", values: {} } });
  });

  it("visible / hidden reach the host once per transition, and a close while visible ends visibility", async () => {
    const paneId = await dock(r, deps);
    expect(listScriptPanes()[0].visible).toBe(false);
    r.visible(paneId);
    r.visible(paneId);
    expect(deps.visibility).toEqual([{ paneId, visible: true }]);
    expect(listScriptPanes()[0].visible).toBe(true);
    r.hidden(paneId);
    r.hidden(paneId);
    expect(deps.visibility).toEqual([{ paneId, visible: true }, { paneId, visible: false }]);
    expect(listScriptPanes()[0].visible).toBe(false);
    r.visible(paneId);
    r.close(paneId);
    expect(deps.visibility).toHaveLength(3);
    // The close is what tears the host's watch down (`closed`), not a fourth
    // visibility transition — but nothing may report the pane as visible.
    expect(deps.closedWith).toEqual([{ paneId, reason: "user" }]);
    expect(listScriptPanes()).toEqual([]);
  });

  it("a renderer that reports 'visible' before 'docked' settles the dock — the order of two effects must not matter", async () => {
    const promise = dockScriptPane({ ...OWNER, deps });
    const { paneId } = r.last();
    r.visible(paneId, { note: "", done: false });
    await expect(promise).resolves.toEqual({ paneId, opened: false, placement: "sidebar" });
    expect(deps.openedIds).toEqual([paneId]);
    expect(deps.visibility).toEqual([{ paneId, visible: true }]);
    // A late "docked" is then a no-op, not a second resolve.
    r.docked(paneId);
    expect(deps.openedIds).toEqual([paneId]);
  });

  it("a committed change on a writeOn:change widget asks the host to write exactly that name", async () => {
    const paneId = await dock(r, deps, "sidebar", {
      ...OWNER,
      writeOnChange: ["done"],
    });
    r.change(paneId, "done", true, { note: "", done: true });
    expect(deps.writes).toEqual([{ paneId, names: ["done"], values: { note: "", done: true } }]);
    // A widget that is not bound is never written, whatever it is.
    vi.useFakeTimers();
    r.change(paneId, "note", "x", { note: "x", done: true });
    vi.advanceTimersByTime(FORM_TEXT_CHANGE_DEBOUNCE_MS + 1);
    expect(deps.writes).toHaveLength(1);
  });

  it("a REFUSED write shows its reason in the band and the pane stays open", async () => {
    const paneId = await dock(r, deps, "sidebar", { ...OWNER, writeOnChange: ["done"] });
    deps.nextWrite = () => Promise.reject(new BrokerError("HostError", 'switch back to "Sheet1" to save this pane'));
    r.change(paneId, "done", true, { note: "", done: true });
    await vi.waitFor(() =>
      expect(r.patches.at(-1)).toEqual({
        paneId,
        patch: { message: { text: 'switch back to "Sheet1" to save this pane', kind: "error" } },
      }),
    );
    expect(r.closes).toHaveLength(0);
    expect(listScriptPanes().map((p) => p.paneId)).toEqual([paneId]);
  });

  // A text-like widget's change waits FORM_TEXT_CHANGE_DEBOUNCE_MS before it is
  // delivered and written. A close inside that window used to clear the timer
  // and drop the delivery, so the last keystrokes in a bound textbox were never
  // written while `onPaneClose` still carried them — on the band's X, on
  // `pane.close()` and on unmount alike. Every close path now flushes first.
  describe("a close inside the text debounce flushes the pending change first", () => {
    const closeBy = {
      user: (paneId: string) => r.close(paneId),
      script: (paneId: string) => closeScriptPane(OWNER.scriptId, paneId),
      unmount: () => revokeScriptPanes(OWNER.scriptId),
    } as const;

    for (const [reason, close] of Object.entries(closeBy) as Array<[keyof typeof closeBy, (id: string) => void]>) {
      it(`closed by ${reason}: the latest text is delivered, written, and only then the session ends`, async () => {
        vi.useFakeTimers();
        const paneId = await dock(r, deps, "sidebar", { ...OWNER, writeOnChange: ["note"] });
        r.change(paneId, "note", "Pari", { note: "Pari", done: false });
        r.change(paneId, "note", "Paris", { note: "Paris", done: false });
        vi.advanceTimersByTime(FORM_TEXT_CHANGE_DEBOUNCE_MS - 50);
        // Nothing has left yet: the debounce is still holding it.
        expect(deps.writes).toEqual([]);
        expect(deps.forwarded.map((f) => f.hook)).not.toContain("onPaneChange");
        close(paneId);
        // The LATEST value, once, through the same delivery a timer expiry takes...
        expect(deps.writes).toEqual([{ paneId, names: ["note"], values: { note: "Paris", done: false } }]);
        const hooks = deps.forwarded.map((f) => f.hook);
        expect(hooks.filter((h) => h === "onPaneChange")).toHaveLength(1);
        expect((deps.forwarded.find((f) => f.hook === "onPaneChange")?.payload as { value: unknown }).value).toBe(
          "Paris",
        );
        // ...and BEFORE the close, so the script's onChange state is never
        // behind the values its onPaneClose reports.
        expect(hooks.indexOf("onPaneChange")).toBeLessThan(hooks.indexOf("onPaneClose"));
        expect(deps.closedWith).toEqual([{ paneId, reason }]);
        // The timer that was holding it is gone: nothing delivers twice.
        vi.advanceTimersByTime(FORM_TEXT_CHANGE_DEBOUNCE_MS * 2);
        expect(deps.writes).toHaveLength(1);
        expect(hooks.filter((h) => h === "onPaneChange")).toHaveLength(1);
      });
    }

    it("a flush whose write is REFUSED tells the user in a toast (the band is gone) rather than nothing", async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const paneId = await dock(r, deps, "sidebar", { ...OWNER, writeOnChange: ["note"] });
      deps.nextWrite = () => Promise.reject(new BrokerError("HostError", 'switch back to "Sheet1" to save this pane'));
      r.change(paneId, "note", "Paris", { note: "Paris", done: false });
      r.close(paneId);
      expect(deps.writes).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(0);
      // No band patch went to a pane that no longer exists...
      expect(r.patches.filter((p) => p.patch?.message)).toEqual([]);
      // ...the toast names the widget, the reason and what the user can do.
      // (No toast sink is registered headless: showToast falls back to console.warn.)
      const toast = warn.mock.calls.map((c) => c.join(" ")).find((line) => line.includes("Paris") || line.includes('"note"'));
      expect(toast).toContain('"note" was not saved to its cell when the pane closed');
      expect(toast).toContain('switch back to "Sheet1" to save this pane');
      expect(toast).toContain("enter the value in the cell directly");
      warn.mockRestore();
    });
  });

  it("onlyChanged: a reveal re-read announces a value that differs and stays silent about one that does not", async () => {
    const paneId = await dock(r, deps, "sidebar", {
      ...OWNER,
      seeds: { note: { value: "old" }, done: { value: false } },
    });
    const before = deps.forwarded.length;
    refreshScriptPaneSeeds(paneId, { note: { value: "new" }, done: { value: false } }, { onlyChanged: true });
    const changes = deps.forwarded.slice(before).filter((f) => f.hook === "onPaneChange");
    expect(changes.map((c) => (c.payload as { name: string; value: unknown }).name)).toEqual(["note"]);
    // The renderer and the mirror still took BOTH seeds.
    expect(r.patches.at(-1)).toEqual({ paneId, seeds: { note: { value: "new" }, done: { value: false } } });
    expect(deps.mirrors.at(-1)).toEqual({ path: `pane.values.${paneId}`, value: { note: "new", done: false } });
    // Without the option, every adopted seed is announced (the live watch's rule).
    refreshScriptPaneSeeds(paneId, { note: { value: "new" }, done: { value: false } });
    const all = deps.forwarded.slice(before).filter((f) => f.hook === "onPaneChange");
    expect(all).toHaveLength(3);
  });

  it("refreshed seeds keep a user-edited widget, adopt the rest, and cap the fan-out", async () => {
    const wide: FormSpec = {
      children: Array.from({ length: MAX_FORM_CHANGE_FANOUT + 5 }, (_, i) => ({
        type: "textbox" as const,
        name: `t${i}`,
        label: `T${i}`,
      })),
    };
    const paneId = await dock(r, deps, "sidebar", { ...OWNER, spec: wide });
    r.change(paneId, "t0", "mine", { t0: "mine" });
    vi.useFakeTimers();
    vi.advanceTimersByTime(FORM_TEXT_CHANGE_DEBOUNCE_MS + 1);
    const before = deps.forwarded.length;
    const seeds = Object.fromEntries(wide.children.map((w, i) => [w.name, { value: `cell${i}` }]));
    refreshScriptPaneSeeds(paneId, seeds);
    // The renderer got every seed...
    expect(r.patches.at(-1)).toEqual({ paneId, seeds });
    // ...the mirror adopted all but the edited one...
    const mirrored = deps.mirrors.at(-1)?.value as Record<string, unknown>;
    expect(mirrored.t0).toBe("mine");
    expect(mirrored.t1).toBe("cell1");
    // ...and the discrete events stop at the cap.
    const changes = deps.forwarded.slice(before).filter((f) => f.hook === "onPaneChange");
    expect(changes).toHaveLength(MAX_FORM_CHANGE_FANOUT);
    expect((changes[0].payload as { source: string }).source).toBe("cell");
    expect(changes.map((c) => (c.payload as { name: string }).name)).not.toContain("t0");
  });
});

describe("scriptPanes — reveal answers honestly", () => {
  let r: ReturnType<typeof renderer>;
  let deps: RecordingDeps;

  beforeEach(() => {
    resetScriptPanes();
    r = renderer();
    deps = recordingDeps();
  });
  afterEach(() => {
    r.stop();
    resetScriptPanes();
  });

  it("reveals a sidebar pane: emits the reveal patch and says so", async () => {
    const paneId = await dockOpened(r, deps, "sidebar");
    expect(revealScriptPane(OWNER.scriptId, paneId)).toEqual({ revealed: true });
    expect(r.patches).toEqual([{ paneId, reveal: true }]);
  });

  it("refuses to claim a reveal for a RIBBON placement, where openPanel is a no-op", async () => {
    const paneId = await dock(r, deps, "ribbon");
    const answer = revealScriptPane(OWNER.scriptId, paneId);
    expect(answer.revealed).toBe(false);
    expect(answer.reason).toMatch(/ribbon/);
    // And nothing was emitted that a renderer could mistake for a success.
    expect(r.patches).toHaveLength(0);
  });

  it("follows the placement the renderer reports after the user moves the pane", async () => {
    const paneId = await dockOpened(r, deps, "sidebar");
    r.placement(paneId, "ribbon");
    expect(listScriptPanes()[0].placement).toBe("ribbon");
    expect(revealScriptPane(OWNER.scriptId, paneId).revealed).toBe(false);
    r.placement(paneId, "sidebar");
    expect(revealScriptPane(OWNER.scriptId, paneId)).toEqual({ revealed: true });
  });

  it("says a pane the renderer has not acknowledged cannot be revealed yet", async () => {
    const promise = dockScriptPane({ ...OWNER, deps });
    const { paneId } = r.last();
    expect(revealScriptPane(OWNER.scriptId, paneId)).toEqual({
      revealed: false,
      reason: "the pane has not opened yet",
    });
    r.docked(paneId);
    await promise;
  });
});

describe("scriptPanes — layouts, deadlines and sweeps", () => {
  let r: ReturnType<typeof renderer>;
  let deps: RecordingDeps;

  beforeEach(() => {
    resetScriptForms();
    resetScriptPanes();
    r = renderer();
    deps = recordingDeps();
  });
  afterEach(() => {
    r.stop();
    resetScriptPanes();
    resetScriptForms();
    vi.useRealTimers();
  });

  it("a form and a pane coexist on one script: two layout kinds, neither overwrites the other", async () => {
    const FORM: FormSpec = { children: [{ type: "label", text: "modal" }] };
    defineScriptForm(OWNER.scriptId, FORM);
    await dock(r, deps);
    expect(getScriptFormSpec(OWNER.scriptId)).toBe(FORM);
    expect(getScriptLayoutSpec(OWNER.scriptId, "pane")).toBe(SPEC);
    expect(getScriptLayoutSpec(OWNER.scriptId, "form")).toBe(FORM);
    // Forgetting the form's layout leaves the pane's, and vice versa.
    revokeScriptForms(OWNER.scriptId);
    expect(getScriptFormSpec(OWNER.scriptId)).toBeNull();
    expect(getScriptLayoutSpec(OWNER.scriptId, "pane")).toBe(SPEC);
    revokeScriptPanes(OWNER.scriptId);
    expect(getScriptLayoutSpec(OWNER.scriptId, "pane")).toBeNull();
  });

  it("a renderer that never acknowledges fails the dock as 'failed'", async () => {
    vi.useFakeTimers();
    const promise = dockScriptPane({ ...OWNER, deps });
    const { paneId } = r.last();
    vi.advanceTimersByTime(PANE_DOCKED_ACK_TIMEOUT_MS + 1);
    await expect(promise).rejects.toThrow(/did not open/);
    expect(r.closes).toEqual([{ paneId, reason: "failed" }]);
    expect(deps.closedWith).toEqual([{ paneId, reason: "failed" }]);
    expect(listScriptPanes()).toEqual([]);
  });

  it("revokeScriptPanes closes every pane the script owns as 'unmount' and resets its buckets", async () => {
    const a = await dock(r, deps);
    const b = await dock(r, deps);
    const theirs = await dock(r, deps, "sidebar", { ...OWNER, scriptId: "form-2", scriptName: "Other" });
    revokeScriptPanes(OWNER.scriptId);
    expect(r.closes).toEqual([
      { paneId: a, reason: "unmount" },
      { paneId: b, reason: "unmount" },
    ]);
    expect(deps.closedWith.map((c) => c.paneId)).toEqual([a, b]);
    // The other script's pane is untouched.
    expect(listScriptPanes().map((p) => p.paneId)).toEqual([theirs]);
    // A remount starts clean: the cap and the bucket are empty again.
    for (let i = 0; i < MAX_PANES_PER_SCRIPT; i++) await dock(r, deps);
    expect(listScriptPanes()).toHaveLength(MAX_PANES_PER_SCRIPT + 1);
  });

  it("an unmount WHILE the reads are running refuses the dock and paints nothing", async () => {
    let unblock: (() => void) | null = null;
    const reading = new Promise<void>((res) => {
      unblock = res;
    });
    let entered = false;
    const promise = dockScriptPane({
      ...OWNER,
      resolve: async () => {
        entered = true;
        await reading;
        return { seeds: { note: { value: "From cell" } } };
      },
      deps,
    });
    await vi.waitFor(() => expect(entered).toBe(true));
    revokeScriptPanes(OWNER.scriptId);
    unblock?.();
    await expect(promise).rejects.toThrow(/unloaded before its pane could open/);
    expect(r.requests).toHaveLength(0);
    expect(deps.closedWith).toHaveLength(0);
    expect(listScriptPanes()).toEqual([]);
  });

  it("a THROWING thunk leaves no session behind and frees its place under the cap", async () => {
    const failure = new Error("sheet.getCellData: refused");
    await expect(
      dockScriptPane({
        ...OWNER,
        resolve: async () => {
          throw failure;
        },
        deps,
      }),
    ).rejects.toBe(failure);
    expect(r.requests).toHaveLength(0);
    expect(r.closes).toHaveLength(0);
    for (let i = 0; i < MAX_PANES_PER_SCRIPT; i++) await dock(r, deps);
  });

  it("resetScriptPanes closes every pane of every script as 'reset' and forgets every pane layout", async () => {
    const a = await dock(r, deps);
    const b = await dock(r, deps, "sidebar", { ...OWNER, scriptId: "form-2", scriptName: "Other" });
    resetScriptPanes();
    expect(r.closes).toEqual([
      { paneId: a, reason: "reset" },
      { paneId: b, reason: "reset" },
    ]);
    expect(listScriptPanes()).toEqual([]);
    expect(getScriptLayoutSpec(OWNER.scriptId, "pane")).toBeNull();
    expect(getScriptLayoutSpec("form-2", "pane")).toBeNull();
  });

  /**
   * THE ONE CLOSE THAT MUST NOT FLUSH. Every other close path delivers what the
   * text debounce is holding, because the cell the user typed into is still
   * there. A workbook swap is different: `resetScriptPanes` is the sweep of
   * AFTER_OPEN / AFTER_NEW / BEFORE_CLOSE, which run once the document has
   * already been replaced — so a flush would write the text typed into the OLD
   * workbook into the NEW workbook's cell of the same address.
   */
  it("a workbook swap DROPS the change the debounce is holding, and tells the user it was not saved", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const paneId = await dock(r, deps, "sidebar", { ...OWNER, writeOnChange: ["note"] });
    r.change(paneId, "note", "Paris", { note: "Paris", done: false });
    vi.advanceTimersByTime(FORM_TEXT_CHANGE_DEBOUNCE_MS - 50);
    expect(deps.writes).toEqual([]);
    resetScriptPanes();
    // Nothing was written into the workbook that replaced the pane's own...
    expect(deps.writes).toEqual([]);
    expect(deps.closedWith).toEqual([{ paneId, reason: "reset" }]);
    // ...and no timer is left to write it a moment later either.
    vi.advanceTimersByTime(FORM_TEXT_CHANGE_DEBOUNCE_MS * 2);
    expect(deps.writes).toEqual([]);
    // The user typed a value that is in no cell, so they are told, and told
    // what they can do about it. (No toast sink headless: showToast falls back
    // to console.warn.)
    const toast = warn.mock.calls.map((c) => c.join(" ")).find((line) => line.includes('"note"'));
    expect(toast).toContain('your last edit to "note" was not saved to its cell');
    expect(toast).toContain("was closed or replaced first");
    expect(toast).toContain("enter the value in the cell directly");
    warn.mockRestore();
  });
});

// ----------------------------------------------------------------------------
// The stable key — what the user's placement preference is remembered under
// ----------------------------------------------------------------------------
//
// `paneId` is per session and never repeats; the renderer builds the Shell
// panel id (the placement store's key) from `paneKey` instead. So the key must
// come back the SAME on a re-dock — the lowest free slot, freed on close — and
// must never be held by two live panes of one script at once.

describe("scriptPanes — the stable key", () => {
  let r: ReturnType<typeof renderer>;
  let deps: RecordingDeps;

  beforeEach(() => {
    resetScriptForms();
    resetScriptPanes();
    r = renderer();
    deps = recordingDeps();
  });
  afterEach(() => {
    r.stop();
    resetScriptPanes();
    resetScriptForms();
  });

  it("a script's first pane is slot \"0\" on EVERY dock: close, dock again -> the same key under a new id", async () => {
    const first = await dock(r, deps);
    expect(r.last().paneKey).toBe("0");
    closeScriptPane(OWNER.scriptId, first);
    const second = await dock(r, deps);
    expect(second).not.toBe(first);
    expect(r.last().paneKey).toBe("0");
    // The user's close frees the slot the same way.
    r.close(second);
    await dock(r, deps);
    expect(r.last().paneKey).toBe("0");
  });

  it("two panes take slots 0 and 1; closing 0 hands the next dock 0, not 2 — and another script's slots are its own", async () => {
    const a = await dock(r, deps);
    await dock(r, deps);
    expect(r.requests.map((q) => q.paneKey)).toEqual(["0", "1"]);
    closeScriptPane(OWNER.scriptId, a);
    await dock(r, deps);
    expect(r.last().paneKey).toBe("0");
    await dock(r, deps, "sidebar", { ...OWNER, scriptId: "form-2", scriptName: "Other" });
    expect(r.last().paneKey).toBe("0");
  });

  it("a script-chosen key rides the request; docking it again while it is up is refused BY NAME, never a second pane", async () => {
    const paneId = await dock(r, deps, "sidebar", { ...OWNER, key: "status" });
    expect(r.last().paneKey).toBe("status");
    await expect(dockScriptPane({ ...OWNER, key: "status", deps })).rejects.toThrow(
      'a pane with key "status" is already docked; close it first',
    );
    expect(r.requests).toHaveLength(1);
    expect(listScriptPanes()).toHaveLength(1);
    // A named key is not a slot index: the default beside it is still "0".
    await dock(r, deps);
    expect(r.last().paneKey).toBe("0");
    // Once closed, the name is free again.
    closeScriptPane(OWNER.scriptId, paneId);
    await dock(r, deps, "sidebar", { ...OWNER, key: "status" });
    expect(r.last().paneKey).toBe("status");
  });

  it("a dock still reading its cells HOLDS its key: a second dock of it in the same turn is refused", async () => {
    let unblock: (() => void) | null = null;
    const reading = new Promise<void>((res) => {
      unblock = res;
    });
    const pending = dockScriptPane({
      ...OWNER,
      key: "status",
      resolve: async () => {
        await reading;
        return {};
      },
      deps,
    });
    await Promise.resolve();
    await expect(dockScriptPane({ ...OWNER, key: "status", deps })).rejects.toThrow(/already docked/);
    // ...while a default dock beside it does not collide with the name.
    const other = dockScriptPane({ ...OWNER, deps });
    expect(r.last().paneKey).toBe("0");
    r.docked(r.last().paneId);
    await other;
    unblock?.();
    await vi.waitFor(() => expect(r.requests).toHaveLength(2));
    expect(r.last().paneKey).toBe("status");
    r.docked(r.last().paneId);
    await pending;
  });

  it("a dock that never lands frees its key: a throwing thunk, an ack timeout, then the same key docks", async () => {
    await expect(
      dockScriptPane({
        ...OWNER,
        key: "status",
        resolve: async () => {
          throw new Error("refused");
        },
        deps,
      }),
    ).rejects.toThrow("refused");
    vi.useFakeTimers();
    const unacknowledged = dockScriptPane({ ...OWNER, key: "status", deps });
    vi.advanceTimersByTime(PANE_DOCKED_ACK_TIMEOUT_MS + 1);
    await expect(unacknowledged).rejects.toThrow(/did not open/);
    vi.useRealTimers();
    await dock(r, deps, "sidebar", { ...OWNER, key: "status" });
    expect(r.last().paneKey).toBe("status");
  });

  it("revoke and reset free every slot", async () => {
    await dock(r, deps);
    await dock(r, deps, "sidebar", { ...OWNER, key: "status" });
    revokeScriptPanes(OWNER.scriptId);
    await dock(r, deps);
    expect(r.last().paneKey).toBe("0");
    await dock(r, deps, "sidebar", { ...OWNER, key: "status" });
    resetScriptPanes();
    await dock(r, deps, "sidebar", { ...OWNER, key: "status" });
    await dock(r, deps);
    expect(r.requests.slice(-2).map((q) => q.paneKey)).toEqual(["status", "0"]);
  });
});

// ----------------------------------------------------------------------------
// The DOCK's own bound: registering a pane is not taking the screen.
//
// `pane.reveal` was bounded by the gesture window in S6 and `pane.dock` was
// not, which left the shorter route to the same `openPanel` — the call that
// forces the sidebar open and switches the active view away from the user's
// own work — with no provenance check at all. Measured before this section
// existed: a script that closed and re-docked its own pane took the sidebar ten
// times a minute, for as long as it was mounted, with no gesture anywhere.
// ----------------------------------------------------------------------------

describe("scriptPanes — a dock registers always, and opens only for the user", () => {
  let r: ReturnType<typeof renderer>;
  let deps: RecordingDeps;

  beforeEach(() => {
    resetScriptPanes();
    r = renderer();
    deps = recordingDeps();
  });
  afterEach(() => {
    r.stop();
    resetScriptPanes();
    vi.useRealTimers();
  });

  it("a dock with no user gesture REGISTERS the pane and does not open it — and the result says so", async () => {
    const promise = dockScriptPane({ ...OWNER, deps });
    const req = r.last();
    // The renderer is told not to open it; everything else about the request
    // is unchanged, because the pane really does exist.
    expect(req.open).toBe(false);
    r.docked(req.paneId, "sidebar", { note: "", done: false });
    // Honest, not silent: the script is told the pane did not take the screen
    // rather than being handed an id and left to assume it did.
    await expect(promise).resolves.toEqual({ paneId: req.paneId, opened: false, placement: "sidebar" });
    // ...and it is a fully live pane: listed, docked, updatable.
    expect(listScriptPanes().map((p) => ({ paneId: p.paneId, docked: p.docked }))).toEqual([
      { paneId: req.paneId, docked: true },
    ]);
    updateScriptPane(OWNER.scriptId, req.paneId, { values: { note: "still works" } });
    expect(r.patches.filter((p) => p.patch)).toHaveLength(1);
  });

  it("a dock inside the gesture window opens, and says so", async () => {
    noteScriptGesture(OWNER.scriptId);
    const promise = dockScriptPane({ ...OWNER, deps });
    const req = r.last();
    expect(req.open).toBe(true);
    r.docked(req.paneId, "sidebar", { note: "", done: false });
    await expect(promise).resolves.toEqual({ paneId: req.paneId, opened: true, placement: "sidebar" });
  });

  it("the window is asked BEFORE the bound cells are read, so a slow read does not lose the user's gesture", async () => {
    vi.useFakeTimers();
    noteScriptGesture(OWNER.scriptId);
    let release: () => void = () => undefined;
    const reading = new Promise<void>((res) => {
      release = res;
    });
    const promise = dockScriptPane({ ...OWNER, deps, resolve: async () => { await reading; return {}; } });
    // The reads outlast the window; the dock was admitted to the screen when
    // the script asked, not when its cells came back.
    vi.setSystemTime(Date.now() + PANE_REVEAL_GESTURE_WINDOW_MS + 1);
    release();
    await Promise.resolve();
    await Promise.resolve();
    const req = r.last();
    expect(req.open).toBe(true);
    r.docked(req.paneId, "sidebar", {});
    await expect(promise).resolves.toMatchObject({ opened: true });
  });

  it("a dock the wiring will not act on (the ribbon) reports opened: false, as reveal does", async () => {
    noteScriptGesture(OWNER.scriptId);
    const promise = dockScriptPane({ ...OWNER, deps });
    const req = r.last();
    expect(req.open).toBe(true);
    // `openPanel` is a no-op for a ribbon placement, so being ALLOWED to open
    // is not the same as having opened.
    r.docked(req.paneId, "ribbon", {});
    await expect(promise).resolves.toEqual({ paneId: req.paneId, opened: false, placement: "ribbon" });
  });

  it("a dock that only registered the pane opens NO reveal window either — the one-call detour is closed too", async () => {
    const paneId = await dockAny(r, deps);
    // Without this, a script docks (refused the screen), then reveals (granted
    // it by its own dock's acknowledgement) and is exactly where it started.
    expect(revealScriptPane(OWNER.scriptId, paneId)).toEqual({ revealed: false, reason: "no-gesture" });
    expect(r.patches.filter((p) => p.reveal)).toHaveLength(0);
  });

  it("the close-and-re-dock loop takes the screen ZERO times after the gesture that started it", async () => {
    vi.useFakeTimers();
    // One real gesture: the user ran the script. Its first dock is the task
    // pane doing its job.
    noteScriptGesture(OWNER.scriptId);
    let paneId = await dockAny(r, deps);
    // Now the loop the skeptics measured, at the dock bucket's full rate.
    for (let i = 0; i < PANE_DOCKS_PER_MINUTE - 1; i++) {
      closeScriptPane(OWNER.scriptId, paneId);
      paneId = await dockAny(r, deps);
    }
    // ...and again after the bucket has refilled, for a second minute.
    vi.advanceTimersByTime(60_001);
    for (let i = 0; i < PANE_DOCKS_PER_MINUTE; i++) {
      closeScriptPane(OWNER.scriptId, paneId);
      paneId = await dockAny(r, deps);
    }
    // Exactly one dock in twenty took the screen: the one the user asked for.
    expect(r.requests.filter((q) => q.open)).toHaveLength(1);
    expect(r.requests).toHaveLength(2 * PANE_DOCKS_PER_MINUTE);
  });

  it("a fresh user gesture between docks opens the pane again — the bound is provenance, not a one-shot", async () => {
    vi.useFakeTimers();
    noteScriptGesture(OWNER.scriptId);
    const first = await dockAny(r, deps);
    closeScriptPane(OWNER.scriptId, first);
    // The user clicks the button the script is attached to (host.ts stamps it).
    vi.advanceTimersByTime(1);
    noteScriptGesture(OWNER.scriptId);
    const second = await dockAny(r, deps);
    expect(second).not.toBe(first);
    expect(r.requests.filter((q) => q.open)).toHaveLength(2);
  });
});

// ----------------------------------------------------------------------------
// S6 — the hostile-script hardening: the reveal gesture window and bucket, the
// throttle ladder (banner -> cooldown -> forced close), and what the audit
// ring hears. Every clock here is fake: the window, the buckets and the
// cooldown are all wall-clock rules, and a test that slept would be a test of
// the machine.
// ----------------------------------------------------------------------------

describe("scriptPanes — the hostile-script hardening (S6)", () => {
  let r: ReturnType<typeof renderer>;
  let deps: RecordingDeps;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetScriptPanes();
    r = renderer();
    deps = recordingDeps();
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    r.stop();
    resetScriptPanes();
    vi.useRealTimers();
  });

  const reveal = (paneId: string, scriptId = OWNER.scriptId) => revealScriptPane(scriptId, paneId);
  const revealPatches = () => r.patches.filter((p) => p.reveal);
  const bannerPatches = () => r.patches.filter((p) => p.hostBanner !== undefined);
  /** `n` update calls in one instant — past the bucket, every one is a refusal. */
  const hammer = (paneId: string, n: number): void => {
    for (let i = 0; i < n; i++) updateScriptPane(OWNER.scriptId, paneId, { values: { note: `n${i}` } });
  };
  /**
   * From a full bucket, land exactly enough calls to enter a cooldown: the
   * bucket's worth admitted, then PANE_THROTTLE_COOLDOWN_AT refusals.
   */
  const driveIntoCooldown = (paneId: string): void => hammer(paneId, PANE_UPDATE_PER_SECOND + PANE_THROTTLE_COOLDOWN_AT);

  it("a reveal is admitted only within PANE_REVEAL_GESTURE_WINDOW_MS of a user gesture: the dock, a pane input, a stamped run", async () => {
    vi.useFakeTimers();
    const paneId = await dockOpened(r, deps);
    // A dock that TOOK THE SCREEN opens the window (one that only registered
    // the pane does not — the section below pins that).
    expect(reveal(paneId)).toEqual({ revealed: true });
    vi.advanceTimersByTime(PANE_REVEAL_GESTURE_WINDOW_MS + 1);
    // Past it: an honest "no-gesture", nothing emitted, one audit row.
    expect(reveal(paneId)).toEqual({ revealed: false, reason: "no-gesture" });
    expect(revealPatches()).toHaveLength(1);
    expect(deps.audits).toEqual([{ paneId, method: "pane.reveal", class: "ui", error: "NoGesture" }]);
    // The user's click in the pane re-opens it — for exactly the window.
    r.click(paneId, "refresh");
    expect(reveal(paneId)).toEqual({ revealed: true });
    vi.advanceTimersByTime(PANE_REVEAL_GESTURE_WINDOW_MS);
    expect(reveal(paneId).revealed).toBe(true);
    vi.advanceTimersByTime(1);
    expect(reveal(paneId).reason).toBe("no-gesture");
    // So does a typed change, and so does a stamp from one of the host's
    // user entry points (a button click, a shortcut, Run in the editor).
    r.change(paneId, "note", "x", { note: "x", done: false });
    expect(reveal(paneId).revealed).toBe(true);
    vi.advanceTimersByTime(PANE_REVEAL_GESTURE_WINDOW_MS + 1);
    noteScriptGesture(OWNER.scriptId);
    expect(reveal(paneId).revealed).toBe(true);
    // A gesture on ANOTHER script opens nothing for this one.
    vi.advanceTimersByTime(PANE_REVEAL_GESTURE_WINDOW_MS + 1);
    noteScriptGesture("form-2");
    expect(reveal(paneId).reason).toBe("no-gesture");
    expect(revealPatches()).toHaveLength(5);
  });

  it("the ribbon answer and the closed / not-yet-open answers come BEFORE the window: state, not a refusal", async () => {
    vi.useFakeTimers();
    const paneId = await dock(r, deps, "ribbon");
    vi.advanceTimersByTime(PANE_REVEAL_GESTURE_WINDOW_MS + 1);
    expect(reveal(paneId).reason).toMatch(/ribbon/);
    r.close(paneId);
    expect(reveal(paneId)).toEqual({ revealed: false, reason: "the pane is closed" });
    expect(deps.audits).toEqual([]);
  });

  it("refuses the N+1th admitted reveal in a minute as 'throttled' — audited, per script, and the bucket refills", async () => {
    vi.useFakeTimers();
    const paneId = await dockOpened(r, deps);
    for (let i = 0; i < PANE_REVEALS_PER_MINUTE; i++) {
      noteScriptGesture(OWNER.scriptId);
      expect(reveal(paneId), `reveal ${i + 1}`).toEqual({ revealed: true });
    }
    noteScriptGesture(OWNER.scriptId);
    expect(reveal(paneId)).toEqual({ revealed: false, reason: "throttled" });
    expect(revealPatches()).toHaveLength(PANE_REVEALS_PER_MINUTE);
    expect(deps.audits).toEqual([{ paneId, method: "pane.reveal", class: "ui", error: "RateLimited" }]);
    // Another script's pane has its own bucket.
    const theirs = await dockOpened(r, deps, "sidebar", { ...OWNER, scriptId: "form-2", scriptName: "Other" });
    expect(reveal(theirs, "form-2")).toEqual({ revealed: true });
    // A minute on, this script's bucket has refilled.
    vi.advanceTimersByTime(60_001);
    noteScriptGesture(OWNER.scriptId);
    expect(reveal(paneId)).toEqual({ revealed: true });
  });

  it("the ladder: PANE_THROTTLE_BANNER_AT refusals in a minute raise the host banner; PANE_THROTTLE_COOLDOWN_AT enter a cooldown that ignores EVERY script call; it lifts after PANE_THROTTLE_COOLDOWN_MS", async () => {
    vi.useFakeTimers();
    const paneId = await dock(r, deps);
    // The bucket's worth is admitted; nothing on the ladder yet.
    hammer(paneId, PANE_UPDATE_PER_SECOND);
    expect(r.patches.filter((p) => p.patch)).toHaveLength(PANE_UPDATE_PER_SECOND);
    hammer(paneId, PANE_THROTTLE_BANNER_AT - 1);
    expect(bannerPatches()).toEqual([]);
    expect(deps.audits).toEqual([]);
    // The 30th refusal: the HOST's banner, once, and one audit row.
    hammer(paneId, 1);
    expect(bannerPatches()).toEqual([{ paneId, hostBanner: { text: expect.stringMatching(/slowed down/), kind: "warning" } }]);
    expect(deps.audits).toEqual([{ paneId, method: "pane.throttle.banner", class: "emit", error: "RateLimited" }]);
    hammer(paneId, 10);
    expect(bannerPatches()).toHaveLength(1);
    // Up to the cooldown threshold: the banner changes to the cooldown notice
    // carrying WHEN it lifts, and a second audit row.
    hammer(paneId, PANE_THROTTLE_COOLDOWN_AT - PANE_THROTTLE_BANNER_AT - 10);
    const cooldownUntil = Date.now() + PANE_THROTTLE_COOLDOWN_MS;
    expect(bannerPatches().at(-1)).toEqual({
      paneId,
      hostBanner: { text: expect.stringMatching(/ignored/), kind: "error", until: cooldownUntil },
    });
    expect(deps.audits.map((a) => a.method)).toEqual(["pane.throttle.banner", "pane.throttle.cooldown"]);
    // IN COOLDOWN: the bucket has refilled (a second passed), and still no
    // update, badge or reveal reaches the renderer or the ring.
    vi.advanceTimersByTime(1000);
    const patchesBefore = r.patches.length;
    const auditsBefore = deps.audits.length;
    updateScriptPane(OWNER.scriptId, paneId, { values: { note: "during" } });
    setScriptPaneBadge(OWNER.scriptId, paneId, "!");
    noteScriptGesture(OWNER.scriptId);
    expect(reveal(paneId)).toEqual({ revealed: false, reason: "throttled" });
    expect(r.patches).toHaveLength(patchesBefore);
    expect(deps.audits).toHaveLength(auditsBefore);
    expect(deps.mirrors.at(-1)?.value).not.toEqual(expect.objectContaining({ note: "during" }));
    // The pane is still open: a cooldown is not a close.
    expect(listScriptPanes().map((p) => p.paneId)).toEqual([paneId]);
    expect(deps.closedWith).toEqual([]);
    // The cooldown lifts on its own: the banner comes down and updates land again.
    vi.advanceTimersByTime(PANE_THROTTLE_COOLDOWN_MS - 1000);
    expect(bannerPatches().at(-1)).toEqual({ paneId, hostBanner: null });
    updateScriptPane(OWNER.scriptId, paneId, { values: { note: "after" } });
    expect(r.patches.at(-1)).toEqual({ paneId, patch: { values: { note: "after" } } });
    // (The gesture window is shorter than the cooldown; a fresh gesture, then a reveal.)
    noteScriptGesture(OWNER.scriptId);
    expect(reveal(paneId)).toEqual({ revealed: true });
  });

  it("refused reveals climb the same ladder as refused updates", async () => {
    vi.useFakeTimers();
    const paneId = await dock(r, deps);
    vi.advanceTimersByTime(PANE_REVEAL_GESTURE_WINDOW_MS + 1);
    for (let i = 0; i < PANE_THROTTLE_BANNER_AT - 1; i++) reveal(paneId);
    expect(bannerPatches()).toEqual([]);
    reveal(paneId);
    expect(bannerPatches()).toHaveLength(1);
    expect(deps.audits.at(-1)?.method).toBe("pane.throttle.banner");
  });

  // --------------------------------------------------------------------------
  // ...and it SAYS WHICH. Three refusals climb the one ladder (a dropped
  // update, a dropped badge, a refused reveal) and every notice named only the
  // first: a script that never called `pane.update` once earned a banner
  // telling the user it was "updating its pane too fast". The banner is the one
  // channel a script cannot forge, so each sentence is pinned LITERALLY here —
  // a re-wording is a promise being changed and should have to be re-read.
  // --------------------------------------------------------------------------

  const UPDATE_BANNER = "This script is updating its pane faster than Calcula allows; it is being slowed down.";
  const REVEAL_BANNER =
    "This script is asking to bring its pane forward more often than Calcula allows; it is being slowed down.";
  const MIXED_BANNER =
    "This script is updating its pane and asking to bring it forward more often than Calcula allows; it is being slowed down.";
  const UPDATE_COOLDOWN =
    "This script is updating its pane faster than Calcula allows; its calls to this pane are being ignored for a while.";
  const REVEAL_COOLDOWN =
    "This script is asking to bring its pane forward more often than Calcula allows; its calls to this pane are being ignored for a while.";
  const MIXED_COOLDOWN =
    "This script is updating its pane and asking to bring it forward more often than Calcula allows; its calls to this pane are being ignored for a while.";
  const bannerText = () => bannerPatches().at(-1)?.hostBanner?.text;
  /** `n` reveals outside the gesture window — every one refused "no-gesture", every one a ladder refusal. */
  const revealStorm = (paneId: string, n: number): void => {
    for (let i = 0; i < n; i++) expect(reveal(paneId).reason, `reveal ${i + 1}`).toBe("no-gesture");
  };

  it("a reveals-only burst is accused of REVEALING, at both the banner and the cooldown — never of updating", async () => {
    vi.useFakeTimers();
    const paneId = await dock(r, deps);
    vi.advanceTimersByTime(PANE_REVEAL_GESTURE_WINDOW_MS + 1);
    // This script has not called pane.update once.
    revealStorm(paneId, PANE_THROTTLE_BANNER_AT);
    expect(bannerText()).toBe(REVEAL_BANNER);
    revealStorm(paneId, PANE_THROTTLE_COOLDOWN_AT - PANE_THROTTLE_BANNER_AT);
    expect(bannerText()).toBe(REVEAL_COOLDOWN);
    expect(bannerPatches()).toHaveLength(2);
  });

  it("an updates-only burst is accused of UPDATING, at both the banner and the cooldown", async () => {
    vi.useFakeTimers();
    const paneId = await dock(r, deps);
    hammer(paneId, PANE_UPDATE_PER_SECOND + PANE_THROTTLE_BANNER_AT);
    expect(bannerText()).toBe(UPDATE_BANNER);
    hammer(paneId, PANE_THROTTLE_COOLDOWN_AT - PANE_THROTTLE_BANNER_AT);
    expect(bannerText()).toBe(UPDATE_COOLDOWN);
    expect(bannerPatches()).toHaveLength(2);
  });

  it("a MIXTURE names both — and the count is still one kind-blind ladder, so alternating kinds buys nothing", async () => {
    vi.useFakeTimers();
    const paneId = await dock(r, deps);
    vi.advanceTimersByTime(PANE_REVEAL_GESTURE_WINDOW_MS + 1);
    // Half the burst updates, half reveals: under a per-kind ladder neither
    // half would reach 30, and the pane would say nothing at all.
    const half = PANE_THROTTLE_BANNER_AT / 2;
    hammer(paneId, PANE_UPDATE_PER_SECOND + half);
    expect(bannerPatches()).toEqual([]);
    revealStorm(paneId, half);
    expect(bannerText()).toBe(MIXED_BANNER);
    // On to the cooldown, still with both kinds inside the minute.
    revealStorm(paneId, PANE_THROTTLE_COOLDOWN_AT - PANE_THROTTLE_BANNER_AT);
    expect(bannerText()).toBe(MIXED_COOLDOWN);
    // Two patches: the mix never changed again, and a banner per dropped call
    // would be a host channel a hostile script gets to hammer.
    expect(bannerPatches()).toHaveLength(2);
  });

  it("the sentence FOLLOWS the window: when the earlier kind ages out, the banner names the kind still being refused", async () => {
    vi.useFakeTimers();
    const paneId = await dock(r, deps);
    vi.advanceTimersByTime(PANE_REVEAL_GESTURE_WINDOW_MS + 1);
    revealStorm(paneId, PANE_THROTTLE_BANNER_AT);
    expect(bannerText()).toBe(REVEAL_BANNER);
    // Half a minute on it stops revealing and starts hammering updates: both
    // kinds are inside the minute now, and the sentence says so.
    vi.advanceTimersByTime(30_000);
    hammer(paneId, PANE_UPDATE_PER_SECOND + PANE_THROTTLE_BANNER_AT);
    expect(bannerText()).toBe(MIXED_BANNER);
    // The reveals age out. The banner stays up — the updates alone are well
    // above the clear threshold — but it stops accusing the script of reveals.
    vi.advanceTimersByTime(30_000);
    expect(bannerText()).toBe(UPDATE_BANNER);
    expect(bannerPatches()).toHaveLength(3);
    expect(bannerPatches().every((p) => p.hostBanner?.kind === "warning")).toBe(true);
  });

  it("the banner comes DOWN once the burst decays out of the sliding minute — a one-off burst is not a life sentence", async () => {
    vi.useFakeTimers();
    const paneId = await dock(r, deps);
    // A burst that raises the banner and stops well short of a cooldown.
    hammer(paneId, PANE_UPDATE_PER_SECOND + PANE_THROTTLE_BANNER_AT);
    expect(bannerPatches()).toEqual([{ paneId, hostBanner: { text: expect.stringMatching(/slowed down/), kind: "warning" } }]);
    expect(deps.audits.map((a) => a.method)).toEqual(["pane.throttle.banner"]);
    // Every call the script makes from here is ADMITTED — the accusation is
    // already untrue — and it stands until the refusals age out of the minute.
    vi.advanceTimersByTime(1000);
    updateScriptPane(OWNER.scriptId, paneId, { values: { note: "fine" } });
    expect(r.patches.at(-1)).toEqual({ paneId, patch: { values: { note: "fine" } } });
    vi.advanceTimersByTime(60_000 - 1001);
    expect(bannerPatches()).toHaveLength(1);
    // The last refusal leaves the window: the banner comes down, on its own.
    vi.advanceTimersByTime(1);
    expect(bannerPatches()).toHaveLength(2);
    expect(bannerPatches().at(-1)).toEqual({ paneId, hostBanner: null });
    // The pane is untouched and the ladder starts over: a NEW burst raises it
    // again (it could not, if the stage were still stuck at "banner").
    expect(listScriptPanes().map((p) => p.paneId)).toEqual([paneId]);
    expect(deps.closedWith).toEqual([]);
    hammer(paneId, PANE_UPDATE_PER_SECOND + PANE_THROTTLE_BANNER_AT);
    expect(bannerPatches()).toHaveLength(3);
    expect(bannerPatches().at(-1)?.hostBanner?.kind).toBe("warning");
    expect(deps.audits.map((a) => a.method)).toEqual(["pane.throttle.banner", "pane.throttle.banner"]);
  });

  it("a script still being refused KEEPS the banner: the decay re-arms at the clear threshold instead of flapping", async () => {
    vi.useFakeTimers();
    const paneId = await dock(r, deps);
    hammer(paneId, PANE_UPDATE_PER_SECOND + PANE_THROTTLE_BANNER_AT);
    expect(bannerPatches()).toHaveLength(1);
    // Half a minute on, a smaller burst: still above PANE_THROTTLE_BANNER_CLEAR_AT.
    vi.advanceTimersByTime(30_000);
    hammer(paneId, PANE_UPDATE_PER_SECOND + PANE_THROTTLE_BANNER_CLEAR_AT + 2);
    // The first burst ages out, but the second keeps the count at the clear
    // threshold: no clear, and no second banner either (one banner per stage).
    vi.advanceTimersByTime(30_000);
    expect(bannerPatches()).toHaveLength(1);
    // Only when the second burst ages out too does the notice come down.
    vi.advanceTimersByTime(30_000);
    expect(bannerPatches()).toEqual([
      { paneId, hostBanner: { text: expect.stringMatching(/slowed down/), kind: "warning" } },
      { paneId, hostBanner: null },
    ]);
  });

  it("the THIRD cooldown within PANE_THROTTLE_CLOSE_WINDOW_MS force-closes the pane as 'throttled' — script told, user told, audited", async () => {
    vi.useFakeTimers();
    const paneId = await dock(r, deps);
    driveIntoCooldown(paneId);
    vi.advanceTimersByTime(PANE_THROTTLE_COOLDOWN_MS);
    driveIntoCooldown(paneId);
    vi.advanceTimersByTime(PANE_THROTTLE_COOLDOWN_MS);
    expect(bannerPatches().filter((p) => p.hostBanner?.until !== undefined)).toHaveLength(2);
    expect(listScriptPanes()).toHaveLength(1);
    driveIntoCooldown(paneId);
    // Closed, not a third banner.
    expect(bannerPatches().filter((p) => p.hostBanner?.until !== undefined)).toHaveLength(2);
    expect(r.closes).toEqual([{ paneId, reason: "throttled" }]);
    expect(deps.closedWith).toEqual([{ paneId, reason: "throttled" }]);
    expect(deps.forwarded.at(-1)).toEqual({
      hook: "onPaneClose",
      payload: { paneId, reason: "throttled", values: expect.any(Object) },
    });
    expect(deps.audits.map((a) => a.method)).toEqual([
      "pane.throttle.banner", "pane.throttle.cooldown",
      "pane.throttle.banner", "pane.throttle.cooldown",
      "pane.throttle.banner", "pane.throttle.close",
    ]);
    expect(listScriptPanes()).toEqual([]);
    // The script's next call is the closed-pane no-op, not a throw.
    expect(() => updateScriptPane(OWNER.scriptId, paneId, { values: { note: "late" } })).not.toThrow();
  });

  it("a third cooldown OUTSIDE the window is a cooldown, not a close — the ladder forgets after ten quiet minutes", async () => {
    vi.useFakeTimers();
    const paneId = await dock(r, deps);
    driveIntoCooldown(paneId);
    vi.advanceTimersByTime(PANE_THROTTLE_COOLDOWN_MS);
    driveIntoCooldown(paneId);
    vi.advanceTimersByTime(PANE_THROTTLE_CLOSE_WINDOW_MS);
    driveIntoCooldown(paneId);
    expect(r.closes).toEqual([]);
    expect(listScriptPanes().map((p) => p.paneId)).toEqual([paneId]);
    expect(bannerPatches().filter((p) => p.hostBanner?.until !== undefined)).toHaveLength(3);
  });

  it("a close during a cooldown ends the session cleanly: no banner patch fires for a pane that is gone", async () => {
    vi.useFakeTimers();
    const paneId = await dock(r, deps);
    driveIntoCooldown(paneId);
    r.close(paneId);
    const before = r.patches.length;
    vi.advanceTimersByTime(PANE_THROTTLE_COOLDOWN_MS + 1);
    expect(r.patches).toHaveLength(before);
    expect(deps.closedWith).toEqual([{ paneId, reason: "user" }]);
  });

  it("revoke and reset clear the reveal bucket and the gesture stamp", async () => {
    vi.useFakeTimers();
    const paneId = await dockOpened(r, deps);
    for (let i = 0; i < PANE_REVEALS_PER_MINUTE; i++) {
      noteScriptGesture(OWNER.scriptId);
      reveal(paneId);
    }
    noteScriptGesture(OWNER.scriptId);
    expect(reveal(paneId).reason).toBe("throttled");
    revokeScriptPanes(OWNER.scriptId);
    const again = await dockOpened(r, deps);
    expect(reveal(again)).toEqual({ revealed: true });
    for (let i = 0; i < PANE_REVEALS_PER_MINUTE - 1; i++) reveal(again);
    expect(reveal(again).reason).toBe("throttled");
    resetScriptPanes();
    const third = await dockOpened(r, deps);
    expect(reveal(third)).toEqual({ revealed: true });
  });
});
