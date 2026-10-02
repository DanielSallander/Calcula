//! FILENAME: app/extensions/Pivot/lib/__tests__/pivotCellChrome.test.ts
// PURPOSE: A WORKSHEET pivot's in-cell chrome -- the +/- buttons, the report
//          filter combos, the Row/Column Labels filter buttons and the loading
//          indicator's Cancel -- acts on RELEASE over the same piece of chrome,
//          through Core's one release-time seam (BUG-0258 design phase 4; the
//          canvas pivot box got the same rule in M7, pivotChromePress.ts):
//            - a press on chrome is CLAIMED for its release (a release claim,
//              @api/cellClickInterceptors) and runs nothing yet;
//            - the claim's target is that ONE piece of chrome: another +/-, a
//              point off the chrome, another pivot's chrome is not it;
//            - its release runs the action once, a menu anchored where the
//              pointer was RELEASED;
//            - a press the chrome cannot serve (a +/- whose cell is not in the
//              cached view, a report filter the backend no longer knows) is NOT
//              claimed: Core selects the cell, as before;
//            - the module's interceptor is the pivot's ONLY cell click
//              interceptor, and the extension no longer acts in one;
//            - a DOUBLE-CLICK on a piece of chrome acts once: the canvas box's
//              450 ms guard, ONE guard for both (owner question 27, 2026-10-02;
//              a worksheet +/- used to toggle twice, back to where it was).
// CONTEXT: The chrome's actions are mocked at their module (pivotChromeActions.ts),
//          so what is observed is WHAT a claim does and WHEN it would run. When
//          it runs is Core's (core/lib/cellPressRelease.ts, its own tests). The
//          clock is faked (Date only) and moved 10 s on per test, so the
//          double-click guard never joins two tests' releases.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

const api = vi.hoisted(() => ({
  togglePivotHeaderAt: vi.fn(async () => true),
  findPivotReportFilterZone: vi.fn(async (): Promise<unknown> => ({ fieldIndex: 2, fieldName: "Region", row: 0, col: 1 })),
  openPivotReportFilterZone: vi.fn(),
  openPivotHeaderFilter: vi.fn(),
  cancelPivotLoading: vi.fn(),
  getPivotViewCell: vi.fn((): unknown => ({ formattedValue: "North" })),
}));

vi.mock("../pivotChromeActions", () => ({
  togglePivotHeaderAt: api.togglePivotHeaderAt,
  findPivotReportFilterZone: api.findPivotReportFilterZone,
  openPivotReportFilterZone: api.openPivotReportFilterZone,
  openPivotHeaderFilter: api.openPivotHeaderFilter,
  cancelPivotLoading: api.cancelPivotLoading,
  getPivotViewCell: api.getPivotViewCell,
}));

import { isCellReleaseClaim, type CellClickAnswer, type CellPressPoint, type CellReleaseClaim } from "@api/cellClickInterceptors";
import {
  claimPivotCellChrome,
  clearOverlayIconBounds,
  overlayCancelBounds,
  overlayFilterDropdownBounds,
  overlayHeaderFilterBounds,
  overlayIconBounds,
  ICON_HIT_PADDING,
  type PivotCellChromeDeps,
} from "../pivotCellChrome";

/** The grid canvas sits at client (10, 20). */
const canvas = { getBoundingClientRect: () => ({ left: 10, top: 20 }) } as unknown as HTMLCanvasElement;
const deps: PivotCellChromeDeps = {
  canvas: () => canvas,
  regionOrigin: (pivotId) => (pivotId === "p1" ? { startRow: 3, startCol: 1 } : { startRow: 40, startCol: 0 }),
};

/** Paint: two +/- icons and one in another pivot, a report filter, a Row Labels button. */
function paint(opts: { cancel?: boolean } = {}): void {
  clearOverlayIconBounds();
  overlayIconBounds.set("p1-7-1", { x: 100, y: 200, width: 12, height: 12, gridRow: 7, gridCol: 1, isExpanded: true, isRow: true, pivotId: "p1" });
  overlayIconBounds.set("p1-8-1", { x: 100, y: 224, width: 12, height: 12, gridRow: 8, gridCol: 1, isExpanded: false, isRow: true, pivotId: "p1" });
  overlayIconBounds.set("p2-44-0", { x: 400, y: 200, width: 12, height: 12, gridRow: 44, gridCol: 0, isExpanded: true, isRow: true, pivotId: "p2" });
  overlayFilterDropdownBounds.set("p1-2", { x: 300, y: 50, width: 18, height: 18, fieldIndex: 2, pivotId: "p1", gridRow: 0, gridCol: 2 });
  overlayHeaderFilterBounds.set("p1-row", { x: 150, y: 100, width: 16, height: 16, zone: "row", pivotId: "p1" });
  if (opts.cancel) overlayCancelBounds.set("p1", { x: 500, y: 300, width: 60, height: 20 });
}

/** A CLIENT point on a canvas point (+10, +20). */
function client(x: number, y: number): { clientX: number; clientY: number } {
  return { clientX: x + 10, clientY: y + 20 };
}
/** A release point: the cell does not matter to the pivot's chrome, the painted bounds do. */
function point(x: number, y: number): CellPressPoint {
  return { ...client(x, y), row: 0, col: 0 };
}

const ICON_A = { x: 106, y: 206 };
const ICON_B = { x: 106, y: 230 };
const OTHER_PIVOT_ICON = { x: 406, y: 206 };
const FILTER = { x: 309, y: 59 };
const HEADER_FILTER = { x: 158, y: 108 };
const CANCEL = { x: 530, y: 310 };
const OFF = { x: 250, y: 260 };

async function claimAt(p: { x: number; y: number }): Promise<CellClickAnswer> {
  return claimPivotCellChrome(client(p.x, p.y), deps);
}

async function claimOf(p: { x: number; y: number }): Promise<CellReleaseClaim> {
  const answer = await claimAt(p);
  expect(isCellReleaseClaim(answer), "the press on the chrome was not claimed for its release").toBe(true);
  return answer as CellReleaseClaim;
}

/** The faked clock: every test starts 10 s after the last one began. */
let clock = 1_000_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  clock += 10_000;
  vi.setSystemTime(clock);
  vi.clearAllMocks();
  api.getPivotViewCell.mockImplementation(() => ({ formattedValue: "North" }));
  api.findPivotReportFilterZone.mockImplementation(async () => ({ fieldIndex: 2, fieldName: "Region", row: 0, col: 1 }));
  paint();
});

afterEach(() => {
  vi.useRealTimers();
});

/** A click on the chrome at `p` `ms` after the test's start: its press is claimed, its release runs there. */
async function clickAfter(ms: number, p: { x: number; y: number }): Promise<void> {
  vi.setSystemTime(clock + ms);
  const claim = await claimOf(p);
  vi.setSystemTime(clock + ms + 40);
  await claim.runAtRelease(point(p.x, p.y));
}

describe("a +/- is claimed at the press and toggles at the release", () => {
  it("the press is claimed and toggles NOTHING", async () => {
    await claimOf(ICON_A);
    expect(api.togglePivotHeaderAt, "the +/- toggled on the PRESS").not.toHaveBeenCalled();
  });

  it("its target is that +/- (its 4 px padding included); another +/-, another pivot's and a point off the chrome are not", async () => {
    const claim = await claimOf(ICON_A);
    expect(claim.targetAt(point(ICON_A.x + 7 + ICON_HIT_PADDING - 1, ICON_A.y))).toBe(claim.key);
    expect(claim.targetAt(point(ICON_B.x, ICON_B.y)), "a release on ANOTHER +/- counts as this one").not.toBe(claim.key);
    expect(claim.targetAt(point(OTHER_PIVOT_ICON.x, OTHER_PIVOT_ICON.y))).not.toBe(claim.key);
    expect(claim.targetAt(point(OFF.x, OFF.y))).toBeNull();
  });

  it("the release toggles the VIEW cell the press named, once", async () => {
    const claim = await claimOf(ICON_A);
    await claim.runAtRelease(point(ICON_A.x, ICON_A.y));
    expect(api.togglePivotHeaderAt).toHaveBeenCalledTimes(1);
    // gridRow 7 - startRow 3, gridCol 1 - startCol 1
    expect(api.togglePivotHeaderAt).toHaveBeenCalledWith("p1", 4, 0, true);
  });

  it("a +/- whose cell is not in the cached view is NOT claimed (Core selects the cell, as before)", async () => {
    api.getPivotViewCell.mockImplementation(() => null);
    expect(await claimAt(ICON_A)).toBe(false);
  });
});

describe("a report filter combo opens at the release", () => {
  it("claimed at the press, nothing opened; its release opens THAT field's menu at the RELEASE point", async () => {
    const claim = await claimOf(FILTER);
    expect(api.openPivotReportFilterZone, "the filter opened on the PRESS").not.toHaveBeenCalled();
    expect(api.findPivotReportFilterZone).toHaveBeenCalledWith(0, 2, 2);
    expect(claim.targetAt(point(FILTER.x + 3, FILTER.y - 2))).toBe(claim.key);
    expect(claim.targetAt(point(OFF.x, OFF.y))).toBeNull();
    await claim.runAtRelease(point(FILTER.x + 3, FILTER.y - 2));
    expect(api.openPivotReportFilterZone).toHaveBeenCalledTimes(1);
    expect(api.openPivotReportFilterZone).toHaveBeenCalledWith(
      { fieldIndex: 2, fieldName: "Region", row: 0, col: 1 },
      FILTER.x + 3 + 10,
      FILTER.y - 2 + 20,
    );
  });

  it("a report filter the backend no longer knows is NOT claimed", async () => {
    api.findPivotReportFilterZone.mockImplementation(async () => null);
    expect(await claimAt(FILTER)).toBe(false);
  });
});

describe("a Row/Column Labels filter button opens at the release", () => {
  it("claimed at the press, nothing opened; its release opens that zone's menu at the release point", async () => {
    const claim = await claimOf(HEADER_FILTER);
    expect(api.openPivotHeaderFilter).not.toHaveBeenCalled();
    expect(claim.targetAt(point(HEADER_FILTER.x, HEADER_FILTER.y))).toBe(claim.key);
    expect(claim.targetAt(point(ICON_A.x, ICON_A.y))).not.toBe(claim.key);
    await claim.runAtRelease(point(HEADER_FILTER.x + 1, HEADER_FILTER.y + 1));
    expect(api.openPivotHeaderFilter).toHaveBeenCalledWith("p1", "row", HEADER_FILTER.x + 1 + 10, HEADER_FILTER.y + 1 + 20 + 2);
  });
});

describe("the loading indicator's Cancel cancels at the release", () => {
  it("claimed at the press, nothing cancelled; its release cancels THAT pivot once", async () => {
    paint({ cancel: true });
    const claim = await claimOf(CANCEL);
    expect(api.cancelPivotLoading, "Cancel acted on the PRESS").not.toHaveBeenCalled();
    expect(overlayCancelBounds.has("p1")).toBe(true);
    await claim.runAtRelease(point(CANCEL.x, CANCEL.y));
    expect(api.cancelPivotLoading).toHaveBeenCalledTimes(1);
    expect(api.cancelPivotLoading).toHaveBeenCalledWith("p1");
    expect(overlayCancelBounds.has("p1")).toBe(false);
  });

  it("loading finished while the press was held (no Cancel painted any more): the release is off the target", async () => {
    paint({ cancel: true });
    const claim = await claimOf(CANCEL);
    paint();
    expect(claim.targetAt(point(CANCEL.x, CANCEL.y))).toBeNull();
  });
});

describe("a press on no chrome, or with no canvas, is not the pivot's", () => {
  it("off the chrome: false", async () => {
    expect(await claimAt(OFF)).toBe(false);
  });

  it("before the first paint (no canvas): false", async () => {
    expect(await claimPivotCellChrome(client(ICON_A.x, ICON_A.y), { ...deps, canvas: () => null })).toBe(false);
  });
});

describe("a double-click on worksheet chrome acts ONCE: the canvas box's 450 ms guard", () => {
  it("the two clicks of a double-click on a +/- toggle it once; a click past the window toggles again", async () => {
    await clickAfter(0, ICON_A);
    await clickAfter(200, ICON_A);
    expect(api.togglePivotHeaderAt, "a double-click on the +/- toggled it twice (back to where it was)").toHaveBeenCalledTimes(1);
    await clickAfter(200 + 600, ICON_A);
    expect(api.togglePivotHeaderAt, "a click after the double-click window was dropped too").toHaveBeenCalledTimes(2);
  });

  it("the window is measured between RELEASES that acted: a repeat just inside 450 ms is dropped, one at 450 ms acts", async () => {
    await clickAfter(0, ICON_A);
    await clickAfter(449, ICON_A);
    expect(api.togglePivotHeaderAt).toHaveBeenCalledTimes(1);
    await clickAfter(450, ICON_A);
    expect(api.togglePivotHeaderAt).toHaveBeenCalledTimes(2);
  });

  it("the guard is per piece of chrome: a click on ANOTHER +/- inside the window acts", async () => {
    await clickAfter(0, ICON_A);
    await clickAfter(100, ICON_B);
    expect(api.togglePivotHeaderAt).toHaveBeenCalledTimes(2);
    expect(api.togglePivotHeaderAt).toHaveBeenNthCalledWith(2, "p1", 5, 0, true);
  });

  it("a double-click on a report filter combo or a Row Labels button opens its menu once", async () => {
    await clickAfter(0, FILTER);
    await clickAfter(150, FILTER);
    expect(api.openPivotReportFilterZone).toHaveBeenCalledTimes(1);
    await clickAfter(5_000, HEADER_FILTER);
    await clickAfter(5_150, HEADER_FILTER);
    expect(api.openPivotHeaderFilter).toHaveBeenCalledTimes(1);
  });

  it("the loading Cancel is not guarded, as on the canvas box: both clicks cancel", async () => {
    paint({ cancel: true });
    await clickAfter(0, CANCEL);
    paint({ cancel: true });
    await clickAfter(150, CANCEL);
    expect(api.cancelPivotLoading).toHaveBeenCalledTimes(2);
  });

  it("ONE guard for both surfaces: the worksheet chrome and the canvas box ask the same module, and no copy of it is left", () => {
    const lib = path.resolve(__dirname, "..");
    const strip = (file: string) =>
      fs
        .readFileSync(path.join(lib, file), "utf8")
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
    const guard = strip("pivotChromeRepeat.ts");
    expect(guard).toMatch(/export const REPEAT_PRESS_MS = 450;/);
    for (const surface of ["pivotCellChrome.ts", "pivotVisualOverlay.ts"]) {
      const text = strip(surface);
      expect(text, `${surface} does not ask the shared double-click guard`).toMatch(
        /import \{[^}]*\bchromeReleaseActs\b[^}]*\} from "\.\/pivotChromeRepeat";/,
      );
      expect(text, `${surface} keeps a double-click window of its own`).not.toMatch(/\b450\b|REPEAT_PRESS_MS\s*=|lastPress\s*[:=]/);
    }
  });
});

describe("the extension's wiring: ONE release-time interceptor, no press-time chrome action", () => {
  const index = fs
    .readFileSync(path.resolve(__dirname, "../../index.ts"), "utf8")
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  it("registers exactly one cell click interceptor, and it asks claimPivotCellChrome", () => {
    expect(index.split("cellClicks.registerClickInterceptor(").length - 1).toBe(1);
    const at = index.indexOf("cellClicks.registerClickInterceptor(");
    expect(index.slice(at, at + 400)).toContain("claimPivotCellChrome(");
  });

  it("no longer runs a chrome action itself (they run only at a release, from the claim)", () => {
    for (const action of ["togglePivotHeaderAt(", "openPivotReportFilterAt(", "openPivotHeaderFilter(", "cancelPivotLoading("]) {
      expect(index.includes(action), `Pivot/index.ts still calls ${action}`).toBe(false);
    }
  });
});
