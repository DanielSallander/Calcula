//! FILENAME: app/extensions/AIChat/index.ts
// PURPOSE: AI extension entry point (ExtensionModule pattern). Registers TWO
//          task panes:
//            1. "MCP Server" (ChatPanel) — control panel to start/stop the local
//               MCP server that exposes the workbook to EXTERNAL AI clients.
//            2. "AI Chat" (ChatView) — a real in-app Claude chat that reads and
//               edits THIS workbook via the same tool surface (tool-use loop).
//          The folder/ids keep the historical "ai-chat" slug for stability.
// NOTE: Default exports an ExtensionModule object per the contract.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { IconServer, IconAIChat, registerScriptAssistantProvider } from "@api";
import { ChatPanel } from "./components/ChatPanel";
import { ChatView } from "./components/ChatView";
import { AuthorStatusItem } from "./components/AuthorStatusItem";
import { aiChatBackend } from "./lib/aiChatBackend";
import { registerJobViewOpener } from "./lib/jobFocus";
import { buildScriptAssistant } from "./lib/scriptAssistant";
import { installCompletionProvider } from "./lib/completionProvider";

const AI_CHAT_PANE_ID = "ai-chat";
const AI_CHAT_LLM_PANE_ID = "ai-chat-llm";
const AUTHOR_STATUS_ITEM_ID = "ai-chat:authoring";

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

  // Bind the capability-gated backend channel BEFORE anything that could
  // trigger a backend call (both panes render later, post-bind) (A3).
  aiChatBackend.set(context.invokeBackend);

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

  // Register the real in-app Claude chat task pane (C1).
  context.ui.taskPanes.register({
    id: AI_CHAT_LLM_PANE_ID,
    title: "AI Chat",
    component: ChatView,
    contextKeys: ["always"],
    priority: 41,
    closable: true,
  });
  cleanupFns.push(() => context.ui.taskPanes.unregister(AI_CHAT_LLM_PANE_ID));

  // A running authoring job is visible from anywhere in the app, not only from
  // the pane that started it — otherwise "close this and carry on working"
  // means "lose sight of it". Renders nothing when nothing is running.
  context.ui.statusBar.register({
    id: AUTHOR_STATUS_ITEM_ID,
    component: AuthorStatusItem,
    alignment: "right",
    priority: 85,
  });
  cleanupFns.push(() => context.ui.statusBar.unregister(AUTHOR_STATUS_ITEM_ID));

  // ...and make that indicator a way BACK. Only this function has the context
  // that can raise a task pane, so it registers the action; ChatView listens
  // separately for the half it owns (switching to the guided screen).
  cleanupFns.push(
    registerJobViewOpener(() => {
      context.ui.taskPanes.open(AI_CHAT_LLM_PANE_ID);
      context.ui.taskPanes.showContainer();
    }),
  );

  // The Object Script Editor reaches AI through this seam when the user presses
  // "Edit with AI". It must be registered HERE and the run must happen HERE:
  // every AI backend command is window-guarded to the MAIN window, and the
  // editor is a separate window that activates no extensions at all.
  cleanupFns.push(registerScriptAssistantProvider(buildScriptAssistant()));

  // The request-shaped seam, for features that want one answer rather than a
  // background job — the formula assistant first. Registered here for the same
  // reason as the one above: this extension owns the model selection, the
  // credential slots and the capability that lets the backend command run.
  cleanupFns.push(installCompletionProvider());

  // Add menu item under Developer menu
  context.ui.menus.registerItem("developer", {
    id: "developer:mcpServer",
    label: "MCP Server",
    icon: IconServer,
    action: () => {
      context.ui.taskPanes.open(AI_CHAT_PANE_ID);
      context.ui.taskPanes.showContainer();
    },
    order: 20,
  });

  // Add an "AI Chat" menu item under Developer for the in-app Claude chat.
  context.ui.menus.registerItem("developer", {
    id: "developer:aiChat",
    label: "AI Chat",
    icon: IconAIChat,
    action: () => {
      context.ui.taskPanes.open(AI_CHAT_LLM_PANE_ID);
      context.ui.taskPanes.showContainer();
    },
    order: 21,
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
    name: "MCP Server",
    version: "1.0.0",
    description: "Start/stop the local MCP server so external AI clients (Claude Desktop/Code) can read and write this workbook.",
  },
  activate,
  deactivate,
};

export default extension;
