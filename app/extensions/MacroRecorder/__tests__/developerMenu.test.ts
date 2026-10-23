//! FILENAME: app/extensions/MacroRecorder/__tests__/developerMenu.test.ts
// PURPOSE: Developer > New Macro exists, LEADS the menu, and does what its line
//          promises: creates the starter macro and opens it in the Object
//          Script Editor -- or, when that is impossible, says so and shows the
//          Macros dialog, where the created macro is listed either way.
// CONTEXT: 2026-10-22, the owner's complaint: "If I go to Developer, where
//          should I write a macro that adds 1 to a cell?" The two macro doors
//          carried orders 10 and 11, which put them BELOW every order-less
//          Developer item, so the answer was buried. The cluster now leads with
//          NEGATIVE orders. The ordering assertion sorts with the REAL
//          `sortMenuItems`, so "the cluster leads" is a fact about @api's sort
//          rule and not an assumption about it. Same harness as
//          menuState.test.ts, with the create seam and the toasts doubled.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

// Hoisted so the mock factories (which vitest lifts above the imports) can
// hand out the SAME spies the tests assert on.
const mocks = vi.hoisted(() => ({
  showDialog: vi.fn((_id: string): void => undefined),
  showToast: vi.fn((_message: string, _options?: { type?: string }): void => undefined),
  createStarterMacro: vi.fn(async () => ({
    id: "macro-macro1",
    name: "Macro1",
    functionName: "macro1",
  })),
}));

vi.mock("@api/ui", () => ({ showDialog: mocks.showDialog }));
vi.mock("@api/notifications", () => ({ showToast: mocks.showToast }));
vi.mock("@api/macroModules", () => ({ createStarterMacro: mocks.createStarterMacro }));

vi.mock("@api/locale", () => ({ getAppLocale: () => ({ decimalSeparator: "." }) }));

// The macro store: the recorder's library module must not need a backend.
vi.mock("@api", async () => {
  // The REAL origin rule: a provenance decision in a test must agree with the one
  // definition every gate reads, or the test pins a rule the product does not have.
  const origin = await vi.importActual<typeof import("@api/scriptHost/scriptOrigin")>(
    "@api/scriptHost/scriptOrigin",
  );
  return {
    scriptOriginForStoredRecord: origin.scriptOriginForStoredRecord,
    originTagTitle: origin.originTagTitle,

    ExtensionRegistry: { onSelectionChange: () => () => undefined },
    AppEvents: {
      BEFORE_OPEN: "app:before-open",
      BEFORE_NEW: "app:before-new",
      BEFORE_CLOSE: "app:before-close",
      SHEET_CHANGED: "app:sheet-changed",
    },
    MACRO_MODEL_EDIT_EVENT: "macro:model-edit",
    MACRO_MODEL_BATCH_EVENT: "macro:model-batch",
    listenTauriEvent: () => Promise.resolve(() => {}),
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
  };
});

vi.mock("@api/events", () => ({
  onAppEvent: () => () => undefined,
}));

vi.mock("@api/lib", () => ({
  getActiveSheet: async () => 0,
  setGridRecorderHook: () => undefined,
  requestMacroToNotebook: () => undefined,
}));

vi.mock("@api/commands", () => ({ setCommandRecorderHook: () => undefined }));

import extension from "../index";
import { COMMANDS, LIBRARY_DIALOG_ID, MENU_ITEMS } from "../lib/ids";
import {
  registerScriptEditorProvider,
  resetScriptEditorProvider,
} from "@api/scriptEditorService";
import type { MenuItemDefinition } from "@api/uiTypes";

// ---------------------------------------------------------------------------
// A context that records the menu items and the command handlers.
// ---------------------------------------------------------------------------

type CommandHandler = (args?: unknown) => unknown;

function createContext() {
  const items = new Map<string, MenuItemDefinition>();
  const handlers = new Map<string, CommandHandler>();
  const unregisteredCommands: string[] = [];
  return {
    items,
    handlers,
    unregisteredCommands,
    context: {
      commands: {
        register: (id: string, handler: CommandHandler) => {
          handlers.set(id, handler);
        },
        unregister: (id: string) => {
          handlers.delete(id);
          unregisteredCommands.push(id);
        },
        execute: vi.fn(),
      },
      ui: {
        dialogs: { register: vi.fn(), unregister: vi.fn() },
        statusBar: { register: vi.fn(), unregister: vi.fn() },
        menus: {
          register: vi.fn(),
          registerItem: (_menu: string, item: MenuItemDefinition) => {
            items.set(item.id, { ...item });
          },
          updateItem: (_menu: string, id: string, patch: Partial<MenuItemDefinition>) => {
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

/** Every toast shown so far, as `[message, type]`. */
function toasts(): Array<[string, string | undefined]> {
  return mocks.showToast.mock.calls.map(([message, options]) => [message, options?.type]);
}

/** Run the registered New Macro command and let it settle. */
async function runNewMacro(harness: ReturnType<typeof createContext>): Promise<void> {
  const handler = harness.handlers.get(COMMANDS.NEW);
  expect(handler, "macroRecorder.new is not registered").toBeDefined();
  await handler!();
}

let harness: ReturnType<typeof createContext>;

beforeEach(() => {
  vi.clearAllMocks();
  resetScriptEditorProvider();
  harness = createContext();
  extension.activate?.(harness.context);
});

afterEach(() => {
  extension.deactivate?.();
  resetScriptEditorProvider();
});

// ---------------------------------------------------------------------------

describe("the Developer-menu macro cluster", () => {
  it("registers New Macro as the first door, with the command under the recorder's own prefix", () => {
    const item = harness.items.get("developer:new-macro");
    expect(item).toBeDefined();
    expect(item).toMatchObject({
      id: MENU_ITEMS.NEW,
      label: "New Macro",
      commandId: "macroRecorder.new",
      order: -40,
    });
    // No shortcut and no ellipsis: nothing is asked, nothing is typed.
    expect(item?.shortcut).toBeUndefined();
    expect(item?.label.endsWith("…")).toBe(false);
    // The `macroRecorder.` prefix is what keeps the act of creating a macro out
    // of a running recording (the session ignores commands under it).
    expect(COMMANDS.NEW).toBe("macroRecorder.new");
    expect(COMMANDS.NEW.startsWith("macroRecorder.")).toBe(true);
  });

  it("moves Record Macro… and Macros… up to -30 and -20, keeping their ids, labels and shortcut", () => {
    expect(harness.items.get("developer:record-macro")).toMatchObject({
      id: MENU_ITEMS.RECORD,
      label: "Record Macro…",
      commandId: COMMANDS.START,
      shortcut: "Ctrl+Shift+R",
      order: -30,
    });
    expect(harness.items.get("developer:macro-library")).toMatchObject({
      id: MENU_ITEMS.LIBRARY,
      label: "Macros…",
      commandId: COMMANDS.LIBRARY,
      order: -20,
    });
  });

  it("closes the cluster with a separator at -1", () => {
    expect(harness.items.get("developer:macro-separator")).toMatchObject({
      id: MENU_ITEMS.SEPARATOR,
      label: "",
      separator: true,
      order: -1,
    });
  });

  it("registers exactly these four items on the Developer menu", () => {
    expect([...harness.items.keys()].sort()).toEqual(
      [MENU_ITEMS.NEW, MENU_ITEMS.RECORD, MENU_ITEMS.LIBRARY, MENU_ITEMS.SEPARATOR].sort(),
    );
  });

  it("leads the menu under the REAL sortMenuItems: above every order-less item, below none of the cluster", async () => {
    const { sortMenuItems } = await vi.importActual<typeof import("@api/ui")>("@api/ui");
    // Strangers FIRST in registration order, so that only the sort can put the
    // cluster above them: Notebook declares no order (0), MCP Server 20.
    const strangers: MenuItemDefinition[] = [
      { id: "n", label: "Notebook" },
      { id: "m", label: "MCP Server", order: 20 },
    ];
    const sorted = sortMenuItems([...strangers, ...harness.items.values()]);
    expect(sorted.map((item) => item.label)).toEqual([
      "New Macro",
      "Record Macro…",
      "Macros…",
      "",
      "Notebook",
      "MCP Server",
    ]);
    expect(sorted[3].separator).toBe(true);
  });

  it("unregisters all four items and the command on deactivation", () => {
    extension.deactivate?.();
    for (const id of [MENU_ITEMS.NEW, MENU_ITEMS.RECORD, MENU_ITEMS.LIBRARY, MENU_ITEMS.SEPARATOR]) {
      expect(harness.items.has(id), `${id} survived deactivation`).toBe(false);
    }
    expect(harness.items.size).toBe(0);
    expect(harness.unregisteredCommands).toContain(COMMANDS.NEW);
    expect(harness.handlers.has(COMMANDS.NEW)).toBe(false);
  });
});

describe("the macroRecorder.new command", () => {
  it("creates the starter macro once, then opens it in the Object Script Editor by id", async () => {
    const openMacroInEditor = vi.fn(async (_macroId: string): Promise<void> => undefined);
    registerScriptEditorProvider({
      openMacroInEditor,
      openDraftInEditor: vi.fn(async (): Promise<void> => undefined),
    });

    await runNewMacro(harness);

    expect(mocks.createStarterMacro).toHaveBeenCalledTimes(1);
    expect(openMacroInEditor).toHaveBeenCalledTimes(1);
    expect(openMacroInEditor).toHaveBeenCalledWith("macro-macro1");
    // The save comes first: the editor is opened on a record that exists.
    expect(mocks.createStarterMacro.mock.invocationCallOrder[0]).toBeLessThan(
      openMacroInEditor.mock.invocationCallOrder[0],
    );
    expect(toasts()).toEqual([
      [
        '"Macro1" was created. Select some cells with numbers, then press Run in the editor to add 1 to each.',
        "info",
      ],
    ]);
    // The happy path lands in the editor, not in the Macros dialog.
    expect(mocks.showDialog).not.toHaveBeenCalled();
  });

  it("a failed create shows the reason and opens nothing (the save is first, so nothing is half-made)", async () => {
    const openMacroInEditor = vi.fn(async (_macroId: string): Promise<void> => undefined);
    registerScriptEditorProvider({
      openMacroInEditor,
      openDraftInEditor: vi.fn(async (): Promise<void> => undefined),
    });
    mocks.createStarterMacro.mockRejectedValueOnce(new Error("disk full"));

    await runNewMacro(harness);

    expect(mocks.createStarterMacro).toHaveBeenCalledTimes(1);
    expect(openMacroInEditor).not.toHaveBeenCalled();
    expect(mocks.showDialog).not.toHaveBeenCalled();
    const shown = toasts();
    expect(shown).toHaveLength(1);
    expect(shown[0][0].startsWith("Could not create the macro: ")).toBe(true);
    expect(shown[0][0]).toContain("disk full");
    expect(shown[0][1]).toBe("error");
  });

  it("without an editor provider it still creates the macro, says where it is, and shows the Macros dialog", async () => {
    resetScriptEditorProvider();

    await runNewMacro(harness);

    expect(mocks.createStarterMacro).toHaveBeenCalledTimes(1);
    const shown = toasts();
    const warning = shown.find(([, type]) => type === "warning");
    expect(warning, "no warning toast").toBeDefined();
    expect(warning![0]).toContain("Developer ▸ Macros…");
    expect(warning![0]).toContain('"Macro1" was created');
    expect(warning![0]).toContain("Object Script Editor is unavailable");
    expect(mocks.showDialog).toHaveBeenCalledTimes(1);
    expect(mocks.showDialog).toHaveBeenCalledWith("macro-recorder:library");
    expect(LIBRARY_DIALOG_ID).toBe("macro-recorder:library");
  });

  it("a provider that cannot reach the editor window: its message is shown and the Macros dialog opens", async () => {
    registerScriptEditorProvider({
      openMacroInEditor: vi.fn(async (): Promise<void> => {
        throw new Error("the editor window could not be created");
      }),
      openDraftInEditor: vi.fn(async (): Promise<void> => undefined),
    });

    await runNewMacro(harness);

    expect(mocks.createStarterMacro).toHaveBeenCalledTimes(1);
    expect(toasts()).toContainEqual(["the editor window could not be created", "error"]);
    expect(mocks.showDialog).toHaveBeenCalledTimes(1);
    expect(mocks.showDialog).toHaveBeenCalledWith(LIBRARY_DIALOG_ID);
  });
});
