//! FILENAME: app/extensions/ScriptableObjects/__tests__/scriptEmbedHost.test.ts
// PURPOSE: The renderer wiring for forms EMBEDDED on a sheet (M3c): that the set
//          of surfaces is the set of PLACEMENTS, that a request naming a
//          placement is taken by this wiring and a docked pane's is not, and
//          that the two states a blank box would hide — an orphan and a refusal
//          — reach the screen and STAY there.
// CONTEXT: Headless. The DOM/canvas half is injected (`ScriptEmbedHostDeps`), so
//          every rule here is tested without a grid: the layer that owns pixels
//          is lib/embeddedFormLayer.ts and is deliberately thin.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AppEvents, emitAppEvent } from "@api/events";
import {
  SCRIPT_PANE_CLOSE_EVENT,
  SCRIPT_PANE_INPUT_EVENT,
  SCRIPT_PANE_PATCH_EVENT,
  SCRIPT_PANE_REQUEST_EVENT,
  type ScriptPaneInputPayload,
  type ScriptPaneRequestPayload,
} from "@api/scriptHost/scriptPaneSpec";
import {
  EMBEDDED_FORM_ORPHAN_REMEDY,
  MAX_EMBEDDED_FORMS_PER_SHEET,
  __resetEmbeddedFormPlacementsForTests,
  __setEmbeddedFormIdMinterForTests,
  listEmbeddedFormPlacements,
  placeEmbeddedForm,
  removeEmbeddedFormPlacement,
  shiftEmbeddedFormPlacements,
  structuralAnchorShift,
} from "@api/scriptHost/embeddedFormPlacements";
import type { FormSpec } from "@api/scriptHost/scriptFormSpec";
import {
  closedSentence,
  installScriptEmbedHost,
  type EmbeddedFormSurfaceView,
  type ScriptEmbedHostDeps,
  type ScriptEmbedHostHandle,
} from "../lib/scriptEmbedHost";

const SCRIPT_ID = "form-script";

const SPEC: FormSpec = {
  title: "Order",
  children: [{ type: "textbox", name: "note", label: "Note" }],
};

function request(over: Partial<ScriptPaneRequestPayload> = {}): ScriptPaneRequestPayload {
  return {
    paneId: "pane-1",
    paneKey: "k",
    scriptId: SCRIPT_ID,
    scriptName: "Order entry",
    origin: { kind: "local" },
    spec: SPEC,
    seeds: {},
    open: false,
    ...over,
  };
}

/** A recording stand-in for the pixels half. */
function recorder() {
  const painted: EmbeddedFormSurfaceView[] = [];
  const forgotten: string[] = [];
  const closed: Array<{ placementId: string; reason: string }> = [];
  const opens: string[] = [];
  /** Whoever the wiring subscribed for paint edges — the layer, in the app. */
  const visibility = new Set<(placementId: string, visible: boolean) => void>();
  /** Whoever the wiring subscribed for sheet-tab edges — also the layer. */
  const sheetSubs = new Set<(sheetIndex: number) => void>();
  /** The sheet the user is standing on, the layer's answer. */
  let activeSheet = 0;
  let answer: (id: string) => Promise<{ ok: true; paneId: string } | { ok: false; reason: string }> = async () => ({
    ok: false,
    reason: "no host in this test",
  });
  const deps: ScriptEmbedHostDeps = {
    paint: (placementId, view) => painted.push(view),
    forget: (placementId) => forgotten.push(placementId),
    onSurfaceVisibility: (handler) => {
      visibility.add(handler);
      return () => visibility.delete(handler);
    },
    activeSheetIndex: () => activeSheet,
    onActiveSheetChange: (handler) => {
      sheetSubs.add(handler);
      return () => sheetSubs.delete(handler);
    },
    openSession: (placementId) => {
      opens.push(placementId);
      return answer(placementId);
    },
    closeSession: (placementId, reason) => closed.push({ placementId, reason }),
  };
  return {
    deps,
    painted,
    forgotten,
    closed,
    opens,
    /** The latest view painted for one placement. */
    latest: (placementId: string) => [...painted].reverse().find((v) => v.placementId === placementId),
    /**
     * The layer's paint edge, by hand: `embeddedFormLayer` calls this from the
     * SAME branch that writes `display`, which is the whole point of the signal.
     */
    surfacePainted: (placementId: string, visible: boolean) => {
      for (const handler of [...visibility]) handler(placementId, visible);
    },
    /** Is anyone still subscribed? The teardown has to let go of the layer. */
    visibilitySubscribers: () => visibility.size,
    /**
     * The user clicked a sheet tab. `embeddedFormLayer` announces this from the
     * SAME place it republishes the region set, so the wiring learns about a
     * sheet it has no painted surface on — which is the only way a placement
     * over there can ever be opened.
     */
    switchToSheet: (sheetIndex: number) => {
      activeSheet = sheetIndex;
      for (const handler of [...sheetSubs]) handler(sheetIndex);
    },
    setAnswer: (fn: typeof answer) => {
      answer = fn;
    },
  };
}

let rec: ReturnType<typeof recorder>;
let stop: ScriptEmbedHostHandle;

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

beforeEach(() => {
  __resetEmbeddedFormPlacementsForTests();
  rec = recorder();
});

afterEach(() => {
  stop?.();
  __resetEmbeddedFormPlacementsForTests();
  vi.restoreAllMocks();
});

function install(): void {
  stop = installScriptEmbedHost(rec.deps);
}

// ----------------------------------------------------------------------------
// The set of surfaces IS the set of placements
// ----------------------------------------------------------------------------

describe("placements drive the surfaces", () => {
  it("asks the host to run a form for a placement that already exists at install", async () => {
    const p = placeEmbeddedForm({ scriptId: SCRIPT_ID, sheetIndex: 0, anchorRow: 1, anchorCol: 1 });
    rec.setAnswer(async () => ({ ok: true, paneId: "pane-1" }));
    install();
    await flush();
    expect(rec.opens).toEqual([p.id]);
  });

  it("asks for one placed AFTER install, and paints 'starting' while it waits", async () => {
    install();
    let release!: (v: { ok: true; paneId: string }) => void;
    rec.setAnswer(() => new Promise((resolve) => (release = resolve)));
    const p = placeEmbeddedForm({ scriptId: SCRIPT_ID, sheetIndex: 0, anchorRow: 1, anchorCol: 1 });
    await flush();
    expect(rec.opens).toEqual([p.id]);
    // An empty box is indistinguishable from a crashed script, so the gap says
    // what it is.
    expect(rec.latest(p.id)!.state).toMatchObject({ kind: "refused", reason: "Starting this form…" });
    release({ ok: true, paneId: "pane-1" });
    await flush();
  });

  it("does not start a second open while one is in flight, however often the sheet repaints", async () => {
    install();
    rec.setAnswer(() => new Promise(() => undefined));
    const p = placeEmbeddedForm({ scriptId: SCRIPT_ID, sheetIndex: 0, anchorRow: 1, anchorCol: 1 });
    await flush();
    for (let i = 0; i < 5; i++) stop.reconcile();
    await flush();
    // Each open is an IPC round trip per bound cell; a repaint must not be one.
    expect(rec.opens).toEqual([p.id]);
  });

  it("does not RETRY a refusal on its own — only the user's retry does", async () => {
    install();
    rec.setAnswer(async () => ({ ok: false, reason: "The script for this form is not running." }));
    const p = placeEmbeddedForm({ scriptId: SCRIPT_ID, sheetIndex: 0, anchorRow: 1, anchorCol: 1 });
    await flush();
    expect(rec.opens).toEqual([p.id]);
    expect(rec.latest(p.id)!.state).toMatchObject({ kind: "refused", reason: "The script for this form is not running." });

    // A dozen placement changes: still one attempt. A broken script must not be
    // restarted forever by its own failure.
    for (let i = 0; i < 5; i++) stop.reconcile();
    await flush();
    expect(rec.opens).toEqual([p.id]);

    rec.setAnswer(async () => ({ ok: true, paneId: "pane-9" }));
    stop.retry(p.id);
    await flush();
    expect(rec.opens).toEqual([p.id, p.id]);
  });

  it("does not open a placement on ANOTHER sheet until the user goes there", async () => {
    // The workbook opens on Sheet1 and this form was placed on Sheet2. Opening
    // it now would resolve its bindings from behind a sheet its user cannot
    // see: at restricted tier the home sheet is unreadable from here, and the
    // reads that DO succeed are another sheet's cells
    // (api/scriptHost/host.ts, `resolveFormBindings`).
    const elsewhere = placeEmbeddedForm({ scriptId: SCRIPT_ID, sheetIndex: 1, anchorRow: 1, anchorCol: 1 });
    rec.setAnswer(async () => ({ ok: true, paneId: "pane-2" }));
    install();
    await flush();
    expect(rec.opens).toEqual([]);

    // Repaints and placement changes must not sneak it open either — this is a
    // gate on the SHEET, not a one-shot at install.
    for (let i = 0; i < 3; i++) stop.reconcile();
    await flush();
    expect(rec.opens).toEqual([]);

    // The user clicks the Sheet2 tab: now, and only now, the session opens.
    rec.switchToSheet(1);
    await flush();
    expect(rec.opens).toEqual([elsewhere.id]);
  });

  it("keeps a session it opened when the user walks off its sheet", async () => {
    // The gate is on the OPEN, never on the session: the store, the typed
    // values and the bound-cell watch survive a tab click, which is the whole
    // reason the layer HIDES an off-sheet surface instead of dropping it.
    const p = placeEmbeddedForm({ scriptId: SCRIPT_ID, sheetIndex: 0, anchorRow: 1, anchorCol: 1 });
    rec.setAnswer(async () => ({ ok: true, paneId: "pane-1" }));
    install();
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request({ embedPlacementId: p.id }));
    await flush();
    expect(rec.opens).toEqual([p.id]);

    rec.switchToSheet(1);
    await flush();
    expect(rec.closed).toEqual([]);
    expect(rec.forgotten).toEqual([]);
    expect(rec.latest(p.id)!.state).toMatchObject({ kind: "open" });
  });
});

// ----------------------------------------------------------------------------
// The wire, and the filter that keeps two renderers apart
// ----------------------------------------------------------------------------

describe("the pane wire, filtered to placements", () => {
  it("takes a request that names a placement, and acknowledges it as EMBEDDED", async () => {
    install();
    const p = placeEmbeddedForm({ scriptId: SCRIPT_ID, sheetIndex: 0, anchorRow: 1, anchorCol: 1 });
    const acks: ScriptPaneInputPayload[] = [];
    const onInput = (e: Event): void => {
      acks.push((e as CustomEvent).detail as ScriptPaneInputPayload);
    };
    window.addEventListener(SCRIPT_PANE_INPUT_EVENT, onInput);
    try {
      emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request({ embedPlacementId: p.id }));
      await flush();
      expect(acks.map((a) => a.kind)).toEqual(["docked"]);
      expect(acks[0].placement).toBe("embedded");
      expect(rec.latest(p.id)!.state.kind).toBe("open");
    } finally {
      window.removeEventListener(SCRIPT_PANE_INPUT_EVENT, onInput);
    }
  });

  it("IGNORES a docked task pane's request — that one belongs to scriptPaneHost", async () => {
    install();
    const acks: ScriptPaneInputPayload[] = [];
    const onInput = (e: Event): void => {
      acks.push((e as CustomEvent).detail as ScriptPaneInputPayload);
    };
    window.addEventListener(SCRIPT_PANE_INPUT_EVENT, onInput);
    try {
      // No `embedPlacementId`: a pane the script docked. Painting it here too
      // would put one pane on screen twice, with two stores collecting the
      // user's keystrokes.
      emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request());
      await flush();
      expect(acks).toEqual([]);
      expect(rec.painted).toEqual([]);
    } finally {
      window.removeEventListener(SCRIPT_PANE_INPUT_EVENT, onInput);
    }
  });

  it("routes a badge patch to the surface's band, and a values patch to its store", async () => {
    install();
    const p = placeEmbeddedForm({ scriptId: SCRIPT_ID, sheetIndex: 0, anchorRow: 1, anchorCol: 1 });
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request({ embedPlacementId: p.id }));
    await flush();

    emitAppEvent(SCRIPT_PANE_PATCH_EVENT, { paneId: "pane-1", badge: "3" });
    await flush();
    expect(rec.latest(p.id)!.badge).toBe("3");

    emitAppEvent(SCRIPT_PANE_PATCH_EVENT, { paneId: "pane-1", patch: { values: { note: "hi" } } });
    await flush();
    const view = rec.latest(p.id)!;
    expect(view.state.kind).toBe("open");
    if (view.state.kind === "open") {
      expect(view.state.store.getSnapshot().values.note).toBe("hi");
    }
  });
});

// ----------------------------------------------------------------------------
// On screen / off screen — the gate on the host's bound-cell watch
// ----------------------------------------------------------------------------
//
// THE DEFECT THIS BLOCK PINS. "visible"/"hidden" are what arm and tear down
// `installBoundLiveWatch` (`paneSessionDeps` in api/scriptHost/host.ts), on the
// invariant that a surface nobody can see reads nothing. They used to come from
// the React component's mount effect, which never runs again for this surface:
// the layer hides a scrolled-away placement with `display: none` and keeps the
// element AND the React root, so a form bound to A1:A20 and scrolled out of the
// viewport went on re-reading those cells on every edit — one audit entry per
// cell — and announcing them to the script as `onPaneChange { source: "cell" }`.

describe("the paint edge is what says a surface is on screen", () => {
  /** Every renderer -> host input, in order, while `body` runs. */
  async function inputsDuring(body: () => Promise<void> | void): Promise<ScriptPaneInputPayload[]> {
    const seen: ScriptPaneInputPayload[] = [];
    const onInput = (e: Event): void => {
      seen.push((e as CustomEvent).detail as ScriptPaneInputPayload);
    };
    window.addEventListener(SCRIPT_PANE_INPUT_EVENT, onInput);
    try {
      await body();
      await flush();
    } finally {
      window.removeEventListener(SCRIPT_PANE_INPUT_EVENT, onInput);
    }
    return seen;
  }

  it("reports HIDDEN when the layer stops painting a live surface", async () => {
    install();
    const p = placeEmbeddedForm({ scriptId: SCRIPT_ID, sheetIndex: 0, anchorRow: 1, anchorCol: 1 });
    const kinds = await inputsDuring(async () => {
      emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request({ embedPlacementId: p.id }));
      await flush();
      // The grid paints the placement, then the user scrolls it away. Both
      // edges leave the layer's `display` branch; nothing here watches React.
      rec.surfacePainted(p.id, true);
      await flush();
      rec.surfacePainted(p.id, false);
    });
    expect(kinds.map((k) => k.kind)).toEqual(["docked", "visible", "hidden"]);
  });

  it("reports VISIBLE for a session that opens on an ALREADY painted placement", async () => {
    install();
    const p = placeEmbeddedForm({ scriptId: SCRIPT_ID, sheetIndex: 0, anchorRow: 1, anchorCol: 1 });
    const kinds = await inputsDuring(async () => {
      // The surface is painted long before its session exists — it shows
      // "Starting this form…" while the open is in flight — so the fact has to
      // be REMEMBERED and applied when the store appears, in this order.
      rec.surfacePainted(p.id, true);
      await flush();
      emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request({ embedPlacementId: p.id }));
    });
    // "docked" first: the acknowledgement settles the session and relays the
    // surface's id into the script's shim before anything else about it.
    expect(kinds.map((k) => k.kind)).toEqual(["docked", "visible"]);
  });

  it("announces nothing for a placement with no session, and stops at teardown", async () => {
    install();
    const p = placeEmbeddedForm({ scriptId: SCRIPT_ID, sheetIndex: 0, anchorRow: 1, anchorCol: 1 });
    // The open was refused (the default answer): there is no store to report to,
    // and a paint edge must not invent one.
    await flush();
    const kinds = await inputsDuring(() => {
      rec.surfacePainted(p.id, true);
      rec.surfacePainted(p.id, false);
    });
    expect(kinds).toEqual([]);

    // The teardown lets go of the layer: a surviving handler would reach into a
    // disposed wiring on the next frame.
    expect(rec.visibilitySubscribers()).toBe(1);
    stop();
    expect(rec.visibilitySubscribers()).toBe(0);
  });
});

// ----------------------------------------------------------------------------
// The box stays; only the session ends
// ----------------------------------------------------------------------------

describe("what a closed session leaves behind", () => {
  it("keeps the surface and says WHY nothing is running in it", async () => {
    install();
    const p = placeEmbeddedForm({ scriptId: SCRIPT_ID, sheetIndex: 0, anchorRow: 1, anchorCol: 1 });
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request({ embedPlacementId: p.id }));
    await flush();
    expect(rec.latest(p.id)!.state.kind).toBe("open");

    emitAppEvent(SCRIPT_PANE_CLOSE_EVENT, { paneId: "pane-1", reason: "unmount" });
    await flush();
    // NOT forgotten: the placement is still on the sheet.
    expect(rec.forgotten).toEqual([]);
    expect(rec.latest(p.id)!.state).toEqual({
      kind: "refused",
      scriptName: null,
      reason: closedSentence("unmount"),
    });
  });

  it("ends the session and paints the ORPHAN when a structural edit deletes the anchor", async () => {
    install();
    const p = placeEmbeddedForm({ scriptId: SCRIPT_ID, sheetIndex: 0, anchorRow: 5, anchorCol: 1 });
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request({ embedPlacementId: p.id }));
    await flush();

    shiftEmbeddedFormPlacements(0, structuralAnchorShift("rowDelete", 5, 1));
    await flush();

    expect(rec.closed).toEqual([{ placementId: p.id, reason: "orphaned" }]);
    expect(rec.latest(p.id)!.state.kind).toBe("orphaned");
    // The surface is still there, and it is not forgotten — that is what makes
    // the orphan visible rather than a silent disappearance.
    expect(rec.forgotten).toEqual([]);
  });

  it("closes as 'user' and FORGETS the surface when the object is deleted from the sheet", async () => {
    install();
    const p = placeEmbeddedForm({ scriptId: SCRIPT_ID, sheetIndex: 0, anchorRow: 1, anchorCol: 1 });
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request({ embedPlacementId: p.id }));
    await flush();

    removeEmbeddedFormPlacement(p.id);
    await flush();
    expect(rec.closed).toEqual([{ placementId: p.id, reason: "user" }]);
    expect(rec.forgotten).toEqual([p.id]);
  });

  it("carries the placement's box to the surface, so a resize reaches the widget tree", async () => {
    install();
    const p = placeEmbeddedForm({
      scriptId: SCRIPT_ID,
      sheetIndex: 0,
      anchorRow: 1,
      anchorCol: 1,
      width: 480,
      height: 360,
    });
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request({ embedPlacementId: p.id }));
    await flush();
    expect(rec.latest(p.id)).toMatchObject({ width: 480, height: 360 });
  });
});

// ----------------------------------------------------------------------------
// A placement belongs to the DOCUMENT
// ----------------------------------------------------------------------------

describe("a workbook swap forgets every placement", () => {
  /** Two placements with two live sessions — workbook A, as the user left it. */
  async function twoOpenSurfaces(): Promise<[string, string]> {
    install();
    const a = placeEmbeddedForm({ scriptId: SCRIPT_ID, sheetIndex: 0, anchorRow: 1, anchorCol: 1 });
    const b = placeEmbeddedForm({ scriptId: SCRIPT_ID, sheetIndex: 0, anchorRow: 8, anchorCol: 1 });
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request({ paneId: "pane-a", embedPlacementId: a.id }));
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request({ paneId: "pane-b", embedPlacementId: b.id }));
    await flush();
    expect(rec.latest(a.id)!.state.kind).toBe("open");
    expect(rec.latest(b.id)!.state.kind).toBe("open");
    return [a.id, b.id];
  }

  it("drops the store and the surfaces on AFTER_OPEN — the ghosts do not paint over workbook B", async () => {
    const [a, b] = await twoOpenSurfaces();

    // THE DEFECT THIS CLOSES: the host's sweep ended the SESSIONS as "reset", so
    // each box repainted with "The workbook this form belonged to was closed or
    // replaced." and then stayed on the grid — opaque, click-claiming, never
    // retried — over the cells of the workbook that had just replaced this one.
    emitAppEvent(AppEvents.AFTER_OPEN);
    await flush();

    expect(listEmbeddedFormPlacements()).toEqual([]);
    expect(rec.forgotten.sort()).toEqual([a, b].sort());
  });

  it("does the same for File > New", async () => {
    const [a, b] = await twoOpenSurfaces();
    emitAppEvent(AppEvents.AFTER_NEW);
    await flush();
    expect(listEmbeddedFormPlacements()).toEqual([]);
    expect(rec.forgotten.sort()).toEqual([a, b].sort());
  });

  it("closes NOTHING as 'user' — that reason flushes a pending write into the NEW workbook", async () => {
    await twoOpenSurfaces();
    emitAppEvent(AppEvents.AFTER_OPEN);
    await flush();
    // Ending these sessions is `hostResetAll`'s job, and it ends them as
    // "reset", which DROPS what the user typed. A "user" close here would write
    // workbook A's values into workbook B's cells of the same address.
    expect(rec.closed).toEqual([]);
  });

  it("sweeps the same either way round — the host's reset may land first", async () => {
    const [a, b] = await twoOpenSurfaces();
    // The other ordering: `hostResetAll` -> `resetScriptPanes` reached the
    // registry before this handler ran, so both sessions are already closed as
    // "reset" and their sentences are remembered as refusals.
    emitAppEvent(SCRIPT_PANE_CLOSE_EVENT, { paneId: "pane-a", reason: "reset" });
    emitAppEvent(SCRIPT_PANE_CLOSE_EVENT, { paneId: "pane-b", reason: "reset" });
    await flush();
    expect(rec.latest(a)!.state).toMatchObject({ kind: "refused", reason: closedSentence("reset") });

    emitAppEvent(AppEvents.AFTER_OPEN);
    await flush();
    expect(listEmbeddedFormPlacements()).toEqual([]);
    expect(rec.forgotten.sort()).toEqual([a, b].sort());
    expect(rec.closed).toEqual([]);
  });

  it("gives the new workbook its whole per-sheet budget back", async () => {
    install();
    for (let i = 0; i < MAX_EMBEDDED_FORMS_PER_SHEET; i++) {
      placeEmbeddedForm({ scriptId: SCRIPT_ID, sheetIndex: 0, anchorRow: i, anchorCol: 1 });
    }
    await flush();
    // Workbook A's sheet is full.
    expect(() =>
      placeEmbeddedForm({ scriptId: SCRIPT_ID, sheetIndex: 0, anchorRow: 99, anchorCol: 1 }),
    ).toThrow(/already holds \d+ embedded forms/);

    emitAppEvent(AppEvents.AFTER_OPEN);
    await flush();

    // ...and workbook B's is not. Its ghosts used to hold the budget, so the
    // user's FIRST placement in the new file was refused by name.
    expect(() =>
      placeEmbeddedForm({ scriptId: SCRIPT_ID, sheetIndex: 0, anchorRow: 0, anchorCol: 1 }),
    ).not.toThrow();
    expect(listEmbeddedFormPlacements()).toHaveLength(1);
  });

  it("remembers no refusal from an open still in flight when the swap lands", async () => {
    // Production ids are minted UUIDs and never come back, so pinning the minter
    // is what makes "nothing is remembered against a dead placement" observable.
    __setEmbeddedFormIdMinterForTests(() => "placement-1");
    install();
    let release!: (v: { ok: false; reason: string }) => void;
    rec.setAnswer(() => new Promise((resolve) => (release = resolve)));
    placeEmbeddedForm({ scriptId: SCRIPT_ID, sheetIndex: 0, anchorRow: 1, anchorCol: 1 });
    await flush();
    expect(rec.opens).toEqual(["placement-1"]);

    emitAppEvent(AppEvents.AFTER_OPEN);
    await flush();
    // Workbook A's open answers AFTER the swap, about a placement that is gone.
    release({ ok: false, reason: "The script for this form is not running." });
    await flush();
    expect(listEmbeddedFormPlacements()).toEqual([]);

    // Workbook B's first placement. A refusal filed against the dead id would
    // short-circuit its open — `reconcile` never retries a refusal — and paint
    // workbook A's sentence in a form that was never even asked to start.
    rec.setAnswer(async () => ({ ok: true, paneId: "pane-new" }));
    placeEmbeddedForm({ scriptId: SCRIPT_ID, sheetIndex: 0, anchorRow: 3, anchorCol: 3 });
    await flush();
    expect(rec.opens).toEqual(["placement-1", "placement-1"]);
    // ...and what it paints while it starts is its own "Starting…", never the
    // sentence the previous workbook's open was refused with.
    expect(rec.latest("placement-1")!.state).toMatchObject({
      kind: "refused",
      reason: "Starting this form…",
    });
  });

  it("does nothing at all when there is nothing to forget", async () => {
    install();
    await flush();
    emitAppEvent(AppEvents.AFTER_OPEN);
    await flush();
    expect(rec.forgotten).toEqual([]);
    expect(rec.painted).toEqual([]);
  });
});

describe("the sentences an inert surface shows", () => {
  it("has one for every close reason, and each names a state the user can act on", () => {
    for (const reason of ["user", "script", "failed", "unmount", "reset", "throttled", "orphaned"] as const) {
      const s = closedSentence(reason);
      expect(s.length, reason).toBeGreaterThan(0);
      expect(s, reason).toMatch(/\.$/);
    }
    expect(closedSentence("unmount")).toMatch(/Code in This File/);
    // THE ORPHAN ARM READS THE SHARED REMEDY, and does not spell one of its
    // own. It used to say "Drag it onto a cell to put it back" — a gesture no
    // code implements — in a third spelling beside the card's and the host's,
    // which is how all three could be wrong at once and none of them noticed.
    expect(closedSentence("orphaned")).toContain(EMBEDDED_FORM_ORPHAN_REMEDY);
    expect(closedSentence("orphaned")).not.toMatch(/drag/i);
  });
});
