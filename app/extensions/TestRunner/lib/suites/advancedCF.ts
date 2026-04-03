//! FILENAME: app/extensions/TestRunner/lib/suites/advancedCF.ts
// PURPOSE: Advanced Conditional Formatting test suite.
// CONTEXT: Tests update, reorder, get single rule, and clearInRange.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual, expectNotNull } from "../assertions";
import { AREA_ADV_CF } from "../testArea";
import {
  addConditionalFormat,
  updateConditionalFormat,
  deleteConditionalFormat,
  reorderConditionalFormats,
  getConditionalFormat,
  getAllConditionalFormats,
  clearConditionalFormatsInRange,
} from "@api";

const A = AREA_ADV_CF;

export const advancedCFSuite: TestSuite = {
  name: "Advanced Conditional Formatting",
  description: "Tests CF update, reorder, get by ID, and clearInRange.",

  afterEach: async (ctx) => {
    try {
      await clearConditionalFormatsInRange(A.row, A.col, A.row + 10, A.col + 5);
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
      name: "Get conditional format by ID",
      description: "getConditionalFormat retrieves a specific rule.",
      run: async (ctx) => {
        const addResult = await addConditionalFormat({
          ranges: [{ startRow: A.row, startCol: A.col, endRow: A.row + 2, endCol: A.col }],
          rule: {
            type: "cellValue",
            operator: "greaterThan",
            value1: "50",
          },
          format: { bold: true },
        });
        assertTrue(addResult.success, `add should succeed: ${addResult.error}`);
        const ruleId = addResult.rule!.id;

        const rule = await getConditionalFormat(ruleId);
        expectNotNull(rule, "should find rule by ID");
        assertEqual(rule!.rule.type, "cellValue", "rule type should match");
      },
    },
    {
      name: "Update conditional format",
      description: "updateConditionalFormat modifies an existing rule.",
      run: async (ctx) => {
        const addResult = await addConditionalFormat({
          ranges: [{ startRow: A.row, startCol: A.col, endRow: A.row + 2, endCol: A.col }],
          rule: {
            type: "cellValue",
            operator: "equal",
            value1: "100",
          },
          format: { bold: true },
        });
        const ruleId = addResult.rule!.id;

        // Update the format to italic instead of bold
        const updateResult = await updateConditionalFormat({
          ruleId,
          format: { italic: true },
        });
        assertTrue(updateResult.success, `update should succeed: ${updateResult.error}`);

        // Verify update
        const updated = await getConditionalFormat(ruleId);
        expectNotNull(updated, "rule should still exist");
        assertTrue(updated!.format.italic === true, "format should now be italic");
      },
    },
    {
      name: "Reorder conditional formats",
      description: "reorderConditionalFormats changes priority order.",
      run: async (ctx) => {
        const r1 = await addConditionalFormat({
          ranges: [{ startRow: A.row, startCol: A.col, endRow: A.row, endCol: A.col }],
          rule: { type: "cellValue", operator: "greaterThan", value1: "10" },
          format: { bold: true },
        });
        const r2 = await addConditionalFormat({
          ranges: [{ startRow: A.row, startCol: A.col, endRow: A.row, endCol: A.col }],
          rule: { type: "cellValue", operator: "lessThan", value1: "5" },
          format: { italic: true },
        });

        const id1 = r1.rule!.id;
        const id2 = r2.rule!.id;

        // Reorder: put rule 2 before rule 1
        const result = await reorderConditionalFormats([id2, id1]);
        assertTrue(result.success, `reorder should succeed: ${result.error}`);

        // Verify order
        const all = await getAllConditionalFormats();
        const ourIds = all.filter(r => r.id === id1 || r.id === id2).map(r => r.id);
        assertTrue(ourIds.length === 2, "should have both rules");
        // First rule in the filtered list should be id2 (reordered to be first)
        if (ourIds.length === 2) {
          assertEqual(ourIds[0], id2, "rule 2 should be first after reorder");
        }
      },
    },
    {
      name: "Enable/disable conditional format",
      description: "updateConditionalFormat can toggle the enabled flag.",
      run: async (ctx) => {
        const addResult = await addConditionalFormat({
          ranges: [{ startRow: A.row, startCol: A.col, endRow: A.row, endCol: A.col }],
          rule: { type: "cellValue", operator: "equal", value1: "1" },
          format: { bold: true },
        });
        const ruleId = addResult.rule!.id;

        // Disable
        const disableResult = await updateConditionalFormat({
          ruleId,
          enabled: false,
        });
        assertTrue(disableResult.success, "disable should succeed");

        const disabled = await getConditionalFormat(ruleId);
        assertTrue(disabled!.enabled === false, "rule should be disabled");

        // Re-enable
        const enableResult = await updateConditionalFormat({
          ruleId,
          enabled: true,
        });
        assertTrue(enableResult.success, "enable should succeed");

        const enabled = await getConditionalFormat(ruleId);
        assertTrue(enabled!.enabled === true, "rule should be enabled");
      },
    },
  ],
};
