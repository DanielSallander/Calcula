//! FILENAME: app/extensions/Slicer/__tests__/slicerNoPhantomDrag.test.ts
// PURPOSE: No slicer run can grow, or be committed, without a held button --
//          the timeline's phantom drag (found live 2026-09-29, e2e fixall-pivot
//          WF-D3: a "range drag" armed at a mouseup followed the bare pointer
//          and the next click anywhere committed it) must not come back in the
//          slicer's content gesture (lib/slicerItemDrag.ts, BUG-0258 design
//          phase 4), which follows the pointer across the items.
//
//          Source-level, because what must never come back is a SHAPE: a window
//          mousemove that follows the pointer without looking at `buttons`, a
//          commit made while the pointer moves, a window listener that outlives
//          the gesture, a capture mousedown that reads the press's Ctrl before
//          Core decided whose it is. The scan asserts there IS a mousemove
//          listener to check -- a scan that finds nothing passes vacuously. The
//          behaviour is pinned by lib/__tests__/slicerItemDrag.test.ts; this is
//          the timeline's scan (TimelineSlicer/__tests__/timelineNoPhantomDrag.test.ts).

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const INDEX = path.resolve(__dirname, "../index.ts");
const DRAG = path.resolve(__dirname, "../lib/slicerItemDrag.ts");

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

/** The handler names bound as window `event` listeners in `src`. */
function windowListeners(src: string, event: string): string[] {
  const re = new RegExp(`window\\.addEventListener\\(\\s*"${event}",\\s*(\\w+)`, "g");
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) names.push(m[1]);
  return names;
}

/** What a COMMIT looks like in slicerItemDrag.ts: the store's three queued clicks, or the helpers that make them. */
const COMMIT = /clickSlicerItem\(|clickSlicerItemRun\(|clickSlicerClearFilter\(|updateSlicerSelectionAsync\(|commitItems\(|releaseButton\(/;

describe("the slicer's content gesture (lib/slicerItemDrag.ts)", () => {
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
      // The check comes BEFORE the handler reads the pointer.
      const check = fn.search(/\(\s*e\.buttons\s*&\s*1\s*\)/);
      const read = fn.search(/pointerAt\(|trackItems\(|trackScroll\(/);
      expect(read, `the mousemove handler '${handler}' never follows the pointer`).toBeGreaterThan(0);
      expect(check, `the mousemove handler '${handler}' reads the pointer before it checks the button`).toBeLessThan(read);
    }
  });

  it("nothing on the move path commits: the one commit is the release's", () => {
    // Directly, or through the functions that do it for the release -- and
    // the move path may END the gesture only as a cancel (`endSession(null)`).
    const movePath = ["onSessionMove", "trackItems", "followPointer", "showRun", "syncAutoScroll", "trackScroll"];
    for (const name of movePath) {
      const fn = body(src, name);
      expect(fn, `${name} is gone`).not.toBe("");
      expect(fn, `${name} writes the slicer while the pointer moves`).not.toMatch(COMMIT);
      for (const call of fn.match(/endSession\([^)]*\)/g) ?? []) {
        expect(call, `${name} ends the gesture as a RELEASE while the pointer moves`).toBe("endSession(null)");
      }
    }
    // The positive half: the release is where the one commit happens.
    expect(body(src, "commitItems")).toContain("clickSlicerItemRun(");
    expect(body(src, "commitItems")).toContain("clickSlicerItem(");
    expect(body(src, "releaseButton")).toContain("clickSlicerClearFilter(");
    expect(body(src, "endSession")).toContain("commitItems(");
    expect(body(src, "endSession")).toContain("releaseButton(");
    expect(body(src, "onSessionUp")).toContain("endSession(");
  });

  it("every cancel path (Escape, blur) ends the gesture WITHOUT a release", () => {
    for (const name of ["onSessionKey", "onSessionBlur", "cancelSlicerContentPress"]) {
      const fn = body(src, name);
      expect(fn, `${name} is gone`).not.toBe("");
      expect(fn).not.toMatch(COMMIT);
      const calls = fn.match(/endSession\([^)]*\)/g) ?? [];
      expect(calls.length, `${name} does not end the gesture`).toBeGreaterThan(0);
      for (const call of calls) expect(call, `${name} ends the gesture as a RELEASE`).toBe("endSession(null)");
    }
  });

  it("binds its window listeners only when a gesture begins, and every one is removed", () => {
    const begin = body(src, "beginSlicerContentPress");
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
    // And the removal runs on every end path: endSession detaches.
    expect(body(src, "endSession")).toMatch(/\.detach\(\)/);
  });
});

describe("the slicer's press (index.ts)", () => {
  const src = code(INDEX);

  it("no window mousemove changes a selection without a held button", () => {
    for (const handler of windowListeners(src, "mousemove")) {
      const fn = body(src, handler);
      expect(
        !/selectedItems|clickSlicer|updateSlicerSelectionAsync/.test(fn) || /buttons/.test(fn),
        `the mousemove handler '${handler}' changes the selection with no button check`,
      ).toBe(true);
    }
  });

  it("no capture mousedown listener: the press's modifiers come from Core's zone-filtered press", () => {
    // A capture mousedown recorded Ctrl for the selected handler BEFORE Core
    // decided whose the modifier was, so a Ctrl+click on an item of a
    // selected slicer toggled the slicer OUT of its selection.
    expect(windowListeners(src, "mousedown")).toEqual([]);
    expect(src).not.toMatch(/addEventListener\(\s*"mousedown"/);
  });

  it("deactivation ends a live gesture with no commit and drops its preview", () => {
    const fn = body(src, "deactivate");
    expect(fn, "deactivate is gone").not.toBe("");
    expect(fn, "deactivation leaves a live item drag (and its window listeners) running").toContain("resetSlicerContentPress(");
  });

  it("a content press TAKES the pending click before it begins the gesture", () => {
    const [handler] = src.match(/addEventListener\("floatingObject:bodyDragStart",\s*(\w+)/)?.slice(1) ?? [];
    expect(handler, "no bodyDragStart handler: Core's content press reaches nobody").toBeTruthy();
    const fn = body(src, handler);
    const take = fn.indexOf("takePendingSlicerClick(");
    const begin = fn.indexOf("beginSlicerContentPress(");
    expect(take, "the content press leaves the pending click armed").toBeGreaterThan(0);
    expect(begin).toBeGreaterThan(take);
  });
});
