//! FILENAME: app/extensions/AIChat/__tests__/aiChatExtension.test.ts
// PURPOSE: Tests for the AIChat extension module lifecycle.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the ChatPanel component before importing the extension
vi.mock("../components/ChatPanel", () => ({
  ChatPanel: () => null,
}));

// Mock @api/contract (needed for type imports but not actual runtime)
vi.mock("@api/contract", () => ({}));

// We need to test the extension module's activate/deactivate cycle.
// Since the module uses module-level state, we must re-import for isolation.

describe("AIChat Extension Module", () => {
  let extension: typeof import("../index").default;

  // Shared mock context
  const mockUnregisterTaskPane = vi.fn();
  const mockRegisterTaskPane = vi.fn();
  const mockUnregisterMenuItem = vi.fn();
  const mockOpenTaskPane = vi.fn();
  const mockShowContainer = vi.fn();

  function createMockContext() {
    return {
      ui: {
        taskPanes: {
          register: mockRegisterTaskPane,
          unregister: mockUnregisterTaskPane,
          open: mockOpenTaskPane,
          showContainer: mockShowContainer,
        },
        menus: {
          registerItem: vi.fn((_menu: string, item: { action: () => void }) => {
            // Store the action so we can call it in tests
            (createMockContext as any)._lastMenuAction = item.action;
          }),
        },
      },
    } as any;
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    // Re-import to reset module-level state (isActivated, cleanupFns)
    const mod = await import("../index");
    extension = mod.default;
  });

  it("has correct manifest metadata", () => {
    expect(extension.manifest.id).toBe("calcula.ai-chat");
    expect(extension.manifest.name).toBe("AI Chat");
    expect(extension.manifest.version).toBe("1.0.0");
  });

  it("registers task pane on activate", () => {
    const ctx = createMockContext();
    extension.activate(ctx);

    expect(mockRegisterTaskPane).toHaveBeenCalledOnce();
    expect(mockRegisterTaskPane).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "ai-chat",
        title: "MCP Server",
        closable: true,
      }),
    );
  });

  it("registers developer menu item on activate", () => {
    const ctx = createMockContext();
    extension.activate(ctx);

    expect(ctx.ui.menus.registerItem).toHaveBeenCalledWith(
      "developer",
      expect.objectContaining({
        id: "developer:mcpServer",
        label: "MCP Server",
      }),
    );
  });

  it("does not activate twice", () => {
    const ctx = createMockContext();
    extension.activate(ctx);
    extension.activate(ctx);

    // Should only register once
    expect(mockRegisterTaskPane).toHaveBeenCalledOnce();
  });

  it("cleans up on deactivate", () => {
    const ctx = createMockContext();
    extension.activate(ctx);
    extension.deactivate();

    expect(mockUnregisterTaskPane).toHaveBeenCalledWith("ai-chat");
  });

  it("deactivate is a no-op if not activated", () => {
    // Should not throw
    extension.deactivate();
    expect(mockUnregisterTaskPane).not.toHaveBeenCalled();
  });

  it("can re-activate after deactivation", () => {
    const ctx = createMockContext();
    extension.activate(ctx);
    extension.deactivate();
    extension.activate(ctx);

    expect(mockRegisterTaskPane).toHaveBeenCalledTimes(2);
  });
});
