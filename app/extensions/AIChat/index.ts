//! FILENAME: app/extensions/AIChat/index.ts
// PURPOSE: AI Chat extension entry point (ExtensionModule pattern).
//          Registers task pane and menu items for MCP Server chat interface.
// NOTE: Default exports an ExtensionModule object per the contract.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { ChatPanel } from "./components/ChatPanel";

const AI_CHAT_PANE_ID = "ai-chat";

// ============================================================================
// State
// ============================================================================

let isActivated = false;
const cleanupFns: (() => void)[] = [];

// ============================================================================
// Activation
// ============================================================================

function activate(context: ExtensionContext): void {
  if (isActivated) {
    console.warn("[AIChat] Already activated, skipping.");
    return;
  }

  console.log("[AIChat] Activating...");

  // Register the task pane
  context.ui.taskPanes.register({
    id: AI_CHAT_PANE_ID,
    title: "MCP Server",
    component: ChatPanel,
    contextKeys: ["always"],
    priority: 40,
    closable: true,
  });
  cleanupFns.push(() => context.ui.taskPanes.unregister(AI_CHAT_PANE_ID));

  // Add menu item under Developer menu
  context.ui.menus.registerItem("developer", {
    id: "developer:mcpServer",
    label: "MCP Server",
    action: () => {
      context.ui.taskPanes.open(AI_CHAT_PANE_ID);
      context.ui.taskPanes.showContainer();
    },
    order: 20,
  });

  isActivated = true;
  console.log("[AIChat] Activated successfully.");
}

// ============================================================================
// Deactivation
// ============================================================================

function deactivate(): void {
  if (!isActivated) return;

  console.log("[AIChat] Deactivating...");
  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[AIChat] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;
  isActivated = false;
  console.log("[AIChat] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.ai-chat",
    name: "AI Chat",
    version: "1.0.0",
    description: "MCP Server chat interface for AI-assisted spreadsheet work.",
  },
  activate,
  deactivate,
};

export default extension;
