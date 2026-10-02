//! FILENAME: app/extensions/TimelineSlicer/__tests__/timelineNoPhantomDrag.test.ts
// PURPOSE: No timeline range can grow, or be committed, without a held button.
//          Found live 2026-09-29 (e2e fixall-pivot WF-D3): the period click
//          completed on MOUSEUP, and it armed a "range drag" right there with
//          no button held -- hovering afterwards grew the selection into a
//          range, and the next mouseup anywhere (a click on a cell) committed
//          it, re-applying a period the user had just undone.
//
//          BUG-0258 brought a REAL range drag back, in lib/timelineRangeDrag.ts
//          (Core hands it the press on the month tiles). So this scan covers
//          that module too, and it asserts the module HAS a mousemove listener
//          to check -- a scan that finds nothing to check passes vacuously,
//          which is how the old version would have greeted the new module.
//          Source-level, because what must never come back is a SHAPE: a
//          window mousemove that follows the pointer without looking at
//          `buttons`, a commit made while the pointer moves, a window
//          listener that outlives the gesture. The behaviour is pinned by
//          lib/__tests__/timelineRangeDrag.test.ts.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const INDEX = path.resolve(__dirname, "../index.ts");
const DRAG = path.resolve(__dirname, "../lib/timelineRangeDrag.ts");
/** The commit rule the drag and the keyboard share (M8 S8 moved it out of the drag, unchanged). */
const COMMIT = path.resolve(__dirname, "../lib/timelineCommit.ts");

/** A file's text with line comments removed. */
function code(file: string): string {
  return fs.readFileSync(file, "utf8").replace(/\/\/.*$/gm, "");
}

/**
 * The brace-matched body of `function name(` or `const name = (...) => {` in
 * `src`, or "" when there is none.
 */
function body(src: string, name: string): string {
  let at = src.indexOf(`function ${name}(`);
  let open = -1;
  if (at >= 0) {
    open = src.indexOf("{", src.indexOf(")", at));
  } else {
    at = src.indexOf(`const ${name} = (`);
    if (at < 0) return "";
    open = src.indexOf("=> {", at);
    if (open < 0) return "";
    open += 3;
  }
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
 * `fn` plus the bodies of every function it calls that is DEFINED in `src`,
 * followed to `depth` levels. A mouseup that commits through a helper
 * (`handleTimelineClickAt` -> `handlePeriodClick` -> the store) was the old
 * shape; a scan of the handler's own text alone could not see it.
 */
function reach(src: string, fn: string, depth = 4, seen = new Set<string>()): string {
  if (depth === 0) return fn;
  let out = fn;
  for (const [, name] of fn.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
    if (seen.has(name)) continue;
    seen.add(name);
    const callee = body(src, name);
    if (callee !== "" && callee !== fn) out += "\n" + reach(src, callee, depth - 1, seen);
  }
  return out;
}

/** The handler names bound as window `event` listeners in `src`. */
function windowListeners(src: string, event: string): string[] {
  const re = new RegExp(`window\\.addEventListener\\(\\s*"${event}",\\s*(\\w+)`, "g");
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) names.push(m[1]);
  return names;
}

describe("the timeline's range drag (lib/timelineRangeDrag.ts)", () => {
  const src = code(DRAG);

  it("has a window mousemove listener to check -- the scan below is not vacuous", () => {
    expect(windowListeners(src, "mousemove").length).toBeGreaterThan(0);
  });

  it("every window mousemove listener checks the held button before anything else", () => {
    for (const handler of windowListeners(src, "mousemove")) {
      const fn = body(src, handler);
      expect(fn, `the mousemove handler '${handler}' was not found`).not.toBe("");
      expect(fn, `the mousemove handler '${handler}' follows the pointer with no button check`).toMatch(
        /\(\s*e\.buttons\s*&\s*1\s*\)\s*===\s*0/,
      );
    }
  });

  it("nothing on the move path commits: the range is committed only by the release", () => {
    // Directly, or through the functions that do it for the release -- and
    // the move path may END the gesture only as a cancel (`endSession(null)`).
    const movePath = ["onSessionMove", "trackRange", "followPointer", "syncAutoScroll", "trackScroll"];
    for (const name of movePath) {
      const fn = body(src, name);
      expect(fn, `${name} is gone`).not.toBe("");
      expect(fn, `${name} writes the timeline while the pointer moves`).not.toMatch(
        /updateTimelineSelectionAsync\(|updateTimelineAsync\(|commitRange\(|commitTimelineSpan\(|releaseButton\(/,
      );
      for (const call of fn.match(/endSession\([^)]*\)/g) ?? []) {
        expect(call, `${name} ends the gesture as a RELEASE while the pointer moves`).toBe("endSession(null)");
      }
    }
    // The positive half: the release is where the one commit happens -- through
    // the commit rule the keyboard shares (lib/timelineCommit.ts, M8 S8), which
    // is where the one backend write now sits.
    expect(body(src, "commitRange")).toContain("commitTimelineSpan(");
    expect(body(code(COMMIT), "commitTimelineSpan")).toContain("updateTimelineSelectionAsync(");
    expect(body(src, "endSession")).toContain("commitRange(");
    expect(body(src, "onSessionUp")).toContain("endSession(");
  });

  it("binds its window listeners only when a gesture begins, and every one is removed", () => {
    const begin = body(src, "beginTimelineContentPress");
    const adds = src.match(/window\.addEventListener\(/g) ?? [];
    const addsInBegin = begin.match(/window\.addEventListener\(/g) ?? [];
    expect(adds.length, "no listeners at all: the gesture cannot track the pointer").toBeGreaterThan(0);
    expect(addsInBegin.length, "a window listener is bound outside the gesture's start").toBe(adds.length);
    for (const event of ["mousemove", "mouseup", "keydown", "blur"]) {
      const handler = windowListeners(src, event)[0];
      expect(handler, `no window ${event} listener`).toBeTruthy();
      expect(src, `the ${event} listener is never removed`).toMatch(
        new RegExp(`window\\.removeEventListener\\(\\s*"${event}",\\s*${handler}`),
      );
    }
  });
});

describe("the timeline's frame click (index.ts)", () => {
  const src = code(INDEX);

  it("no window mousemove grows a selection without a held button", () => {
    for (const handler of windowListeners(src, "mousemove")) {
      const fn = body(src, handler);
      expect(
        !/selectionStart|selectionEnd|isSelected/.test(fn) || /buttons/.test(fn),
        `the mousemove handler '${handler}' changes the selection with no button check`,
      ).toBe(true);
    }
  });

  it("a frame click's mouseup commits nothing and arms nothing -- directly or through a helper", () => {
    const [handler] = windowListeners(src, "mouseup");
    const fn = body(src, handler ?? "");
    expect(fn, "the pending-click mouseup is gone").not.toBe("");
    const reached = reach(src, fn);
    expect(reached).not.toMatch(/updateTimelineSelectionAsync\(|updateTimelineAsync\(|beginTimelineContentPress\(/);
    // A frame click only narrows a kept multi-selection (the press already
    // selected the timeline): nothing is read from where the pointer is.
    expect(reached).not.toMatch(/getTimelineHitDetail\(|timelineZoneAt\w*\(|timelineZoneOf\(/);
  });

  it("the frame-click mouseup lives only from the press that armed it to the next mouseup", () => {
    // The census (core/lib/globalInputListeners.ts) calls this listener
    // SESSION-SCOPED, and that verdict is a claim about its LIFETIME: it is
    // bound by Core's filtered press (floatingObject:selected arms the
    // pending click) and removes itself at the first mouseup after it.
    const [selected] = src.match(/addEventListener\("floatingObject:selected",\s*(\w+)/)?.slice(1) ?? [];
    expect(selected, "no floatingObject:selected handler").toBeTruthy();
    const onPress = body(src, selected);
    const [handler] = windowListeners(src, "mouseup");
    expect(handler, "no window mouseup listener").toBeTruthy();
    const binds = src.match(/window\.addEventListener\(\s*"mouseup"/g) ?? [];
    const bindsOnPress = onPress.match(/window\.addEventListener\(\s*"mouseup"/g) ?? [];
    expect(bindsOnPress.length, "the mouseup is not bound by the press").toBeGreaterThan(0);
    expect(bindsOnPress.length, "a window mouseup is bound outside the press (for the extension's life)").toBe(binds.length);
    expect(body(src, handler), "the mouseup never unbinds itself").toMatch(
      new RegExp(`window\\.removeEventListener\\(\\s*"mouseup",\\s*${handler}\\b`),
    );
  });

  it("no capture mousedown listener: the press's modifiers come from Core's zone-filtered press", () => {
    // A capture mousedown recorded Ctrl for the selected handler BEFORE Core
    // decided whose the modifier was, so a Ctrl or Shift press on the month
    // tiles reached the object selection. Core now carries Ctrl/Shift on
    // `floatingObject:selected` (false on the content) and the raw ones on
    // `floatingObject:bodyDragStart` (design phase 2).
    expect(windowListeners(src, "mousedown")).toEqual([]);
    expect(src).not.toMatch(/addEventListener\(\s*"mousedown"[^)]*,\s*true\s*\)/);
  });

  it("a content press TAKES the pending click, so its release is not also read as a click", () => {
    const [handler] = src.match(/addEventListener\("floatingObject:bodyDragStart",\s*(\w+)/)?.slice(1) ?? [];
    expect(handler, "no bodyDragStart handler: Core's content press reaches nobody").toBeTruthy();
    const fn = body(src, handler);
    const take = fn.indexOf("takePendingTimelineClick(");
    const begin = fn.indexOf("beginTimelineContentPress(");
    expect(take, "the content press leaves the pending click armed").toBeGreaterThan(0);
    expect(begin).toBeGreaterThan(take);
  });
});
