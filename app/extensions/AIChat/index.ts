//! FILENAME: app/extensions/AIChat/index.ts
// PURPOSE: AI Chat extension - registers task pane and menu items.
// CONTEXT: Provides a built-in chat interface for AI-assisted spreadsheet work.

import {
  registerTaskPane,
  unregisterTaskPane,
  registerMenuItem,
  openTaskPane,
  showTaskPaneContainer,
} from "../../src/api";
import { ChatPanel } from "./components/ChatPanel";

const AI_CHAT_PANE_ID = "ai-chat";
const cleanupFns: (() => void)[] = [];

export function registerAIChatExtension(): void {
  console.log("[AIChat] Registering...");

  // Register the task pane
  registerTaskPane({
    id: AI_CHAT_PANE_ID,
    title: "MCP Server",
    component: ChatPanel,
    contextKeys: ["always"],
    priority: 40,
    closable: true,
  });
  cleanupFns.push(() => unregisterTaskPane(AI_CHAT_PANE_ID));

  // Add menu item under Developer menu
  const cleanupMenuItem = registerMenuItem("developer", {
    id: "developer:mcpServer",
    label: "MCP Server",
    action: () => {
      openTaskPane(AI_CHAT_PANE_ID);
      showTaskPaneContainer();
    },
    order: 20,
  });
  if (cleanupMenuItem) cleanupFns.push(cleanupMenuItem);

  console.log("[AIChat] Registered successfully.");
}

export function unregisterAIChatExtension(): void {
  console.log("[AIChat] Unregistering...");
  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[AIChat] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;
}
