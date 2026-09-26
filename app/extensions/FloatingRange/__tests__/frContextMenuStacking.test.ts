//! FILENAME: app/extensions/FloatingRange/__tests__/frContextMenuStacking.test.ts
// PURPOSE: The floating range's right-click menu asks Core's ONE stacking
//          order (M8) before it claims a point: another object painted over
//          the frame owns that right-click, and a range on top is THE range.
// CONTEXT: Read as SOURCE, the chartsExtensionWiring precedent: the handler
//          lives in activate(), whose import is a harness, and the defect is a
//          line that is NOT there -- `frameAtCanvasPoint` walks only floating
//          ranges, so without the question a range hidden under a chart opened
//          its menu through the chart. The behaviour of the question itself
//          (`topFloatingRegionAt`) is proved in src/api/__tests__/
//          gridOverlaysStacking.test.ts.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

function contextMenuBody(): string {
  const source = readFileSync(path.resolve(__dirname, "../index.ts"), "utf8");
  const start = source.indexOf("const handleFrContextMenu = (e: MouseEvent) => {");
  const end = source.indexOf('window.addEventListener("contextmenu", handleFrContextMenu, true);', start);
  expect(start, "handleFrContextMenu was not found -- this guard reads nothing").toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("the floating range menu refuses a point another object covers", () => {
  it("asks for the topmost region BEFORE its own frame lookup and before claiming the event", () => {
    const body = contextMenuBody();
    const ask = body.indexOf("topFloatingRegionAt(point.x, point.y)");
    const refuse = body.indexOf("if (top && top.type !== FLOATING_RANGE_REGION_TYPE) return;");
    expect(ask, "the menu never asks what is on top").toBeGreaterThan(-1);
    expect(refuse, "another object on top is not refused").toBeGreaterThan(ask);
    expect(refuse).toBeLessThan(body.indexOf("frameAtCanvasPoint("));
    expect(refuse).toBeLessThan(body.indexOf("e.preventDefault()"));
  });

  it("a range on top is THE range (the stacking order, not the store's order)", () => {
    const body = contextMenuBody();
    expect(body).toContain("const topId = top ? frIdOf(top) : null;");
    expect(body).toContain("(topId ? getFloatingRangeById(topId) : null) ?? frameAtCanvasPoint(point.x, point.y)");
  });
});
