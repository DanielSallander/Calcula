//! FILENAME: app/extensions/Slicer/__tests__/slicerMouseupLifetime.test.ts
// PURPOSE: The Slicer's click-completing window mouseup lives only from the
//          press that arms the pending click to the next mouseup -- the
//          lifetime the census (core/lib/globalInputListeners.ts) claims when
//          it calls the listener "session-scoped". It used to be bound for the
//          extension's whole life while the census said otherwise, which is
//          how a release over the ribbon after a multi-slicer drag could reach
//          it before Core had ended the move (M5 T1 fixed that ordering in
//          Core; this pins the listener's own lifetime, M5 T4).
//
//          Since BUG-0258 design phase 4 the mouseup is FRAME-ONLY: every
//          item, "Select all", clear button and scrollbar press is the content
//          gesture's (lib/slicerItemDrag.ts, which takes the pending click at
//          floatingObject:bodyDragStart), so the frame click reads no point and
//          commits nothing -- it only narrows a kept multi-selection. It used
//          to toggle whatever item sat under the pointer at the release
//          (`handleSlicerClickAt`), so a press on an item could never be a drag.
// CONTEXT: Source-level, the timeline's precedent
//          (TimelineSlicer/__tests__/timelineNoPhantomDrag.test.ts): what must
//          never come back is a SHAPE -- a window mouseup bound outside the
//          press, one that never unbinds itself, or one that reads the point
//          and filters.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const INDEX = path.resolve(__dirname, "../index.ts");

/** A file's text with line comments removed. */
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

/** The brace-matched body of `function name(` in `src`, or "". */
function fnBody(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) return "";
  const open = src.indexOf("{", src.indexOf(")", at));
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

/**
 * `fn` plus the bodies of every function it calls that is DEFINED in `src`
 * (as `const x = (` or `function x(`), followed to `depth` levels: a mouseup
 * that filters through a helper (`handleSlicerClickAt` -> the store) was the
 * old shape, and a scan of the handler's own text alone cannot see it.
 */
function reach(src: string, fn: string, depth = 4, seen = new Set<string>()): string {
  if (depth === 0) return fn;
  let out = fn;
  for (const [, name] of fn.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
    if (seen.has(name)) continue;
    seen.add(name);
    const callee = body(src, name) || fnBody(src, name);
    if (callee !== "" && callee !== fn) out += "\n" + reach(src, callee, depth - 1, seen);
  }
  return out;
}

describe("the Slicer's pending-click mouseup (index.ts)", () => {
  const src = code(INDEX);
  const [selected] = src.match(/addEventListener\("floatingObject:selected",\s*(\w+)/)?.slice(1) ?? [];
  const onPress = body(src, selected ?? "");
  const [handler] = onPress.match(/window\.addEventListener\(\s*"mouseup",\s*(\w+)/)?.slice(1) ?? [];

  it("is bound by the press that arms the pending click (floatingObject:selected)", () => {
    expect(selected, "no floatingObject:selected handler").toBeTruthy();
    expect(onPress, "the press handler is gone").not.toBe("");
    expect(handler, "the press binds no window mouseup: a click would never complete").toBeTruthy();
    expect(onPress.indexOf("armPendingSlicerClick(")).toBeGreaterThan(0);
  });

  it("is bound NOWHERE else -- not for the extension's life", () => {
    const binds = src.match(/window\.addEventListener\(\s*"mouseup"/g) ?? [];
    const bindsOnPress = onPress.match(/window\.addEventListener\(\s*"mouseup"/g) ?? [];
    expect(bindsOnPress.length).toBeGreaterThan(0);
    expect(bindsOnPress.length, "a window mouseup is bound outside the press").toBe(binds.length);
  });

  it("unbinds itself, first thing, at the release", () => {
    const fn = body(src, handler ?? "");
    expect(fn, "the mouseup handler is gone").not.toBe("");
    const first = fn.slice(fn.indexOf("=> {") + 4).trim();
    expect(first.startsWith(`window.removeEventListener("mouseup", ${handler})`), "it does not unbind first").toBe(true);
  });

  it("is still removed at deactivation (a press whose release never came)", () => {
    expect(src).toMatch(new RegExp(`cleanupFunctions\\.push\\(\\(\\) => \\{\\s*window\\.removeEventListener\\("mouseup", ${handler}\\);`));
  });

  it("is FRAME-ONLY: it reads no point and filters nothing -- directly or through a helper", () => {
    const fn = body(src, handler ?? "");
    expect(fn, "the mouseup handler is gone").not.toBe("");
    const reached = reach(src, fn);
    // No commit of any kind: the item, run and clear commits are the content
    // gesture's, at ITS release (lib/slicerItemDrag.ts).
    expect(reached).not.toMatch(
      /clickSlicerItem\(|clickSlicerItemRun\(|clickSlicerClearFilter\(|updateSlicerSelectionAsync\(|beginSlicerContentPress\(/,
    );
    // Nothing is read from where the pointer is: no hit test, no zone.
    expect(reached).not.toMatch(/getSlicerHitDetail\(|slicerZoneAt\(|slicerZoneOfHit\(|clientX|clientY|getBoundingClientRect\(/);
    // What it does do: take the pending click, and narrow a kept multi-selection.
    expect(fn).toContain("takePendingSlicerClick(");
    expect(fn).toMatch(/deferNarrow[\s\S]*selectSlicer\(\s*\w+\.slicerId,\s*false\s*\)/);
  });

  it("the old point-reading click is gone from index.ts", () => {
    expect(src).not.toMatch(/handleSlicerClickAt/);
    expect(src).not.toMatch(/lastMousedownCtrl/);
  });
});
