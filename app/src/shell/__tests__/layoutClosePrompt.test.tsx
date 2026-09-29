//! FILENAME: app/src/shell/__tests__/layoutClosePrompt.test.tsx
// PURPOSE: Closing the window over unsaved work must discard it ONLY on an
//          explicit "Don't Save" click -- and must not tear the workbook's
//          live state down for a close that does not happen.
// CONTEXT: The close prompt in Layout.tsx used a two-button box (okLabel
//          "Save" / cancelLabel "Don't Save"). Dismissing it with the X button
//          or Escape came back as the refusing button, so the window was
//          destroyed WITHOUT saving. It now asks Excel's three-button question
//          through askSaveDiscardCancelAsync (@api/dialogs).
//
//          Making Cancel keep the window open exposed the ORDER around the
//          prompt. BEFORE_CLOSE is the workbook's teardown: ScriptableObjects
//          unmounts every object script on it (and with them every
//          onBeforeClose / onBeforeSave veto the script host registered), the
//          scheduler stops, script panes and forms close, grants are forgotten,
//          a macro recording ends and the Animation driver unloads. It was
//          broadcast BEFORE the question, so Cancel left the window open over a
//          workbook whose scripts were all gone, and Save wrote the file after
//          every script's Before-Save veto had already been unregistered.
//
//          E8 (BUG-0200, close parts), two more gaps. (1) The Save's REFUSING
//          steps -- the Save As picker of an untitled workbook, the lossy-save
//          warning -- ran AFTER the teardown, so cancelling one left the window
//          open over torn-down scripts: saving is now two halves
//          (file-api prepareSave / writePreparedSave) and every refusal runs
//          before BEFORE_CLOSE. (2) The teardown's ASYNC work (the recorder
//          storing its recording, the Animation restore, the script host
//          re-protecting a sheet) was not awaited, so the file could be written
//          before it: it is now registered as close preparations
//          (@api/lifecycleGuards) that the shell awaits before the write and
//          before the window goes.
//
//          The REAL Layout close handler runs here against the REAL dialog
//          wrapper, the REAL lifecycle-guard registry and the REAL
//          close-preparation registry; only the plugin, the window and the file
//          API are doubled. The plugin is doubled in its TAURI shape: `message`
//          with YesNoCancel custom buttons resolves the clicked button's LABEL,
//          and the cancel label for X / Escape / Alt+F4 (the pinned plugin and
//          rfd source lines are cited in src/core/lib/dialogs.ts). The plugin's
//          two-button `confirm` resolves `false` here, which is what X produced
//          on the old box, so this file run against the old Layout shows the
//          old data loss. `emitAppEvent` records what was broadcast, and a
//          BEFORE_CLOSE runs the teardowns a test registered -- the way the
//          script host drops its guards on it.

// The module doubles below must export the REAL (PascalCase) names Layout imports.
/* eslint-disable @typescript-eslint/naming-convention */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  checkLifecycleGuards as realCheckLifecycleGuards,
  registerLifecycleGuard,
  resetLifecycleGuards,
  type LifecycleAction,
  type LifecycleGuardResult,
} from "../../core/lib/lifecycleGuards";
import { registerClosePreparation, resetClosePreparations } from "../../api/lifecycleGuards";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

type CloseEvent = { preventDefault: () => void };
type Prepared = { path: string; kind: "save" | "saveAs" };

const h = vi.hoisted(() => ({
  closeHandler: undefined as undefined | ((event: CloseEvent) => Promise<void>),
  destroy: vi.fn(),
  isFileModified: vi.fn(),
  prepareSave: vi.fn(),
  writePreparedSave: vi.fn(),
  getCurrentFilePath: vi.fn(),
  /** What the (doubled) Save As picker answers for an untitled workbook: a path, or null (cancelled). */
  pickedPath: "C:/Books/Picked.cala" as string | null,
  pluginMessage: vi.fn(),
  pluginConfirm: vi.fn(),
  checkLifecycleGuards: vi.fn(),
  emitAppEvent: vi.fn(),
  /** Every event name broadcast through emitAppEvent, in order. */
  emitted: [] as string[],
  /** Teardowns run on BEFORE_CLOSE (a script host unmounting its guards). */
  onBeforeClose: [] as Array<() => void>,
  gridContext: { state: { selection: null, displayFormulaBar: true }, dispatch: () => {} },
}));

// ---- the native window and the dialog plugin (the Tauri shapes) -----------
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async (handler: (event: CloseEvent) => Promise<void>) => {
      h.closeHandler = handler;
      return () => {};
    },
    destroy: () => h.destroy(),
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: (...a: unknown[]) => h.pluginMessage(...a),
  confirm: (...a: unknown[]) => h.pluginConfirm(...a),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => undefined }));

// ---- the document ------------------------------------------------------------
vi.mock("../../core/lib/file-api", () => ({
  updateWindowTitle: () => {},
  isFileModified: () => h.isFileModified(),
  prepareSave: (...a: unknown[]) => h.prepareSave(...a),
  writePreparedSave: (...a: unknown[]) => h.writePreparedSave(...a),
  getCurrentFilePath: () => h.getCurrentFilePath(),
}));

// ---- everything else Layout mounts, reduced to nothing -------------------------
vi.mock("../../api", () => ({
  useGridContext: () => h.gridContext,
  setFreezeConfig: () => ({}),
  setSplitConfig: () => ({}),
  setViewMode: () => ({}),
  setShowFormulas: () => ({}),
  setDisplayZeros: () => ({}),
  setDisplayGridlines: () => ({}),
  setDisplayHeadings: () => ({}),
  setDisplayFormulaBar: () => ({}),
  setReferenceStyle: () => ({}),
  ExtensionRegistry: { notifySelectionChange: () => {} },
  AppEvents: new Proxy({}, { get: (_target, key) => String(key) }),
  onAppEvent: () => () => {},
  emitAppEvent: (...a: unknown[]) => h.emitAppEvent(...a),
  checkLifecycleGuards: (...a: unknown[]) => h.checkLifecycleGuards(...a),
}));
vi.mock("../../api/ui", () => ({
  getShellComponents: () => [],
  onShellComponentsChange: () => () => {},
}));
vi.mock("../hooks/useExtensions", () => ({
  useExtensionInitializer: () => ({ isLoading: false, error: null }),
  useExtensions: () => ({ activeCount: 0, errorCount: 0 }),
}));
vi.mock("../utils/mockData", () => ({
  loadMockData: async () => {},
  shouldLoadMockData: () => false,
}));
vi.mock("../../core/state/GridContext", () => ({
  GridProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("../../core/lib/sheetViewState", () => ({ persistSheetDisplayFlags: async () => {} }));
vi.mock("../../core/components/Spreadsheet", () => ({ Spreadsheet: () => null }));
vi.mock("../MenuBar", () => ({ MenuBar: () => null }));
vi.mock("../Ribbon/RibbonContainer", () => ({ RibbonContainer: () => null }));
vi.mock("../FormulaBar", () => ({ FormulaBar: () => null }));
vi.mock("../SheetTabs", () => ({ SheetTabs: () => null }));
vi.mock("../TaskPane", () => ({ TaskPaneContainer: () => null }));
vi.mock("../ActivityBar", () => ({ ActivityBar: () => null, SidePanel: () => null }));
vi.mock("../DialogContainer", () => ({ DialogContainer: () => null }));
vi.mock("../OverlayContainer", () => ({ OverlayContainer: () => null }));
vi.mock("../Overlays/GridContextMenuHost", () => ({ GridContextMenuHost: () => null }));
vi.mock("../Toast/Toast", () => ({ ToastContainer: () => null }));
vi.mock("../StatusBar", () => ({ StatusBar: () => null }));

import { Layout } from "../Layout";

const SAVED_PATH = "C:/Books/Budget.cala";
const w = window as unknown as Record<string, unknown>;
let root: Root;
let host: HTMLDivElement;

/** One close request (the title-bar X of the MAIN window), run to completion. */
async function requestClose(): Promise<{ preventDefault: ReturnType<typeof vi.fn> }> {
  const event = { preventDefault: vi.fn() };
  expect(h.closeHandler, "Layout registered no close handler").toBeDefined();
  await h.closeHandler!(event);
  return event;
}

/**
 * The real prepareSave, reduced (file-api.ts): the destination -- the current
 * path, or the Save As picker's answer for an untitled workbook -- then the
 * Before-Save guards registered AT THAT MOMENT. Null = "not saving".
 */
async function modelledPrepareSave(): Promise<Prepared | null> {
  const current = (await h.getCurrentFilePath()) as string | null;
  if (current) {
    if (await realCheckLifecycleGuards("save", { path: current, kind: "save" })) return null;
    return { path: current, kind: "save" };
  }
  if (h.pickedPath === null) return null;
  if (await realCheckLifecycleGuards("save", { path: h.pickedPath, kind: "saveAs" })) return null;
  return { path: h.pickedPath, kind: "saveAs" };
}

/** Stand-in for a mounted object script's lifecycle guard: registered now,
 *  unregistered by the BEFORE_CLOSE teardown, exactly as hostUnmountScript
 *  disposes the forwarder that owns it. */
function mountScriptGuard(
  verdict: (action: LifecycleAction) => LifecycleGuardResult | null,
): ReturnType<typeof vi.fn> {
  const guard = vi.fn(async (action: LifecycleAction) => verdict(action));
  h.onBeforeClose.push(registerLifecycleGuard(guard));
  return guard;
}

/** invocationCallOrder of the (first) BEFORE_CLOSE broadcast. */
function beforeCloseOrder(): number {
  const index = h.emitAppEvent.mock.calls.findIndex((call) => call[0] === "BEFORE_CLOSE");
  expect(index, "BEFORE_CLOSE was never broadcast").toBeGreaterThanOrEqual(0);
  return h.emitAppEvent.mock.invocationCallOrder[index];
}

/** A close preparation the test finishes by hand (the recorder's store, say). */
function heldPreparation(): { finish: () => void; ran: () => boolean; finished: () => boolean } {
  let release: () => void = () => {};
  let started = false;
  let done = false;
  registerClosePreparation("test: held", () => {
    started = true;
    return new Promise<void>((resolve) => {
      release = () => {
        done = true;
        resolve();
      };
    });
  });
  return { finish: () => release(), ran: () => started, finished: () => done };
}

async function drain(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(async () => {
  w.__TAURI_INTERNALS__ = {};
  h.closeHandler = undefined;
  h.emitted.length = 0;
  h.onBeforeClose.length = 0;
  h.pickedPath = "C:/Books/Picked.cala";
  h.destroy.mockReset().mockResolvedValue(undefined);
  h.isFileModified.mockReset().mockResolvedValue(true);
  h.getCurrentFilePath.mockReset().mockResolvedValue(SAVED_PATH);
  h.prepareSave.mockReset().mockImplementation(modelledPrepareSave);
  h.writePreparedSave.mockReset().mockImplementation(async (p: Prepared) => p.path);
  h.pluginMessage.mockReset();
  // What the X button produced on the OLD two-button box: the refusing button.
  h.pluginConfirm.mockReset().mockResolvedValue(false);
  h.checkLifecycleGuards
    .mockReset()
    .mockImplementation((...a: Parameters<typeof realCheckLifecycleGuards>) =>
      realCheckLifecycleGuards(...a),
    );
  h.emitAppEvent.mockReset().mockImplementation((name: string) => {
    h.emitted.push(name);
    if (name === "BEFORE_CLOSE") for (const teardown of h.onBeforeClose.splice(0)) teardown();
  });

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<Layout />);
  });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
  delete w.__TAURI_INTERNALS__;
  resetLifecycleGuards();
  resetClosePreparations();
  vi.restoreAllMocks();
});

describe("Layout close prompt over unsaved changes", () => {
  it("asks Excel's three-button question: Save / Don't Save / Cancel", async () => {
    h.pluginMessage.mockResolvedValue("Cancel");
    await requestClose();
    expect(h.pluginMessage).toHaveBeenCalledTimes(1);
    expect(h.pluginMessage).toHaveBeenCalledWith("Do you want to save changes before closing?", {
      title: "Calcula",
      kind: "warning",
      buttons: { yes: "Save", no: "Don't Save", cancel: "Cancel" },
    });
    expect(h.pluginConfirm).not.toHaveBeenCalled();
  });

  // THE REGRESSION. X / Escape / Alt+F4 resolve the cancel label.
  it("X or Escape keeps the window open, saves nothing, and the next close asks again", async () => {
    h.pluginMessage.mockResolvedValue("Cancel");
    const event = await requestClose();
    expect(event.preventDefault).toHaveBeenCalled();
    expect(h.destroy).not.toHaveBeenCalled();
    expect(h.prepareSave).not.toHaveBeenCalled();
    expect(h.writePreparedSave).not.toHaveBeenCalled();

    await requestClose();
    expect(h.pluginMessage).toHaveBeenCalledTimes(2);
    expect(h.destroy).not.toHaveBeenCalled();
  });

  it("Save saves, THEN closes", async () => {
    h.pluginMessage.mockResolvedValue("Save");
    await requestClose();
    expect(h.writePreparedSave).toHaveBeenCalledTimes(1);
    expect(h.writePreparedSave).toHaveBeenCalledWith({ path: SAVED_PATH, kind: "save" });
    expect(h.destroy).toHaveBeenCalledTimes(1);
    expect(h.writePreparedSave.mock.invocationCallOrder[0]).toBeLessThan(h.destroy.mock.invocationCallOrder[0]);
  });

  it("an explicit Don't Save closes without saving", async () => {
    h.pluginMessage.mockResolvedValue("Don't Save");
    await requestClose();
    expect(h.prepareSave).not.toHaveBeenCalled();
    expect(h.writePreparedSave).not.toHaveBeenCalled();
    expect(h.destroy).toHaveBeenCalledTimes(1);
  });

  it("a Save whose WRITE throws keeps the window open, and the next close asks again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.pluginMessage.mockResolvedValue("Save");
    h.writePreparedSave.mockRejectedValueOnce(new Error("disk full"));
    await requestClose();
    expect(h.destroy).not.toHaveBeenCalled();

    await requestClose();
    expect(h.pluginMessage).toHaveBeenCalledTimes(2);
  });

  it("a prompt that cannot be shown keeps the window open, and the next close asks again", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    h.pluginMessage.mockRejectedValueOnce(new Error("a modal is already open"));
    await requestClose();
    expect(h.destroy).not.toHaveBeenCalled();
    expect(h.prepareSave).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalled();

    h.pluginMessage.mockResolvedValueOnce("Cancel");
    await requestClose();
    expect(h.pluginMessage).toHaveBeenCalledTimes(2);
  });

  it("an answer that is none of the three labels keeps the window open", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const answer of ["No", "Yes", "", undefined]) {
      h.pluginMessage.mockResolvedValueOnce(answer);
      await requestClose();
      expect(h.destroy, String(answer)).not.toHaveBeenCalled();
      expect(h.prepareSave, String(answer)).not.toHaveBeenCalled();
    }
    expect(h.pluginMessage).toHaveBeenCalledTimes(4);
  });

  it("a clean document closes natively without asking", async () => {
    h.isFileModified.mockResolvedValue(false);
    const event = await requestClose();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(h.pluginMessage).not.toHaveBeenCalled();
    expect(h.destroy).not.toHaveBeenCalled();
  });
});

// BEFORE_CLOSE tears the workbook's live state down, and nothing brings it back
// short of reopening the file, so it may only go out once the window is really
// going. Broadcast ahead of the question, Cancel / X / Escape left the window
// open over a workbook whose scripts, scheduler, panes, grants, recording and
// animation driver were all gone -- and whose onBeforeClose vetoes no longer
// existed for the next close.
describe("BEFORE_CLOSE goes out only once the close is decided", () => {
  it("Cancel, X, Escape, an unshowable prompt or an unknown answer broadcasts nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const teardown = vi.fn();
    h.onBeforeClose.push(teardown);
    h.pluginMessage
      .mockResolvedValueOnce("Cancel")
      .mockRejectedValueOnce(new Error("a modal is already open"))
      .mockResolvedValueOnce("No")
      .mockResolvedValueOnce(undefined);
    for (let i = 0; i < 4; i++) await requestClose();

    expect(h.pluginMessage).toHaveBeenCalledTimes(4);
    expect(h.emitted).not.toContain("BEFORE_CLOSE");
    expect(teardown).not.toHaveBeenCalled();
    expect(h.destroy).not.toHaveBeenCalled();
  });

  it("Save broadcasts it after the save was PREPARED and BEFORE the file is written", async () => {
    h.pluginMessage.mockResolvedValue("Save");
    await requestClose();

    const broadcast = beforeCloseOrder();
    expect(h.pluginMessage.mock.invocationCallOrder[0]).toBeLessThan(broadcast);
    // Every refusing step (destination, consent, vetoes) ran while the
    // workbook was whole...
    expect(h.prepareSave.mock.invocationCallOrder[0]).toBeLessThan(broadcast);
    // ...and the recorder stores its module, Animation restores its transient
    // writes and the script host puts lifted sheet protection back on this
    // broadcast, so it must precede the write.
    expect(broadcast).toBeLessThan(h.writePreparedSave.mock.invocationCallOrder[0]);
    expect(h.writePreparedSave.mock.invocationCallOrder[0]).toBeLessThan(h.destroy.mock.invocationCallOrder[0]);
    expect(h.emitted.filter((name) => name === "BEFORE_CLOSE")).toHaveLength(1);
  });

  it("Don't Save broadcasts it, then closes", async () => {
    h.pluginMessage.mockResolvedValue("Don't Save");
    await requestClose();

    expect(beforeCloseOrder()).toBeLessThan(h.destroy.mock.invocationCallOrder[0]);
    expect(h.emitted.filter((name) => name === "BEFORE_CLOSE")).toHaveLength(1);
  });

  it("a clean document broadcasts it and closes natively", async () => {
    h.isFileModified.mockResolvedValue(false);
    const event = await requestClose();

    expect(h.emitted).toEqual(["BEFORE_CLOSE"]);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("a close veto broadcasts nothing and asks nothing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mountScriptGuard((action) => (action === "close" ? { by: "Ledger" } : null));
    const event = await requestClose();

    expect(event.preventDefault).toHaveBeenCalled();
    expect(h.emitted).not.toContain("BEFORE_CLOSE");
    expect(h.pluginMessage).not.toHaveBeenCalled();
  });
});

// E8 (1): a Save that turns out NOT to happen -- the untitled workbook's Save
// As picker cancelled, the lossy-save warning declined -- used to be learnt
// only AFTER the teardown, leaving the window open over torn-down scripts.
describe("a Save that does not happen tears nothing down (E8)", () => {
  it("the Save As picker cancelled: the window stays, BEFORE_CLOSE never goes out, nothing is written", async () => {
    h.getCurrentFilePath.mockResolvedValue(null);
    h.pickedPath = null;
    const teardown = vi.fn();
    h.onBeforeClose.push(teardown);
    h.pluginMessage.mockResolvedValue("Save");
    await requestClose();

    expect(h.prepareSave).toHaveBeenCalledTimes(1);
    expect(h.emitted, "the workbook was torn down for a save that did not happen").not.toContain("BEFORE_CLOSE");
    expect(teardown).not.toHaveBeenCalled();
    expect(h.writePreparedSave).not.toHaveBeenCalled();
    expect(h.destroy).not.toHaveBeenCalled();

    await requestClose();
    expect(h.pluginMessage).toHaveBeenCalledTimes(2);
  });

  it("the lossy-save warning declined (prepareSave answers null): the same", async () => {
    h.prepareSave.mockResolvedValueOnce(null);
    h.pluginMessage.mockResolvedValue("Save");
    await requestClose();
    expect(h.emitted).not.toContain("BEFORE_CLOSE");
    expect(h.writePreparedSave).not.toHaveBeenCalled();
    expect(h.destroy).not.toHaveBeenCalled();
  });

  it("a preparation that throws keeps the window open and tears nothing down", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.prepareSave.mockRejectedValueOnce(new Error("backend gone"));
    h.pluginMessage.mockResolvedValue("Save");
    await requestClose();
    expect(h.emitted).not.toContain("BEFORE_CLOSE");
    expect(h.destroy).not.toHaveBeenCalled();
  });
});

// E8 (2): the teardown's ASYNC work is awaited before the write and before the
// window goes (@api/lifecycleGuards registerClosePreparation).
describe("the close AWAITS every close preparation (E8)", () => {
  it("Save: the file is not written until the preparations have finished", async () => {
    const held = heldPreparation();
    h.pluginMessage.mockResolvedValue("Save");
    const closing = requestClose();
    await drain();

    expect(held.ran(), "the preparation never ran").toBe(true);
    expect(h.writePreparedSave, "the file was written before the recording was stored").not.toHaveBeenCalled();
    held.finish();
    await closing;
    expect(h.writePreparedSave).toHaveBeenCalledTimes(1);
    expect(h.destroy).toHaveBeenCalledTimes(1);
  });

  it("the preparations run AFTER BEFORE_CLOSE (its listeners start the work they await)", async () => {
    const order: string[] = [];
    h.onBeforeClose.push(() => order.push("teardown"));
    registerClosePreparation("test: order", () => {
      order.push("prepare");
    });
    h.pluginMessage.mockResolvedValue("Don't Save");
    await requestClose();
    expect(order).toEqual(["teardown", "prepare"]);
  });

  it("Don't Save: the window is not destroyed until the preparations have finished", async () => {
    const held = heldPreparation();
    h.pluginMessage.mockResolvedValue("Don't Save");
    const closing = requestClose();
    await drain();
    expect(h.destroy).not.toHaveBeenCalled();
    held.finish();
    await closing;
    expect(h.destroy).toHaveBeenCalledTimes(1);
  });

  it("a clean document: the handler (which the native close waits on) resolves only after them", async () => {
    h.isFileModified.mockResolvedValue(false);
    const held = heldPreparation();
    let resolved = false;
    const closing = requestClose().then(() => {
      resolved = true;
    });
    await drain();
    expect(resolved).toBe(false);
    held.finish();
    await closing;
    expect(resolved).toBe(true);
  });

  it("a preparation that throws never keeps the window open", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    registerClosePreparation("test: broken", () => {
      throw new Error("recorder store gone");
    });
    h.pluginMessage.mockResolvedValue("Save");
    await requestClose();
    expect(h.writePreparedSave).toHaveBeenCalledTimes(1);
    expect(h.destroy).toHaveBeenCalledTimes(1);
  });

  it("control: Cancel runs no preparation", async () => {
    const held = heldPreparation();
    h.pluginMessage.mockResolvedValue("Cancel");
    await requestClose();
    expect(held.ran()).toBe(false);
  });
});

// The script host registers ONE lifecycle guard per mounted script that declared
// onBeforeSave, and the BEFORE_CLOSE teardown unmounts it -- guard included. So
// a Save chosen on the close prompt must ask the Before-Save vetoes while the
// scripts are still there (VBA's Workbook_BeforeSave fires for it too) --
// prepareSave does, before the teardown.
describe("Save on the close prompt asks every Before-Save veto first", () => {
  it("a script's veto is heard, and it keeps the window open with nothing torn down", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const guard = mountScriptGuard((action) =>
      action === "save" ? { by: "Totals", reason: "Fill in the total first" } : null,
    );
    h.pluginMessage.mockResolvedValue("Save");
    await requestClose();

    expect(guard).toHaveBeenCalledWith("save", { path: SAVED_PATH, kind: "save" });
    expect(h.writePreparedSave).not.toHaveBeenCalled();
    expect(h.destroy).not.toHaveBeenCalled();
    expect(h.emitted).not.toContain("BEFORE_CLOSE");
    // The refusal is attributed to the script, never a silent no-op.
    expect(String(warnings.mock.calls[0]?.[0])).toContain('Script "Totals" cancelled the save');

    await requestClose();
    expect(h.pluginMessage).toHaveBeenCalledTimes(2);
  });

  it("an allowing script is asked exactly once, before the teardown, and the save goes ahead", async () => {
    const guard = mountScriptGuard(() => null);
    h.pluginMessage.mockResolvedValue("Save");
    await requestClose();

    const saveVerdicts = guard.mock.calls
      .map((call, i) => ({ call, order: guard.mock.invocationCallOrder[i] }))
      .filter(({ call }) => call[0] === "save");
    expect(saveVerdicts.map(({ call }) => call)).toEqual([
      ["save", { path: SAVED_PATH, kind: "save" }],
    ]);
    expect(saveVerdicts[0].order).toBeLessThan(beforeCloseOrder());
    expect(h.writePreparedSave).toHaveBeenCalledTimes(1);
    expect(h.destroy).toHaveBeenCalledTimes(1);
  });

  it("an untitled workbook's veto is asked as a Save As of the picked path, before the teardown", async () => {
    h.getCurrentFilePath.mockResolvedValue(null);
    const guard = mountScriptGuard(() => null);
    h.pluginMessage.mockResolvedValue("Save");
    await requestClose();

    expect(guard).toHaveBeenCalledWith("save", { path: "C:/Books/Picked.cala", kind: "saveAs" });
    expect(guard.mock.invocationCallOrder[0]).toBeLessThan(beforeCloseOrder());
    expect(h.writePreparedSave).toHaveBeenCalledWith({ path: "C:/Books/Picked.cala", kind: "saveAs" });
    expect(h.destroy).toHaveBeenCalledTimes(1);
  });

  it("a file path that cannot be read keeps the window open and broadcasts nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.getCurrentFilePath.mockRejectedValueOnce(new Error("backend gone"));
    h.pluginMessage.mockResolvedValue("Save");
    await requestClose();

    expect(h.writePreparedSave).not.toHaveBeenCalled();
    expect(h.destroy).not.toHaveBeenCalled();
    expect(h.emitted).not.toContain("BEFORE_CLOSE");

    await requestClose();
    expect(h.pluginMessage).toHaveBeenCalledTimes(2);
  });
});
