//! FILENAME: app/extensions/TestRunner/index.ts
// PURPOSE: TestRunner extension module entry point.
// CONTEXT: Macro-based integration test runner for Calcula.
//          Loaded only in dev mode. Registers test suites and provides
//          a task pane for browsing results.
// NOTE: Default exports an ExtensionModule object per the contract.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  registerTaskPane,
  unregisterTaskPane,
  openTaskPane,
  registerMenuItem,
  showToast,
} from "@api";
import { TestRunnerPane } from "./components/TestRunnerPane";
import {
  registerSuite,
  clearSuites,
  runAllSuites,
  runSuiteByName,
  runMacroByName,
} from "./lib/runner";

// Built-in test suites
import { basicSuite } from "./lib/suites/basic";
import { clipboardSuite } from "./lib/suites/clipboard";
import { formattingSuite } from "./lib/suites/formatting";
import { mockDataSuite } from "./lib/suites/mockData";
// Phase 1: Core primitives
import { formulasSuite } from "./lib/suites/formulas";
import { undoRedoSuite } from "./lib/suites/undoRedo";
import { sheetsSuite } from "./lib/suites/sheets";
import { rowColSuite } from "./lib/suites/rowCol";
import { mergeSuite } from "./lib/suites/merge";
// Phase 2: Data Features
import { sortingSuite } from "./lib/suites/sorting";
import { autoFilterSuite } from "./lib/suites/autoFilter";
import { namedRangesSuite } from "./lib/suites/namedRanges";
import { dataValidationSuite } from "./lib/suites/dataValidation";
import { removeDuplicatesSuite } from "./lib/suites/removeDuplicates";
import { goalSeekSuite } from "./lib/suites/goalSeek";
import { findReplaceSuite } from "./lib/suites/findReplace";
// Phase 3: Annotations
import { commentsSuite } from "./lib/suites/comments";
import { notesSuite } from "./lib/suites/notes";
import { conditionalFormattingSuite } from "./lib/suites/conditionalFormatting";
// Phase 4: Protection & Structure
import { protectionSuite } from "./lib/suites/protection";
import { groupingSuite } from "./lib/suites/grouping";
import { freezePanesSuite } from "./lib/suites/freezePanes";
import { hyperlinksSuite } from "./lib/suites/hyperlinks";
// Phase 5: Advanced Features
import { tracingSuite } from "./lib/suites/tracing";
import { pageSetupSuite } from "./lib/suites/pageSetup";
import { cellStylesSuite } from "./lib/suites/cellStyles";
import { aggregationSuite } from "./lib/suites/aggregation";
// Phase 6: Tables, Advanced Filters, Sheet Management, Consolidation
import { tablesSuite } from "./lib/suites/tables";
import { advancedFiltersSuite } from "./lib/suites/advancedFilters";
import { sheetsExtendedSuite } from "./lib/suites/sheetsExtended";
import { consolidationSuite } from "./lib/suites/consolidation";
// Phase 7: Utility Functions, Computed Properties, Formula Eval
import { utilitiesSuite } from "./lib/suites/utilities";
import { computedPropertiesSuite } from "./lib/suites/computedProperties";
import { formulaEvalSuite } from "./lib/suites/formulaEval";
// Phase 8: Advanced Annotations
import { advancedCommentsSuite } from "./lib/suites/advancedComments";
import { advancedNotesSuite } from "./lib/suites/advancedNotes";
import { advancedValidationSuite } from "./lib/suites/advancedValidation";
// Phase 9: Advanced CF, Hyperlinks, Protection, Print
import { advancedCFSuite } from "./lib/suites/advancedCF";
import { advancedHyperlinksSuite } from "./lib/suites/advancedHyperlinks";
import { advancedProtectionSuite } from "./lib/suites/advancedProtection";
import { printSuite } from "./lib/suites/print";
// Phase 10: Cross-Feature Integration
import { formulaCFSuite } from "./lib/suites/formulaCF";
import { protectionValidationSuite } from "./lib/suites/protectionValidation";
import { undoMultiStepSuite } from "./lib/suites/undoMultiStep";
import { copyPasteFeaturesSuite } from "./lib/suites/copyPasteFeatures";
// Phase 11: Edge Case / Regression
import { boundaryValuesSuite } from "./lib/suites/boundaryValues";
import { emptyRangeOpsSuite } from "./lib/suites/emptyRangeOps";
import { concurrentOpsSuite } from "./lib/suites/concurrentOps";
// Phase 12: Workflow Scenarios
import { workflowBudgetSuite } from "./lib/suites/workflowBudget";
import { workflowFilteredReportSuite } from "./lib/suites/workflowFilteredReport";
import { workflowProtectedTemplateSuite } from "./lib/suites/workflowProtectedTemplate";
// Phase 13: Multi-Sheet Integration
import { multiSheetOpsSuite } from "./lib/suites/multiSheetOps";
// Phase 14: Table Cross-Feature
import { tableFormulasSuite } from "./lib/suites/tableFormulas";
import { tableFeaturesSuite } from "./lib/suites/tableFeatures";
// Phase 15: Advanced Data Pipelines
import { pipelineFilterSortSuite } from "./lib/suites/pipelineFilterSort";
import { pipelineDataIntegritySuite } from "./lib/suites/pipelineDataIntegrity";
// Phase 16: New Features (LAMBDA, PDF Export)
import { lambdaSuite } from "./lib/suites/lambda";
import { pdfExportSuite } from "./lib/suites/pdfExport";
// Phase 17: Advanced Filter Extension
import { advancedFilterExtensionSuite } from "./lib/suites/advancedFilterExtension";
// Phase 18: Indent & Number Formats
import { indentFormatsSuite } from "./lib/suites/indentFormats";
// Phase 19: Spill Ranges, Flash Fill
import { spillRangesSuite } from "./lib/suites/spillRanges";
import { flashFillSuite } from "./lib/suites/flashFill";
// Phase 20: Paste Special, Format Painter, Subtotals
import { pasteSpecialSuite } from "./lib/suites/pasteSpecial";
import { formatPainterSuite } from "./lib/suites/formatPainter";
import { subtotalsSuite } from "./lib/suites/subtotals";

// ============================================================================
// Constants
// ============================================================================

/** Set to true to skip Phase 0-9 suites during test runs (they remain registered but disabled). */
const DISABLE_PHASES_0_9 = false;

const TASK_PANE_ID = "test-runner";

// ============================================================================
// State
// ============================================================================

let isActivated = false;
const cleanupFns: (() => void)[] = [];

// ============================================================================
// Lifecycle
// ============================================================================

function activate(context: ExtensionContext): void {
  if (isActivated) {
    console.warn("[TestRunner] Already activated, skipping.");
    return;
  }

  console.log("[TestRunner] Activating...");

  // ---- 1. Register commands ----
  context.commands.register("test.runAll", async () => {
    showToast("Running all test suites...", { variant: "info" });
    const results = await runAllSuites();
    const totalPassed = results.reduce((s, r) => s + r.passed, 0);
    const totalFailed = results.reduce((s, r) => s + r.failed, 0);
    const totalErrors = results.reduce((s, r) => s + r.errors, 0);

    if (totalFailed === 0 && totalErrors === 0) {
      showToast(`All ${totalPassed} tests passed`, { variant: "success" });
    } else {
      showToast(`${totalPassed} passed, ${totalFailed} failed, ${totalErrors} errors`, { variant: "warning" });
    }

    openTaskPane(TASK_PANE_ID);
  });

  context.commands.register("test.runSuite", async (args) => {
    const name = (args as { name?: string })?.name;
    if (!name) {
      showToast("Usage: test.runSuite({ name: 'suite name' })", { variant: "warning" });
      return;
    }
    showToast(`Running suite: ${name}`, { variant: "info" });
    await runSuiteByName(name);
    openTaskPane(TASK_PANE_ID);
  });

  context.commands.register("test.runMacro", async (args) => {
    const name = (args as { name?: string })?.name;
    if (!name) {
      showToast("Usage: test.runMacro({ name: 'test name' })", { variant: "warning" });
      return;
    }
    await runMacroByName(name);
    openTaskPane(TASK_PANE_ID);
  });

  context.commands.register("test.showPanel", () => {
    openTaskPane(TASK_PANE_ID);
  });

  // ---- 2. Register task pane ----
  registerTaskPane({
    id: TASK_PANE_ID,
    title: "Test Runner",
    component: TestRunnerPane,
    contextKeys: ["always"],
    priority: 5,
    closable: true,
  });
  cleanupFns.push(() => unregisterTaskPane(TASK_PANE_ID));

  // ---- 3. Register menu items (Developer > Test Runner) ----
  registerMenuItem("developer", {
    id: "test-runner.run-all",
    label: "Run All Tests",
    commandId: "test.runAll",
  });

  registerMenuItem("developer", {
    id: "test-runner.show-panel",
    label: "Show Test Runner Panel",
    commandId: "test.showPanel",
  });

  // ---- 4. Register built-in test suites ----
  // Helper to optionally disable Phase 0-9 suites
  const reg09 = (suite: Parameters<typeof registerSuite>[0]) =>
    registerSuite(DISABLE_PHASES_0_9 ? { ...suite, disabled: true } : suite);

  // Original suites
  reg09(basicSuite);
  reg09(clipboardSuite);
  reg09(formattingSuite);

  // Phase 1: Core primitives
  reg09(formulasSuite);
  reg09(undoRedoSuite);
  reg09(sheetsSuite);
  reg09(rowColSuite);
  reg09(mergeSuite);

  // Phase 2: Data Features
  reg09(sortingSuite);
  reg09(autoFilterSuite);
  reg09(namedRangesSuite);
  reg09(dataValidationSuite);
  reg09(removeDuplicatesSuite);
  reg09(goalSeekSuite);
  reg09(findReplaceSuite);

  // Phase 3: Annotations
  reg09(commentsSuite);
  reg09(notesSuite);
  reg09(conditionalFormattingSuite);

  // Phase 4: Protection & Structure
  reg09(protectionSuite);
  reg09(groupingSuite);
  reg09(freezePanesSuite);
  reg09(hyperlinksSuite);

  // Phase 5: Advanced Features
  reg09(tracingSuite);
  reg09(pageSetupSuite);
  reg09(cellStylesSuite);
  reg09(aggregationSuite);

  // Phase 6: Tables, Advanced Filters, Sheet Management, Consolidation
  reg09(tablesSuite);
  reg09(advancedFiltersSuite);
  reg09(sheetsExtendedSuite);
  reg09(consolidationSuite);

  // Phase 7: Utility Functions, Computed Properties, Formula Eval
  reg09(utilitiesSuite);
  reg09(computedPropertiesSuite);
  reg09(formulaEvalSuite);

  // Phase 8: Advanced Annotations
  reg09(advancedCommentsSuite);
  reg09(advancedNotesSuite);
  reg09(advancedValidationSuite);

  // Phase 9: Advanced CF, Hyperlinks, Protection, Print
  reg09(advancedCFSuite);
  reg09(advancedHyperlinksSuite);
  reg09(advancedProtectionSuite);
  reg09(printSuite);

  // Phase 10: Cross-Feature Integration
  registerSuite(formulaCFSuite);
  registerSuite(protectionValidationSuite);
  registerSuite(undoMultiStepSuite);
  registerSuite(copyPasteFeaturesSuite);

  // Phase 11: Edge Case / Regression
  registerSuite(boundaryValuesSuite);
  registerSuite(emptyRangeOpsSuite);
  registerSuite(concurrentOpsSuite);

  // Phase 12: Workflow Scenarios
  registerSuite(workflowBudgetSuite);
  registerSuite(workflowFilteredReportSuite);
  registerSuite(workflowProtectedTemplateSuite);

  // Phase 13: Multi-Sheet Integration
  registerSuite(multiSheetOpsSuite);

  // Phase 14: Table Cross-Feature
  registerSuite(tableFormulasSuite);
  registerSuite(tableFeaturesSuite);

  // Phase 15: Advanced Data Pipelines
  registerSuite(pipelineFilterSortSuite);
  registerSuite(pipelineDataIntegritySuite);

  // Phase 16: New Features (LAMBDA, PDF Export)
  registerSuite(lambdaSuite);
  registerSuite(pdfExportSuite);

  // Phase 17: Advanced Filter Extension
  registerSuite(advancedFilterExtensionSuite);

  // Phase 18: Indent & Number Formats
  registerSuite(indentFormatsSuite);

  // Phase 19: Spill Ranges, Flash Fill
  registerSuite(spillRangesSuite);
  registerSuite(flashFillSuite);

  // Phase 20: Paste Special, Format Painter, Subtotals
  registerSuite(pasteSpecialSuite);
  registerSuite(formatPainterSuite);
  registerSuite(subtotalsSuite);

  // Register mock data suite only when launched with prefilled data
  if (import.meta.env.VITE_LOAD_MOCK_DATA === "true") {
    registerSuite(mockDataSuite);
    console.log("[TestRunner] Mock data detected - registered mock data test suite.");
  }

  let suiteCount = 64; // 59 original + 2 (Phase 19) + 3 (Phase 20)
  if (import.meta.env.VITE_LOAD_MOCK_DATA === "true") suiteCount++;
  isActivated = true;
  console.log(`[TestRunner] Activated with ${suiteCount} built-in test suites.`);
}

function deactivate(): void {
  if (!isActivated) return;

  console.log("[TestRunner] Deactivating...");

  // Clean up in reverse order
  for (let i = cleanupFns.length - 1; i >= 0; i--) {
    try {
      cleanupFns[i]();
    } catch (error) {
      console.error("[TestRunner] Error during cleanup:", error);
    }
  }
  cleanupFns.length = 0;
  clearSuites();

  isActivated = false;
  console.log("[TestRunner] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.dev.test-runner",
    name: "Test Runner",
    version: "1.0.0",
    description:
      "Macro-based integration test runner for Calcula. " +
      "Drives the app through the API facade to verify workflows.",
  },
  activate,
  deactivate,
};

export default extension;
