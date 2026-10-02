//! FILENAME: app/extensions/Charts/__tests__/chartMouseupLifetime.test.ts
// PURPOSE: The chart's click- and brush-completing window mouseup lives only
//          from a chart press (the pending sub-selection click armed at
//          `floatingObject:selected`, or the interval brush started at
//          `floatingObject:bodyDragStart`) to the next mouseup -- the lifetime
//          the census (core/lib/globalInputListeners.ts) claims when it calls
//          the listener "session-scoped". It used to be bound for the
//          extension's whole life while the census said otherwise (M5 T4).
// CONTEXT: Source-level, the timeline's precedent
//          (TimelineSlicer/__tests__/timelineNoPhantomDrag.test.ts), because
//          activating Charts in a unit test is a harness, not a guard
//          (chartsCanvasWiring.test.ts). What must never come back is a SHAPE:
//          a window mouseup bound outside a chart press, or one that never
//          unbinds itself.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const INDEX = path.resolve(__dirname, "../index.ts");

/** A file's text with line comments removed (CRLF kept; the regexes allow \r). */
function code(file: string): string {
  return fs.readFileSync(file, "utf8").replace(/\/\/.*$/gm, "");
}

/** The brace-matched body of `const name = (...) => {` in `src`, or "". */
function body(src: string, name: string): string {
  const at = src.indexOf(`const ${name} = (`);
  if (at < 0) return "";
  let open = src.indexOf("=> {", at);
  if (open < 0) return "";
  open += 3;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return src.slice(at);
}

function handlerOf(src: string, event: string): string {
  return src.match(new RegExp(`addEventListener\\("${event}",\\s*(\\w+)`))?.slice(1)[0] ?? "";
}

describe("the chart's pending-click / brush mouseup (index.ts)", () => {
  const src = code(INDEX);
  const onSelected = body(src, handlerOf(src, "floatingObject:selected"));
  const onBodyDrag = body(src, handlerOf(src, "floatingObject:bodyDragStart"));
  const [handler] = onSelected.match(/window\.addEventListener\(\s*"mouseup",\s*(\w+)/)?.slice(1) ?? [];

  it("is bound by the chart press (selected) AND by the brush's content press (bodyDragStart)", () => {
    expect(onSelected, "the selected handler is gone").not.toBe("");
    expect(onBodyDrag, "the bodyDragStart handler is gone").not.toBe("");
    expect(handler, "a chart press binds no window mouseup: a click would never complete").toBeTruthy();
    expect(onBodyDrag, "a brush would never finalize").toMatch(
      new RegExp(`window\\.addEventListener\\(\\s*"mouseup",\\s*${handler}\\)`),
    );
    // The selected handler binds it only for a CHART press.
    expect(onSelected.indexOf('window.addEventListener("mouseup"')).toBeGreaterThan(
      onSelected.indexOf('if (detail.regionType !== "chart") return;'),
    );
  });

  it("is bound NOWHERE else -- not for the extension's life", () => {
    const binds = src.match(/window\.addEventListener\(\s*"mouseup"/g) ?? [];
    const onPress =
      (onSelected.match(/window\.addEventListener\(\s*"mouseup"/g) ?? []).length +
      (onBodyDrag.match(/window\.addEventListener\(\s*"mouseup"/g) ?? []).length;
    expect(onPress).toBe(2);
    expect(onPress, "a window mouseup is bound outside a chart press").toBe(binds.length);
  });

  it("unbinds itself, first thing, at the release", () => {
    const fn = body(src, handler ?? "");
    expect(fn, "the mouseup handler is gone").not.toBe("");
    const first = fn.slice(fn.indexOf("=> {") + 4).trim();
    expect(first.startsWith(`window.removeEventListener("mouseup", ${handler})`), "it does not unbind first").toBe(true);
  });

  it("is still removed at deactivation (a press whose release never came)", () => {
    expect(src).toMatch(
      new RegExp(`cleanupFunctions\\.push\\(\\(\\) => \\{\\s*window\\.removeEventListener\\("mouseup", ${handler}\\);`),
    );
  });
});
