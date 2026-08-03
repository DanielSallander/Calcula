//! FILENAME: app/extensions/MacroRecorder/__tests__/menuState.test.ts
// PURPOSE: The Developer menu says what the recorder is actually doing —
//          "Record Macro…" when idle, "Stop Recording" while a session runs —
//          and returns to idle on EVERY end path.
// CONTEXT: The reported bug: "After I stopped recording I still see 'Stop
//          Recording' in the menu." There were two permanent items, so the menu
//          always offered both. One item whose label follows the session cannot
//          drift, provided it is driven by the recorder's own store rather than
//          patched at each call site — which is what this test pins down.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

const dialogs: string[] = [];

vi.mock("@api/ui", () => ({
  showDialog: (id: string) => {
    dialogs.push(id);
  },
}));

vi.mock("@api/locale", () => ({ getCachedLocale: () => ({ decimalSeparator: "." }) }));

// The macro store: recording end paths must not need a backend.
vi.mock("@api", () => ({
  ExtensionRegistry: { onSelectionChange: () => () => undefined },
  AppEvents: {
    BEFORE_OPEN: "app:before-open",
    BEFORE_NEW: "app:before-new",
    BEFORE_CLOSE: "app:before-close",
    SHEET_CHANGED: "app:sheet-changed",
  },
  listWorkbookScripts: async () => [],
  getWorkbookScript: async () => {
    throw new Error("not found");
  },
  saveWorkbookScript: async () => undefined,
  deleteWorkbookScript: async () => undefined,
  runWorkbookScript: async () => ({
    type: "success",
    output: [],
    cellsModified: 0,
    durationMs: 0,
    screenUpdating: true,
  }),
  onAppEvent: () => () => undefined,
}));

const appEventHandlers = new Map<string, Array<() => void>>();
vi.mock("@api/events", () => ({
  onAppEvent: (name: string, cb: () => void) => {
    const list = appEventHandlers.get(name) ?? [];
    list.push(cb);
    appEventHandlers.set(name, list);
    return () => {
      const current = appEventHandlers.get(name) ?? [];
      appEventHandlers.set(
        name,
        current.filter((fn) => fn !== cb),
      );
    };
  },
}));

vi.mock("@api/lib", () => ({
  getActiveSheet: async () => 0,
  setGridRecorderHook: () => undefined,
  requestMacroToNotebook: () => undefined,
}));

vi.mock("@api/commands", () => ({ setCommandRecorderHook: () => undefined }));

import extension from "../index";
import { recordMenuLabel } from "../index";
import { MENU_ITEMS } from "../lib/ids";
import {
  cancelRecording,
  resetRecorderForTests,
  startRecording,
} from "../lib/actionRecorder";
import { abandonRecording, finishRecording, resetFlow } from "../lib/flow";

// ---------------------------------------------------------------------------
// A context that records what happens to the menu.
// ---------------------------------------------------------------------------

interface MenuItem {
  id: string;
  label: string;
  [key: string]: unknown;
}

function createContext() {
  const items = new Map<string, MenuItem>();
  return {
    items,
    context: {
      commands: {
        register: vi.fn(),
        unregister: vi.fn(),
        execute: vi.fn(),
      },
      ui: {
        dialogs: { register: vi.fn(), unregister: vi.fn() },
        statusBar: { register: vi.fn(), unregister: vi.fn() },
        menus: {
          register: vi.fn(),
          registerItem: (_menu: string, item: MenuItem) => {
            items.set(item.id, { ...item });
          },
          updateItem: (_menu: string, id: string, patch: Record<string, unknown>) => {
            const existing = items.get(id);
            if (existing) items.set(id, { ...existing, ...patch, id });
          },
          unregisterItem: (_menu: string, id: string) => {
            items.delete(id);
          },
        },
      },
    } as never,
  };
}

function labelOf(items: Map<string, MenuItem>): string | undefined {
  return items.get(MENU_ITEMS.RECORD)?.label;
}

let harness: ReturnType<typeof createContext>;

beforeEach(() => {
  dialogs.length = 0;
  appEventHandlers.clear();
  resetRecorderForTests();
  resetFlow();
  harness = createContext();
  extension.activate?.(harness.context);
});

afterEach(() => {
  extension.deactivate?.();
});

// ---------------------------------------------------------------------------

describe("the Developer-menu record item", () => {
  it("is ONE item, not a permanent Record + a permanent Stop", () => {
    const ids = [...harness.items.keys()];
    expect(ids).toContain(MENU_ITEMS.RECORD);
    expect(ids).toContain(MENU_ITEMS.LIBRARY);
    expect(ids.filter((id) => id.includes("stop"))).toEqual([]);
    expect(ids).toHaveLength(2);
  });

  it("reads 'Record Macro…' while idle", () => {
    expect(labelOf(harness.items)).toBe("Record Macro…");
  });

  it("reads 'Stop Recording' while a session runs", async () => {
    await startRecording("Macro1245");
    expect(labelOf(harness.items)).toBe("Stop Recording");
  });

  it("goes back to 'Record Macro…' after Stop", async () => {
    await startRecording("Macro1245");
    await finishRecording();
    expect(labelOf(harness.items)).toBe("Record Macro…");
  });

  it("goes back to 'Record Macro…' after Discard", async () => {
    await startRecording("Macro1245");
    abandonRecording();
    expect(labelOf(harness.items)).toBe("Record Macro…");
  });

  it("goes back to 'Record Macro…' after a bare cancel", async () => {
    await startRecording("Macro1245");
    cancelRecording();
    expect(labelOf(harness.items)).toBe("Record Macro…");
  });

  it("goes back to 'Record Macro…' when the workbook is swapped", async () => {
    for (const event of ["app:before-open", "app:before-new", "app:before-close"]) {
      await startRecording("Macro1245");
      expect(labelOf(harness.items)).toBe("Stop Recording");

      const handlers = appEventHandlers.get(event) ?? [];
      expect(handlers.length, `no handler for ${event}`).toBeGreaterThan(0);
      for (const handler of handlers) handler();
      // finishRecording is async; the session itself stops synchronously.
      await Promise.resolve();
      await Promise.resolve();

      expect(labelOf(harness.items), `after ${event}`).toBe("Record Macro…");
    }
  });

  it("removes both items on deactivation", () => {
    extension.deactivate?.();
    expect(harness.items.size).toBe(0);
  });

  it("recordMenuLabel is the single source of the two strings", () => {
    expect(recordMenuLabel("idle")).toBe("Record Macro…");
    expect(recordMenuLabel("recording")).toBe("Stop Recording");
    expect(recordMenuLabel("paused")).toBe("Stop Recording");
  });
});
