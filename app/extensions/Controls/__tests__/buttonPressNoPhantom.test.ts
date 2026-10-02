//! FILENAME: app/extensions/Controls/__tests__/buttonPressNoPhantom.test.ts
// PURPOSE: A run-mode button's press (lib/buttonPress.ts, BUG-0258 design phase
//          4c) can never run the button without a held primary button, and can
//          never run it from anywhere but the release -- the timeline's
//          phantom drag (found live 2026-09-29, e2e fixall-pivot WF-D3: a
//          gesture armed at a mouseup followed the bare pointer and the next
//          click anywhere committed it) must not come back as a phantom BUTTON
//          press, where the thing committed is the user's macro.
//
//          Source-level, because what must never come back is a SHAPE: a window
//          mousemove that follows the pointer without looking at `buttons`, a
//          run made while the pointer moves or when the press is cancelled, a
//          window listener that outlives the press. The scan asserts there IS a
//          mousemove listener to check -- a scan that finds nothing passes
//          vacuously. The behaviour is pinned by lib/__tests__/buttonPress.test.ts;
//          this is the slicer's and the timeline's scan
//          (Slicer/__tests__/slicerNoPhantomDrag.test.ts).

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const PRESS = path.resolve(__dirname, "../lib/buttonPress.ts");

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

/** What RUNNING the button looks like here: the caller's `run`. */
const RUN = /\.run\(/;

describe("the run-mode button press (lib/buttonPress.ts)", () => {
  const src = code(PRESS);

  it("has a window mousemove listener to check -- the scan below is not vacuous", () => {
    expect(windowListeners(src, "mousemove").length).toBeGreaterThan(0);
  });

  it("every window mousemove listener checks the held button before it reads the pointer", () => {
    for (const handler of windowListeners(src, "mousemove")) {
      const fn = body(src, handler);
      expect(fn, `the mousemove handler '${handler}' was not found`).not.toBe("");
      expect(fn, `the mousemove handler '${handler}' follows the pointer with no button check`).toMatch(
        /\(\s*e\.buttons\s*&\s*1\s*\)\s*===\s*0/,
      );
      const check = fn.search(/\(\s*e\.buttons\s*&\s*1\s*\)/);
      const read = fn.search(/insideAt\(/);
      expect(read, `the mousemove handler '${handler}' never follows the pointer`).toBeGreaterThan(0);
      expect(check, `the mousemove handler '${handler}' reads the pointer before it checks the button`).toBeLessThan(read);
    }
  });

  it("the ONE run is the release's, behind the inside test; the press, the move and every cancel run nothing", () => {
    const up = body(src, "onPressUp");
    expect(up, "onPressUp is gone").not.toBe("");
    expect(up).toMatch(RUN);
    const inside = up.search(/insideAt\(/);
    expect(inside, "the release runs the button without asking whether it is inside").toBeGreaterThan(0);
    expect(inside).toBeLessThan(up.search(RUN));
    for (const name of ["beginFloatingButtonPress", "onPressMove", "onPressKey", "onPressBlur", "cancelFloatingButtonPress", "endPress"]) {
      const fn = body(src, name);
      expect(fn, `${name} is gone`).not.toBe("");
      expect(fn, `${name} runs the button`).not.toMatch(RUN);
    }
    // Exactly one place in the file runs it.
    expect(src.match(/\.run\(/g) ?? []).toHaveLength(1);
  });

  it("every window listener the press binds is removed when it ends", () => {
    const begin = body(src, "beginFloatingButtonPress");
    const end = body(src, "endPress");
    const bound = [...begin.matchAll(/window\.addEventListener\(\s*"(\w+)",\s*(\w+)(,\s*true)?\)/g)];
    expect(bound.map((m) => m[1]).sort()).toEqual(["blur", "keydown", "mousemove", "mouseup"]);
    for (const [, type, fn, capture] of bound) {
      expect(end, `the press's ${type} listener outlives it`).toContain(
        `window.removeEventListener("${type}", ${fn}${capture ?? ""})`,
      );
    }
    // No listener anywhere else in the file: they live only for the press.
    expect(src.match(/window\.addEventListener\(/g) ?? []).toHaveLength(bound.length);
  });
});
