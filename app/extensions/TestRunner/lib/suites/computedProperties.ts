//! FILENAME: app/extensions/TestRunner/lib/suites/computedProperties.ts
// PURPOSE: Computed Properties test suite.
// CONTEXT: Tests add, get, update, remove computed properties and available attributes.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual, expectNotNull } from "../assertions";
import { AREA_COMPUTED_PROPS } from "../testArea";
import {
  getComputedProperties,
  getAvailableAttributes,
  addComputedProperty,
  updateComputedProperty,
  removeComputedProperty,
} from "../../../../src/api/backend";

const A = AREA_COMPUTED_PROPS;

export const computedPropertiesSuite: TestSuite = {
  name: "Computed Properties",
  description: "Tests formula-driven computed attributes on columns, rows, and cells.",

  afterEach: async (ctx) => {
    // Clean up computed properties for our test column
    try {
      const props = await getComputedProperties("column", A.col);
      for (const p of props) {
        await removeComputedProperty(p.id);
      }
    } catch { /* ignore */ }
    const clears = [];
    for (let r = 0; r < 5; r++) {
      clears.push({ row: A.row + r, col: A.col, value: "" });
    }
    await ctx.setCells(clears);
    await ctx.settle();
  },

  tests: [
    {
      name: "Get available attributes",
      description: "getAvailableAttributes returns list for column target.",
      run: async (ctx) => {
        const attrs = await getAvailableAttributes("column");
        assertTrue(Array.isArray(attrs), "should return array");
        assertTrue(attrs.length > 0, "should have at least one attribute");
        ctx.log(`Available column attributes: ${attrs.join(", ")}`);
      },
    },
    {
      name: "Add computed property",
      description: "addComputedProperty creates a formula-driven attribute.",
      run: async (ctx) => {
        const attrs = await getAvailableAttributes("column");
        assertTrue(attrs.length > 0, "need at least one attribute");
        const attr = attrs[0];

        const result = await addComputedProperty("column", A.col, null, attr, "=100");
        assertTrue(result.success, "add should succeed");
        assertTrue(result.properties.length > 0, "should return properties");

        const added = result.properties.find(p => p.attribute === attr);
        expectNotNull(added, "our property should be in results");
      },
    },
    {
      name: "Get computed properties",
      description: "getComputedProperties retrieves previously added properties.",
      run: async (ctx) => {
        const attrs = await getAvailableAttributes("column");
        const attr = attrs[0];

        await addComputedProperty("column", A.col, null, attr, "=50");

        const props = await getComputedProperties("column", A.col);
        assertTrue(props.length > 0, "should have at least one property");
        const ours = props.find(p => p.attribute === attr);
        expectNotNull(ours, "our property should be found");
      },
    },
    {
      name: "Update computed property",
      description: "updateComputedProperty changes the formula.",
      run: async (ctx) => {
        const attrs = await getAvailableAttributes("column");
        const attr = attrs[0];

        const addResult = await addComputedProperty("column", A.col, null, attr, "=100");
        const prop = addResult.properties.find(p => p.attribute === attr);
        expectNotNull(prop, "added property");

        const updateResult = await updateComputedProperty(prop!.id, attr, "=200");
        assertTrue(updateResult.success, "update should succeed");

        const updated = updateResult.properties.find(p => p.id === prop!.id);
        expectNotNull(updated, "updated property should exist");
        assertEqual(updated!.formula, "=200", "formula should be updated");
      },
    },
    {
      name: "Remove computed property",
      description: "removeComputedProperty deletes it.",
      run: async (ctx) => {
        const attrs = await getAvailableAttributes("column");
        const attr = attrs[0];

        const addResult = await addComputedProperty("column", A.col, null, attr, "=100");
        const prop = addResult.properties.find(p => p.attribute === attr);
        expectNotNull(prop, "added property");

        const removeResult = await removeComputedProperty(prop!.id);
        assertTrue(removeResult.success, "remove should succeed");

        const props = await getComputedProperties("column", A.col);
        const gone = props.find(p => p.id === prop!.id);
        assertTrue(gone === undefined, "property should be gone");
      },
    },
  ],
};
