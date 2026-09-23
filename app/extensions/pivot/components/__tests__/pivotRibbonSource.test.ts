//! FILENAME: app/extensions/Pivot/components/__tests__/pivotRibbonSource.test.ts
// PURPOSE: Source guard for the pivot ribbon files rebuilt on the @api/layout
//          grammar. The rendered-DOM tests next door prove what the sections
//          paint today; this keeps the hand-rolled idioms they replaced from
//          creeping back in a later edit: native <select>s in the band,
//          position:fixed overlay layers, a private portal, hover done by
//          mutating element.style, canvas thumbnails, and glyph/emoji icons.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const PIVOT_DIR = path.resolve(__dirname, "..", "..");

const FILES = [
  "components/PivotAnalyzeSections.tsx",
  "components/PivotDesignSections.tsx",
  "components/PivotTableStylesGallery.tsx",
  "manifest.ts",
];

function read(rel: string): string {
  return readFileSync(path.join(PIVOT_DIR, rel), "utf8");
}

/** Code only: line and block comments removed, so prose may name the idioms. */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("pivot ribbon source guard", () => {
  for (const rel of FILES) {
    it(`${rel} uses none of the replaced idioms`, () => {
      const src = code(rel);
      expect(src).not.toMatch(/<select\b/);
      expect(src).not.toMatch(/position:\s*['"]?fixed/);
      expect(src).not.toMatch(/createPortal/);
      expect(src).not.toMatch(/\.style\.(outline|background|color|border)\s*=/);
      expect(src).not.toMatch(/<canvas\b|getContext\(/);
      // Arrows, dingbats, box glyphs, the sigma(s) used as a Grand Totals
      // icon, and emoji.
      expect(src).not.toMatch(/[←-➿∑Σ\u{1F300}-\u{1FAFF}]/u);
      expect(src).not.toMatch(/&#x?[0-9a-f]+;/i);
    });
  }

  it("the component files carry no colour literal outside a var() fallback", () => {
    for (const rel of FILES.filter((f) => f.startsWith("components/"))) {
      const src = code(rel);
      const offenders = src
        .split("\n")
        .filter((line) => /#[0-9a-f]{3,8}\b|\brgba?\(/i.test(line) && !/var\(/.test(line));
      expect(offenders, rel).toEqual([]);
    }
  });
});
