//! FILENAME: app/extensions/Pivot/lib/__tests__/pivotVisualHoverWiring.test.ts
// PURPOSE: The canvas pivot box's chrome HOVER HIGHLIGHT (the lit +/- and
//          filter buttons) is WIRED: Pivot/index.ts's document mousemove
//          observer calls `updatePivotVisualHoverAt(event.clientX,
//          event.clientY, event.target)` on every move, before anything in it
//          can return early.
// CONTEXT: M5 T4 moved the highlight out of the old side-effecting pointer
//          callback into that ONE call. pivotVisualZoneHover.test.ts pins the
//          function itself; nothing pinned the CALL -- replacing it with a no-op
//          left all 54 Pivot test files green while the buttons never lit up
//          (the fixer-round review's own sabotage). Source-level, the
//          chartMouseupLifetime / timelineNoPhantomDrag precedent: activating
//          Pivot in a unit test is a harness, not a guard.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const INDEX = path.resolve(__dirname, "../../index.ts");

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

describe("the canvas pivot box's hover highlight is wired (Pivot/index.ts)", () => {
  const src = code(INDEX);
  const [, handler] = src.match(/document\.addEventListener\(\s*"mousemove",\s*(\w+)\s*\)/) ?? [];
  const fn = body(src, handler ?? "");

  it("a document mousemove observer is bound, and removed again at deactivation", () => {
    expect(handler, "no document mousemove observer: the highlight never follows the pointer").toBeTruthy();
    expect(src).toMatch(new RegExp(`document\\.removeEventListener\\(\\s*"mousemove",\\s*${handler}\\s*\\)`));
  });

  it("imports the helper from the pivot-visual overlay", () => {
    expect(src).toMatch(/import\s*\{[^}]*\bupdatePivotVisualHoverAt\b[^}]*\}\s*from\s*"\.\/lib\/pivotVisualOverlay"/);
  });

  it("Core's floating-object HOVER is subscribed: every change goes to clearPivotVisualHoverUnlessHovered, and the unsubscribe is a cleanup (BUG-0258 phase 5)", () => {
    // The pointer leaving the grid, a scroll and a sheet switch send no
    // mousemove; Core's hover ends in all three, and says so here.
    expect(src).toMatch(/import\s*\{[^}]*\bonFloatingHoverChanged\b[^}]*\}\s*from\s*"@api\/gridOverlays"/);
    expect(src).toMatch(/import\s*\{[^}]*\bclearPivotVisualHoverUnlessHovered\b[^}]*\}\s*from\s*"\.\/lib\/pivotVisualOverlay"/);
    expect(src, "the box's highlight never hears that Core's hover left it").toMatch(
      /cleanupFunctions\.push\(\s*onFloatingHoverChanged\(\s*\((\w+)\)\s*=>\s*clearPivotVisualHoverUnlessHovered\(\1\)\s*\),?\s*\)/,
    );
  });

  it("calls updatePivotVisualHoverAt with the event's client point and target, before any early return", () => {
    expect(fn, "the observer is gone").not.toBe("");
    const call = fn.search(/updatePivotVisualHoverAt\(\s*event\.clientX,\s*event\.clientY,\s*event\.target\s*\)/);
    expect(call, "the observer no longer updates the canvas pivot box's hover").toBeGreaterThan(0);
    const firstReturn = fn.search(/\breturn\b/);
    expect(firstReturn === -1 || call < firstReturn, "an early return can skip the highlight (it would never clear)").toBe(true);
  });
});
