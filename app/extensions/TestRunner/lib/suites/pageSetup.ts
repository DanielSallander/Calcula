//! FILENAME: app/extensions/TestRunner/lib/suites/pageSetup.ts
// PURPOSE: Page setup test suite.
// CONTEXT: Tests getting and setting page setup properties.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual } from "../assertions";
import { AREA_PAGE_SETUP } from "../testArea";
import { getPageSetup, setPageSetup } from "../../../../src/api/lib";

const A = AREA_PAGE_SETUP;

export const pageSetupSuite: TestSuite = {
  name: "Page Setup",
  description: "Tests page setup configuration (orientation, margins, scale, print area).",

  afterEach: async (ctx) => {
    // Reset to defaults
    try {
      const setup = await getPageSetup();
      await setPageSetup({
        ...setup,
        orientation: "portrait",
        scale: 100,
        printGridlines: false,
        printHeadings: false,
        printArea: "",
        centerHorizontally: false,
        centerVertically: false,
      });
    } catch { /* ignore */ }
    await ctx.settle();
  },

  tests: [
    {
      name: "Get default page setup",
      description: "getPageSetup returns valid defaults.",
      run: async (ctx) => {
        const setup = await getPageSetup();
        assertTrue(setup.orientation === "portrait" || setup.orientation === "landscape", "valid orientation");
        assertTrue(setup.scale > 0, "scale should be positive");
        assertTrue(setup.marginTop >= 0, "marginTop should be non-negative");
      },
    },
    {
      name: "Set orientation",
      description: "Changing orientation persists.",
      run: async (ctx) => {
        const setup = await getPageSetup();
        await setPageSetup({ ...setup, orientation: "landscape" });
        await ctx.settle();

        const updated = await getPageSetup();
        assertEqual(updated.orientation, "landscape", "orientation should be landscape");
      },
    },
    {
      name: "Set scale",
      description: "Custom scale percentage persists.",
      run: async (ctx) => {
        const setup = await getPageSetup();
        await setPageSetup({ ...setup, scale: 75 });
        await ctx.settle();

        const updated = await getPageSetup();
        assertEqual(updated.scale, 75, "scale should be 75");
      },
    },
    {
      name: "Set print options",
      description: "Gridlines and headings flags persist.",
      run: async (ctx) => {
        const setup = await getPageSetup();
        await setPageSetup({
          ...setup,
          printGridlines: true,
          printHeadings: true,
          centerHorizontally: true,
        });
        await ctx.settle();

        const updated = await getPageSetup();
        assertTrue(updated.printGridlines, "printGridlines should be true");
        assertTrue(updated.printHeadings, "printHeadings should be true");
        assertTrue(updated.centerHorizontally, "centerHorizontally should be true");
      },
    },
  ],
};
