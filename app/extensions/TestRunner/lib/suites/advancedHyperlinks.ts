//! FILENAME: app/extensions/TestRunner/lib/suites/advancedHyperlinks.ts
// PURPOSE: Advanced Hyperlinks test suite.
// CONTEXT: Tests update, move, indicators, and getHyperlinksInRange.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual, expectNotNull } from "../assertions";
import { AREA_ADV_HYPERLINKS } from "../testArea";
import {
  addHyperlink,
  updateHyperlink,
  getHyperlink,
  getHyperlinkIndicators,
  getHyperlinksInRange,
  moveHyperlink,
  clearHyperlinksInRange,
} from "@api/backend";

const A = AREA_ADV_HYPERLINKS;

export const advancedHyperlinksSuite: TestSuite = {
  name: "Advanced Hyperlinks",
  description: "Tests hyperlink update, move, indicators, and range queries.",

  afterEach: async (ctx) => {
    try { await clearHyperlinksInRange(A.row, A.col, A.row + 10, A.col + 5); } catch { /* ignore */ }
    const clears = [];
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 3; c++) {
        clears.push({ row: A.row + r, col: A.col + c, value: "" });
      }
    }
    await ctx.setCells(clears);
    await ctx.settle();
  },

  tests: [
    {
      name: "Update hyperlink",
      description: "updateHyperlink changes target and display text.",
      run: async (ctx) => {
        await addHyperlink({
          row: A.row, col: A.col,
          linkType: "url",
          target: "https://old.com",
          displayText: "Old",
        });

        const result = await updateHyperlink({
          row: A.row, col: A.col,
          target: "https://new.com",
          displayText: "New",
        });
        assertTrue(result.success, `update should succeed: ${result.error}`);

        const link = await getHyperlink(A.row, A.col);
        expectNotNull(link, "link should exist");
        assertEqual(link!.target, "https://new.com", "target updated");
      },
    },
    {
      name: "Move hyperlink",
      description: "moveHyperlink relocates a link to another cell.",
      run: async (ctx) => {
        await addHyperlink({
          row: A.row, col: A.col,
          linkType: "url",
          target: "https://movable.com",
        });

        const result = await moveHyperlink(A.row, A.col, A.row + 2, A.col + 1);
        assertTrue(result.success, `move should succeed: ${result.error}`);

        const oldLink = await getHyperlink(A.row, A.col);
        assertTrue(oldLink === null, "no link at old location");

        const newLink = await getHyperlink(A.row + 2, A.col + 1);
        expectNotNull(newLink, "link at new location");
        assertEqual(newLink!.target, "https://movable.com", "target preserved");
      },
    },
    {
      name: "Get hyperlink indicators",
      description: "getHyperlinkIndicators returns markers for cells with links.",
      run: async (ctx) => {
        await addHyperlink({ row: A.row, col: A.col, linkType: "url", target: "https://a.com" });
        await addHyperlink({ row: A.row + 1, col: A.col, linkType: "url", target: "https://b.com" });

        const indicators = await getHyperlinkIndicators();
        const ours = indicators.filter(i => i.row >= A.row && i.row <= A.row + 1 && i.col === A.col);
        assertTrue(ours.length >= 2, `should have at least 2 indicators, got ${ours.length}`);
      },
    },
    {
      name: "Get hyperlinks in range",
      description: "getHyperlinksInRange returns links within a specific area.",
      run: async (ctx) => {
        await addHyperlink({ row: A.row, col: A.col, linkType: "url", target: "https://x.com" });
        await addHyperlink({ row: A.row + 1, col: A.col, linkType: "email", target: "mailto:test@test.com" });

        const inRange = await getHyperlinksInRange(A.row, A.col, A.row + 5, A.col + 5);
        assertTrue(inRange.length >= 2, `should find at least 2 links, got ${inRange.length}`);
      },
    },
  ],
};
