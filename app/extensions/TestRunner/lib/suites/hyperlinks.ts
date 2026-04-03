//! FILENAME: app/extensions/TestRunner/lib/suites/hyperlinks.ts
// PURPOSE: Hyperlinks test suite.
// CONTEXT: Tests adding, getting, removing, and clearing hyperlinks.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual, expectNotNull } from "../assertions";
import { AREA_HYPERLINKS } from "../testArea";
import {
  addHyperlink,
  getHyperlink,
  removeHyperlink,
  hasHyperlink,
  getAllHyperlinks,
  clearHyperlinksInRange,
} from "@api/backend";

const A = AREA_HYPERLINKS;

export const hyperlinksSuite: TestSuite = {
  name: "Hyperlinks",
  description: "Tests hyperlink CRUD, types, and range clear.",

  afterEach: async (ctx) => {
    try {
      await clearHyperlinksInRange(A.row, A.col, A.row + 10, A.col + 5);
    } catch { /* ignore */ }
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
      name: "Add URL hyperlink",
      description: "addHyperlink creates, getHyperlink retrieves.",
      run: async (ctx) => {
        const result = await addHyperlink({
          row: A.row,
          col: A.col,
          linkType: "url",
          target: "https://example.com",
          displayText: "Example",
          tooltip: "Go to example",
        });
        assertTrue(result.success, "addHyperlink should succeed");

        const link = await getHyperlink(A.row, A.col);
        expectNotNull(link, "hyperlink should exist");
        assertEqual(link!.linkType, "url", "type should be url");
        assertEqual(link!.target, "https://example.com", "target");
      },
    },
    {
      name: "Add email hyperlink",
      description: "Email type hyperlink created correctly.",
      run: async (ctx) => {
        const result = await addHyperlink({
          row: A.row,
          col: A.col,
          linkType: "email",
          target: "mailto:test@example.com",
          displayText: "Email us",
        });
        assertTrue(result.success, "addHyperlink should succeed");

        const link = await getHyperlink(A.row, A.col);
        expectNotNull(link, "hyperlink should exist");
        assertEqual(link!.linkType, "email", "type should be email");
      },
    },
    {
      name: "Add internal reference hyperlink",
      description: "Links to another cell within the workbook.",
      run: async (ctx) => {
        const result = await addHyperlink({
          row: A.row,
          col: A.col,
          linkType: "internalReference",
          target: "",
          cellReference: "A1",
          displayText: "Go to A1",
        });
        assertTrue(result.success, "addHyperlink should succeed");

        const link = await getHyperlink(A.row, A.col);
        expectNotNull(link, "hyperlink should exist");
        assertEqual(link!.linkType, "internalReference", "type");
      },
    },
    {
      name: "hasHyperlink returns true/false",
      description: "True when link exists, false when not.",
      run: async (ctx) => {
        const before = await hasHyperlink(A.row, A.col);
        assertTrue(!before, "should be false before adding");

        await addHyperlink({
          row: A.row, col: A.col,
          linkType: "url", target: "https://example.com",
        });

        const after = await hasHyperlink(A.row, A.col);
        assertTrue(after, "should be true after adding");
      },
    },
    {
      name: "Remove hyperlink",
      description: "Link is gone after removal.",
      run: async (ctx) => {
        await addHyperlink({
          row: A.row, col: A.col,
          linkType: "url", target: "https://example.com",
        });

        const result = await removeHyperlink(A.row, A.col);
        assertTrue(result.success, "removeHyperlink should succeed");

        const link = await getHyperlink(A.row, A.col);
        assertTrue(link === null, "link should be null after removal");
      },
    },
    {
      name: "Get all hyperlinks includes ours",
      description: "getAllHyperlinks returns list containing our link.",
      run: async (ctx) => {
        await addHyperlink({
          row: A.row, col: A.col,
          linkType: "url", target: "https://a.com",
        });
        await addHyperlink({
          row: A.row + 1, col: A.col,
          linkType: "url", target: "https://b.com",
        });

        const all = await getAllHyperlinks();
        const ours = all.filter(l => l.row >= A.row && l.row <= A.row + 1 && l.col === A.col);
        assertTrue(ours.length >= 2, `Should find at least 2 links, found ${ours.length}`);
      },
    },
    {
      name: "Clear hyperlinks in range",
      description: "clearHyperlinksInRange removes all links in area.",
      run: async (ctx) => {
        await addHyperlink({ row: A.row, col: A.col, linkType: "url", target: "https://1.com" });
        await addHyperlink({ row: A.row + 1, col: A.col, linkType: "url", target: "https://2.com" });
        await addHyperlink({ row: A.row + 2, col: A.col, linkType: "url", target: "https://3.com" });

        const cleared = await clearHyperlinksInRange(A.row, A.col, A.row + 2, A.col);
        assertTrue(cleared >= 3, `Should clear at least 3, cleared ${cleared}`);

        const check = await hasHyperlink(A.row, A.col);
        assertTrue(!check, "no link after clear");
      },
    },
  ],
};
