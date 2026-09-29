//! FILENAME: app/extensions/TimelineSlicer/__tests__/timelineNoPhantomDrag.test.ts
// PURPOSE: A period click arms nothing a later mouseup could complete.
//          Found live 2026-09-29 (e2e fixall-pivot WF-D3): the click completes
//          on MOUSEUP, and it armed a "range drag" right there with no button
//          held -- hovering afterwards grew the selection into a range, and the
//          next mouseup anywhere (a click on a cell) committed it, re-applying
//          a period the user had just undone. Source-level: the handlers are
//          closures of `activate`, and what must never come back is the SHAPE
//          (a drag state set by the click path, grown by a bare mousemove).

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const SRC = fs.readFileSync(path.resolve(__dirname, "../index.ts"), "utf8");

/** The body of `function name(` up to the next top-level function. */
function body(name: string): string {
  const at = SRC.indexOf(`function ${name}(`);
  expect(at, `${name} is gone`).toBeGreaterThan(0);
  const next = SRC.indexOf("\nfunction ", at + 1);
  return SRC.slice(at, next < 0 ? undefined : next);
}

describe("a timeline period click", () => {
  it("selects the period and arms no drag state", () => {
    const code = body("handlePeriodClick").replace(/\/\/.*$/gm, "");
    expect(code).toContain("updateTimelineSelectionAsync(");
    expect(code, "the click path arms a drag again").not.toMatch(/drag/i);
  });

  it("no window mousemove grows a selection without a held button", () => {
    const code = SRC.replace(/\/\/.*$/gm, "");
    const moveListeners = code.match(/addEventListener\("mousemove"[^)]*\)/g) ?? [];
    for (const l of moveListeners) {
      const handler = l.match(/"mousemove",\s*(\w+)/)?.[1] ?? "";
      const def = code.indexOf(`const ${handler} = (`);
      const fn = def >= 0 ? code.slice(def, code.indexOf("};", def)) : "";
      expect(
        !/selectionStart|selectionEnd|isSelected/.test(fn) || /buttons/.test(fn),
        `the mousemove handler '${handler}' changes the selection with no button check`,
      ).toBe(true);
    }
  });
});
