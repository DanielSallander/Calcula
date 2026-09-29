//! FILENAME: app/extensions/Controls/__tests__/controlPinnedCopy.test.ts
// PURPOSE: A pasted or duplicated copy of a PINNED control stays where it was
//          pasted -- in this session and after a reload -- and follows ITS OWN
//          anchor cell (wave C review of W25).
// CONTEXT: A pinned control paints at anchorOrigin + (offsetX, offsetY) every
//          time rows or columns change size, and a copy gets a NEW anchor.
//          The copy's metadata kept `pinToGrid "true"` and the ORIGINAL's
//          offsets (measured from the original's anchor), and the store entry
//          was created unpinned: in session it did not follow its cells while
//          Properties said it was pinned, and after a reload the first column
//          resize replayed newAnchorOrigin + oldOffset -- the copy JUMPED by
//          the distance between the two anchors. The copy's offsets are now
//          measured from its own anchor with the same cell-origin walk the
//          reposition pass replays, and the store entry is pinned with them.
//          Real controlClipboard, provider, allocator and floating store; the
//          backend and the renderers are doubled; the loader lines of
//          Controls/index.ts are replayed for the reload.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Props = Record<string, { valueType: string; value: string }>;

const h = vi.hoisted(() => ({
  occupied: [] as Array<{ row: number; col: number }>,
  written: [] as Array<{ row: number; col: number; md: { controlType: string; properties: Props } }>,
  source: { controlType: "shape", properties: {} as Props },
}));

vi.mock("@api/notifications", () => ({ showToast: vi.fn() }));
vi.mock("../lib/controlApi", () => ({
  setControlMetadata: async (_s: number, row: number, col: number, md: unknown) => {
    h.written.push({ row, col, md: JSON.parse(JSON.stringify(md)) });
    h.occupied.push({ row, col });
  },
  getControlMetadata: async () => JSON.parse(JSON.stringify(h.source)),
  getAllControls: async () => h.occupied.map((c) => ({ ...c })),
}));
vi.mock("../Button/floatingRenderer", () => ({ invalidateFloatingButtonCache: vi.fn() }));
vi.mock("../Shape/shapeRenderer", () => ({ invalidateShapeCache: vi.fn() }));
vi.mock("../Image/imageRenderer", () => ({ invalidateImageCache: vi.fn() }));

import { registerGridOverlay, setGridRegions } from "@api/gridOverlays";
import { resetObjectSelectionProviders } from "@api/objectSelection";
import { resetObjectClipboard } from "@api/objectClipboard";
import { registerControlObjectSelection } from "../lib/controlObjectSelection";
import {
  copyControls,
  duplicateControls,
  pasteControl,
  pasteControlSnapshots,
  setControlCopyCellOrigin,
  snapshotControls,
} from "../lib/controlClipboard";
import {
  addFloatingControl,
  getFloatingControl,
  makeFloatingControlId,
  repositionPinnedControls,
  resetFloatingStore,
  syncFloatingControlRegions,
} from "../lib/floatingStore";

/** Column 0 is `firstColWidth` wide, every other column 64; rows are 20. */
let firstColWidth = 64;
const cellOrigin = (row: number, col: number) => ({
  x: col === 0 ? 0 : firstColWidth + (col - 1) * 64,
  y: row * 20,
});

const s = (value: string) => ({ valueType: "static", value });
const ORIG = makeFloatingControlId(0, 0, 0);

/** The original: anchor (0,0), 100 px right of / 50 px below its origin. */
function addOriginal(pinned: boolean): void {
  h.source = {
    controlType: "shape",
    properties: pinned
      ? { x: s("100"), y: s("50"), pinToGrid: s("true"), offsetX: s("100"), offsetY: s("50") }
      : { x: s("100"), y: s("50") },
  };
  addFloatingControl({
    id: ORIG,
    sheetIndex: 0,
    row: 0,
    col: 0,
    x: 100,
    y: 50,
    width: 80,
    height: 40,
    controlType: "shape",
    ...(pinned ? { pinToGrid: true, offsetX: 100, offsetY: 50 } : {}),
  });
  h.occupied.push({ row: 0, col: 0 });
  syncFloatingControlRegions();
}

/** Controls/index.ts's loader, replayed: pin + offsets come from the metadata. */
function reload(w: { row: number; col: number; md: { properties: Props } }): string {
  const props = w.md.properties;
  resetFloatingStore();
  const offsetX = props.offsetX ? parseFloat(props.offsetX.value) : undefined;
  const offsetY = props.offsetY ? parseFloat(props.offsetY.value) : undefined;
  const id = makeFloatingControlId(0, w.row, w.col);
  addFloatingControl({
    id,
    sheetIndex: 0,
    row: w.row,
    col: w.col,
    pinToGrid: props.pinToGrid?.value === "true",
    offsetX: Number.isFinite(offsetX) ? offsetX : undefined,
    offsetY: Number.isFinite(offsetY) ? offsetY : undefined,
    x: parseFloat(props.x.value),
    y: parseFloat(props.y.value),
    width: 80,
    height: 40,
    controlType: "shape",
  });
  return id;
}

beforeEach(() => {
  h.occupied = [];
  h.written.length = 0;
  firstColWidth = 64;
  resetFloatingStore();
  resetObjectClipboard();
  resetObjectSelectionProviders();
  setGridRegions([]);
  registerGridOverlay({ type: "floating-control", render: () => {}, priority: 20 });
  registerControlObjectSelection({ copyControls: snapshotControls, pasteControls: pasteControlSnapshots });
  setControlCopyCellOrigin(cellOrigin);
});

afterEach(() => {
  setControlCopyCellOrigin(null);
});

describe("a pasted / duplicated copy of a PINNED control", () => {
  it("writes offsets measured from ITS OWN anchor, so a reload + resize leaves it where it was pasted", async () => {
    addOriginal(true);
    await copyControls([ORIG]);
    await pasteControl(0);
    expect(h.written.length, "nothing was pasted").toBe(1);
    const w = h.written[0];
    expect(`${w.row}:${w.col}`).toBe("0:1");
    // Pasted 20 px from the original: (120, 70); its anchor (0,1) starts at x 64.
    expect(w.md.properties.x.value).toBe("120");
    expect(w.md.properties.pinToGrid?.value).toBe("true");
    expect(w.md.properties.offsetX?.value, "the ORIGINAL's offset was copied verbatim").toBe("56");
    expect(w.md.properties.offsetY?.value).toBe("70");

    const id = reload(w);
    repositionPinnedControls(0, cellOrigin);
    expect(
      getFloatingControl(id)!.x,
      "the pasted pinned shape JUMPED on the first resize after reload (old anchor's offset replayed from the new anchor)",
    ).toBe(120);
  });

  it("is pinned in THIS session too, and follows its own anchor when a column before it widens", async () => {
    addOriginal(true);
    await copyControls([ORIG]);
    await pasteControl(0);
    const copy = getFloatingControl(makeFloatingControlId(0, 0, 1))!;
    expect(copy.pinToGrid, "the store entry of a pinned copy is unpinned (Properties says pinned)").toBe(true);
    expect([copy.offsetX, copy.offsetY]).toEqual([56, 70]);
    repositionPinnedControls(0, cellOrigin);
    expect(copy.x, "a reposition with no geometry change moved the copy").toBe(120);
    firstColWidth = 74;
    repositionPinnedControls(0, cellOrigin);
    expect(copy.x, "the pinned copy did not follow its anchor cell").toBe(130);
  });

  it("Duplicate takes the same path", async () => {
    addOriginal(true);
    await duplicateControls([ORIG]);
    const w = h.written[0];
    expect([w.md.properties.offsetX?.value, w.md.properties.offsetY?.value]).toEqual(["56", "70"]);
    expect(getFloatingControl(makeFloatingControlId(0, w.row, w.col))!.pinToGrid).toBe(true);
  });

  it("with no cell-origin walk installed, the copy is written UNPINNED at the pixels it was pasted at", async () => {
    setControlCopyCellOrigin(null);
    addOriginal(true);
    await copyControls([ORIG]);
    await pasteControl(0);
    const props = h.written[0].md.properties;
    expect(props.pinToGrid?.value, "a copy with nothing to measure against kept a pin measured from another cell").toBe(
      "false",
    );
    expect(props.offsetX).toBeUndefined();
    expect(props.offsetY).toBeUndefined();
    expect(getFloatingControl(makeFloatingControlId(0, 0, 1))!.pinToGrid).not.toBe(true);
  });

  it("control: an UNPINNED control's copy gets no pin and no offsets", async () => {
    addOriginal(false);
    await copyControls([ORIG]);
    await pasteControl(0);
    const props = h.written[0].md.properties;
    expect(props.pinToGrid).toBeUndefined();
    expect(props.offsetX).toBeUndefined();
    expect(getFloatingControl(makeFloatingControlId(0, 0, 1))!.pinToGrid).not.toBe(true);
  });
});
