//! FILENAME: app/src/core/lib/__tests__/pointModeSheetSwitch.test.ts
// PURPOSE: THE point-mode sheet switch (switch the VIEWED sheet without ending
//          the edit) and ending an external session with its return to the host.
// CONTEXT: The ORDER is the contract: a session is parked AFTER the backend
//          switched and BEFORE the dispatch, so the render the dispatch causes
//          -- paint, and every hit test until the next render -- already sees
//          it; and a parked session returns to its host BEFORE the owner commits,
//          so the commit's own follow-up (the Enter move, the focus restore)
//          lands on the right sheet.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

const api = vi.hoisted(() => ({
  setActiveSheet: vi.fn(),
}));

vi.mock("../tauri-api", () => ({
  setActiveSheet: api.setActiveSheet,
}));

import {
  switchSheetForPointMode,
  endExternalFormulaSession,
  focusFormulaBar,
  focusExternalSessionView,
} from "../pointModeSheetSwitch";
import {
  isExternalSessionParked,
  getParkedViewSheetIndex,
  getExternalEditSession,
  __resetExternalEditForTests,
} from "../formulaEditTarget";
import { createFakeExternalEdit } from "./helpers/fakeExternalEdit";
import type { GridAction } from "../../state/gridActions";

const SHEETS = [
  { index: 0, name: "Sheet1", visibility: "visible" },
  { index: 1, name: "Data", visibility: "visible" },
  { index: 2, name: "Report", visibility: "visible", kind: "canvas" },
];

/** What the backend answers for a switch to `index`. */
function resultFor(index: number, sheets = SHEETS) {
  return { sheets, activeIndex: index };
}

let log: string[];
let windowEvents: string[];
const onWindowEvent = (e: Event) => {
  windowEvents.push(e.type);
  log.push(`event:${e.type}`);
};

beforeEach(() => {
  log = [];
  windowEvents = [];
  api.setActiveSheet.mockReset();
  api.setActiveSheet.mockImplementation(async (index: number) => {
    log.push(`api:${index}`);
    return resultFor(index);
  });
  window.addEventListener("sheet:formulaModeSwitch", onWindowEvent);
  window.addEventListener("dimensions:refresh", onWindowEvent);
});

afterEach(() => {
  window.removeEventListener("sheet:formulaModeSwitch", onWindowEvent);
  window.removeEventListener("dimensions:refresh", onWindowEvent);
  __resetExternalEditForTests();
  document.body.innerHTML = "";
});

/** A dispatch spy that also records whether the session was ALREADY parked. */
function dispatchSpy() {
  const actions: GridAction[] = [];
  const dispatch = vi.fn((action: GridAction) => {
    actions.push(action);
    log.push(`dispatch:parked=${isExternalSessionParked()}`);
  });
  return { dispatch, actions };
}

describe("switchSheetForPointMode", () => {
  it("parks a live session BEFORE the dispatch, names the sheet from the RESULT, then refetches and refreshes", async () => {
    const fake = createFakeExternalEdit({ hostSheetIndex: 2, text: "=" });
    fake.register();
    const { dispatch, actions } = dispatchSpy();

    const result = await switchSheetForPointMode(0, dispatch);

    expect(result.activeIndex).toBe(0);
    expect(log).toEqual([
      "api:0",
      "dispatch:parked=true",
      "event:sheet:formulaModeSwitch",
      "event:dimensions:refresh",
    ]);
    expect(actions[0].payload).toEqual({ index: 0, name: "Sheet1", surface: "grid" });
    expect(getParkedViewSheetIndex()).toBe(0);
    expect(fake.session.parkedFlips).toEqual([true]);
  });

  it("without a session it parks nothing and does NOT refresh dimensions (the grid editor's own trip)", async () => {
    const { dispatch } = dispatchSpy();
    await switchSheetForPointMode(1, dispatch);
    expect(log).toEqual(["api:1", "dispatch:parked=false", "event:sheet:formulaModeSwitch"]);
    expect(windowEvents).not.toContain("dimensions:refresh");
  });

  it("a canvas result carries the canvas surface; a sheet missing from the list omits it", async () => {
    const fake = createFakeExternalEdit({ hostSheetIndex: 0, text: "=" });
    fake.register();
    const { dispatch, actions } = dispatchSpy();
    await switchSheetForPointMode(2, dispatch);
    expect(actions[0].payload).toEqual({ index: 2, name: "Report", surface: "canvas" });

    // An object-backed sheet is absent from the list while its index stays true.
    api.setActiveSheet.mockImplementationOnce(async (index: number) => resultFor(index, SHEETS.slice(0, 2)));
    await switchSheetForPointMode(5, dispatch);
    expect(actions[1].payload).toEqual({ index: 5, name: "" });
  });
});

describe("endExternalFormulaSession", () => {
  it("parked: switches BACK to the host first, THEN commits with the move", async () => {
    const fake = createFakeExternalEdit({ hostSheetIndex: 2, text: "=Sheet1!E2" });
    fake.register();
    const { dispatch } = dispatchSpy();
    await switchSheetForPointMode(0, dispatch);
    log = [];
    const commit = fake.session.commit;
    fake.session.commit = (move) => {
      log.push(`commit:${move}:parked=${isExternalSessionParked()}`);
      return commit(move);
    };

    const ok = await endExternalFormulaSession("commit", "down", dispatch);

    expect(ok).toBe(true);
    expect(log).toEqual([
      "api:2",
      "dispatch:parked=false",
      "event:sheet:formulaModeSwitch",
      "event:dimensions:refresh",
      "commit:down:parked=false",
    ]);
    expect(fake.session.parkedFlips).toEqual([true, false]);
    expect(getExternalEditSession()).toBeNull();
  });

  it("on the host: no switch at all; cancel mirrors commit", async () => {
    const fake = createFakeExternalEdit({ hostSheetIndex: 2, text: "=1" });
    fake.register();
    const { dispatch } = dispatchSpy();
    expect(await endExternalFormulaSession("cancel", null, dispatch)).toBe(true);
    expect(api.setActiveSheet).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(fake.calls.map((c) => c.fn)).toEqual(["cancel"]);

    const other = createFakeExternalEdit({ hostSheetIndex: 2, text: "=1", commitResult: false });
    other.register();
    // The owner's refusal is what the caller hears.
    expect(await endExternalFormulaSession("commit", "right", dispatch)).toBe(false);
    expect(other.calls).toEqual([{ fn: "commit", args: ["right"] }]);
  });

  it("with no session there is nothing to end", async () => {
    expect(await endExternalFormulaSession("commit", "down")).toBe(false);
  });

  it("is RE-ENTRY guarded: a second call while the first awaits the switch is refused, and the owner commits once", async () => {
    const fake = createFakeExternalEdit({ hostSheetIndex: 2, text: "=Sheet1!E2" });
    fake.register();
    const { dispatch } = dispatchSpy();
    await switchSheetForPointMode(0, dispatch);

    let release: () => void = () => undefined;
    api.setActiveSheet.mockImplementationOnce(
      (index: number) => new Promise((resolve) => { release = () => resolve(resultFor(index)); }),
    );
    const first = endExternalFormulaSession("commit", "down", dispatch);
    const second = await endExternalFormulaSession("commit", "down", dispatch);
    expect(second).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(fake.calls.filter((c) => c.fn === "commit")).toHaveLength(1);
  });

  it("a host that cannot be switched back to still ENDS the session, clears parked, and releases the guard", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fake = createFakeExternalEdit({ hostSheetIndex: 2, text: "=Sheet1!E2" });
    fake.register();
    const { dispatch } = dispatchSpy();
    await switchSheetForPointMode(0, dispatch);

    api.setActiveSheet.mockImplementationOnce(async () => {
      throw new Error("sheet 2 is gone");
    });
    expect(await endExternalFormulaSession("commit", null, dispatch)).toBe(true);
    expect(fake.calls.filter((c) => c.fn === "commit")).toHaveLength(1);
    expect(isExternalSessionParked()).toBe(false);

    // The in-flight flag was released (finally): the next session ends normally.
    const next = createFakeExternalEdit({ hostSheetIndex: 0, text: "=1" });
    next.register();
    expect(await endExternalFormulaSession("cancel", null, dispatch)).toBe(true);
    expect(next.calls.map((c) => c.fn)).toEqual(["cancel"]);
    err.mockRestore();
  });
});

describe("focus after a point-mode switch", () => {
  function mountBar(value: string): HTMLInputElement {
    const bar = document.createElement("input");
    bar.setAttribute("data-formula-bar", "true");
    bar.value = value;
    document.body.appendChild(bar);
    return bar;
  }

  it("focusFormulaBar focuses the bar with a clamped caret, and says so", () => {
    expect(focusFormulaBar(3)).toBe(false);
    const bar = mountBar("=Sheet1!E2");
    expect(focusFormulaBar(99)).toBe(true);
    expect(document.activeElement).toBe(bar);
    expect(bar.selectionStart).toBe(bar.value.length);
    focusFormulaBar(1);
    expect(bar.selectionStart).toBe(1);
  });

  it("parked: the bar at the session's caret; on the host: the owner's in-place view -- never both", async () => {
    const bar = mountBar("=+");
    const fake = createFakeExternalEdit({ hostSheetIndex: 2, text: "=+", cursor: 1 });
    fake.register();
    const { dispatch } = dispatchSpy();
    await switchSheetForPointMode(0, dispatch);

    focusExternalSessionView();
    expect(document.activeElement).toBe(bar);
    expect(bar.selectionStart).toBe(1);
    expect(fake.calls.some((c) => c.fn === "focusCellView")).toBe(false);

    bar.blur();
    await switchSheetForPointMode(2, dispatch);
    focusExternalSessionView();
    expect(fake.calls.filter((c) => c.fn === "focusCellView")).toHaveLength(1);
    expect(document.activeElement).not.toBe(bar);
  });

  it("parked with the formula bar HIDDEN: the grid's keyboard container takes the keyboard, never the hidden in-place view", async () => {
    // View > Formula Bar off: no [data-formula-bar] exists. The owner's in-place
    // view is hidden while parked, so before the fallback the focus decision
    // focused NOTHING -- the keyboard sat on the body, where Enter, Tab and
    // Escape could not end the edit and typed characters were dropped.
    const container = document.createElement("div");
    container.setAttribute("data-focus-container", "spreadsheet");
    container.tabIndex = 0;
    document.body.appendChild(container);
    const fake = createFakeExternalEdit({ hostSheetIndex: 2, text: "=", cursor: 1 });
    fake.register();
    const { dispatch } = dispatchSpy();
    await switchSheetForPointMode(0, dispatch);
    expect(isExternalSessionParked()).toBe(true);
    expect(document.activeElement).toBe(document.body);

    focusExternalSessionView();

    expect(document.activeElement).toBe(container);
    expect(fake.calls.some((c) => c.fn === "focusCellView")).toBe(false);
  });

  it("on the host with the bar hidden, the owner's in-place view is still the answer (the container is only the PARKED fallback)", async () => {
    const container = document.createElement("div");
    container.setAttribute("data-focus-container", "spreadsheet");
    container.tabIndex = 0;
    document.body.appendChild(container);
    const fake = createFakeExternalEdit({ hostSheetIndex: 2, text: "=", cursor: 1 });
    fake.register();

    focusExternalSessionView();

    expect(fake.calls.filter((c) => c.fn === "focusCellView")).toHaveLength(1);
    expect(document.activeElement).not.toBe(container);
  });
});
