//! FILENAME: app/extensions/TestRunner/index.ts
// PURPOSE: TestRunner extension module entry point.
// CONTEXT: Macro-based integration test runner for Calcula.
//          Loaded only in dev mode. Registers test suites and provides
//          a task pane for browsing results.
// NOTE: Default exports an ExtensionModule object per the contract.

import type { ExtensionModule, ExtensionContext } from "../../src/api/contract";
import {
  registerTaskPane,
  unregisterTaskPane,
  openTaskPane,
  registerMenuItem,
  showToast,
} from "../../src/api";
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

// ============================================================================
// Constants
// ============================================================================

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
  registerSuite(basicSuite);
  registerSuite(clipboardSuite);
  registerSuite(formattingSuite);

  isActivated = true;
  console.log("[TestRunner] Activated with 3 built-in test suites.");
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
