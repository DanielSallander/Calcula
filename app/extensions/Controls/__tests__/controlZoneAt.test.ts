//! FILENAME: app/extensions/Controls/__tests__/controlZoneAt.test.ts
// PURPOSE: The floating control's ONE zone answer (lib/controlZoneAt.ts,
//          BUG-0258 design phases 2 and 4c), through Core's rule
//          (`resolveFloatingZone`): a RUN-MODE button is CONTENT with a hand
//          and part 'button' -- its press is the button's, run at the release
//          inside it (lib/buttonPress.ts) -- on every surface, locked and
//          subscribed included; everything else is whole-body frame.
// CONTEXT: A run-mode button is published `movable: false`. As FRAME (phase 2)
//          its press selected it and `floatingObject:selected` RAN it on the
//          press; as content Core hands the press to `bodyDragStart` and never
//          moves the button. The registration lives in index.ts, whose one line
//          is pinned by reading the source (the Charts wiring tests' precedent).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  registerGridOverlay,
  resolveFloatingZone,
  type GridRegion,
  type OverlayHitTestContext,
} from "@api/gridOverlays";
import { registerLayoutSurfaceProvider, type LayoutSurface } from "@api/layoutSurface";
import { floatingControlZoneAt } from "../lib/controlZoneAt";

/** A control's region exactly as floatingStore.syncFloatingControlRegions publishes it. */
function control(controlType: string, designMode: boolean): OverlayHitTestContext {
  const movable = designMode || controlType === "shape" || controlType === "image";
  const region: GridRegion = {
    id: `ctl-${controlType}`,
    type: "floating-control",
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x: 100, y: 50, width: 120, height: 40 },
    data: { sheetIndex: 0, row: 2, col: 1, controlType, movable, resizable: movable },
  };
  return { region, canvasX: 150, canvasY: 70, row: 0, col: 0, floatingCanvasBounds: { x: 100, y: 50, width: 120, height: 40 } };
}

let cleanups: Array<() => void> = [];

function useSurface(s: Partial<LayoutSurface>): void {
  const surface: LayoutSurface = {
    snapToGrid: false,
    gridSize: 25,
    showGrid: false,
    page: { width: 1280, height: 720 },
    editable: true,
    ...s,
  };
  cleanups.push(registerLayoutSurfaceProvider({ get: () => surface }));
}

beforeEach(() => {
  cleanups.push(registerGridOverlay({ type: "floating-control", render: () => {}, zoneAt: floatingControlZoneAt }));
});

afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups = [];
});

describe("the floating control's zone, through Core's rule", () => {
  it("a RUN-MODE button is CONTENT: a hand, part 'button', and it cannot move", () => {
    expect(floatingControlZoneAt(control("button", false))).toEqual({ kind: "content", cursor: "pointer", part: "button" });
    expect(resolveFloatingZone(control("button", false))).toEqual({
      kind: "content",
      part: "button",
      cursor: "pointer",
      canMove: false,
    });
  });

  it("a run-mode button stays CONTENT on a LOCKED canvas and on a SUBSCRIBED page (running a report's button is not editing it)", () => {
    useSurface({ isLocked: () => true });
    expect(resolveFloatingZone(control("button", false))).toMatchObject({ kind: "content", part: "button", cursor: "pointer" });
    cleanups.pop()?.();
    useSurface({ editable: false });
    expect(resolveFloatingZone(control("button", false))).toMatchObject({ kind: "content", part: "button", cursor: "pointer" });
  });

  it("a DESIGN-MODE button is plain frame: 'move' (moving a button still needs Design Mode)", () => {
    expect(floatingControlZoneAt(control("button", true))).toBeNull();
    expect(resolveFloatingZone(control("button", true))).toEqual({ kind: "frame", part: null, cursor: "move", canMove: true });
  });

  it("a shape and a picture are frame: they move by their body ('move'), and on a LOCKED canvas show 'default'", () => {
    for (const type of ["shape", "image"]) {
      for (const design of [false, true]) {
        expect(floatingControlZoneAt(control(type, design)), `${type} design=${design}`).toBeNull();
      }
    }
    expect(resolveFloatingZone(control("shape", false))).toMatchObject({ kind: "frame", cursor: "move", canMove: true });
    expect(resolveFloatingZone(control("image", false))).toMatchObject({ kind: "frame", cursor: "move", canMove: true });
    useSurface({ isLocked: () => true });
    expect(resolveFloatingZone(control("shape", false))).toMatchObject({ kind: "frame", cursor: "default", canMove: false });
  });
});

describe("index.ts registers it as the floating control's zoneAt", () => {
  const src = readFileSync(resolve(__dirname, "../index.ts"), "utf8").replace(/\/\/.*$/gm, "");
  const at = src.indexOf('type: "floating-control"');
  const block = src.slice(src.lastIndexOf("register({", at), src.indexOf("});", at));

  it("zoneAt: floatingControlZoneAt, with no getCursor or claimsBodyDrag beside it", () => {
    expect(at, "the floating-control registration is gone").toBeGreaterThan(0);
    expect(block).toMatch(/zoneAt\s*:\s*floatingControlZoneAt\b/);
    expect(block).not.toMatch(/getCursor\s*:/);
    expect(block).not.toMatch(/claimsBodyDrag\s*:/);
  });
});
