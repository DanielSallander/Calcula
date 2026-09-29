//! FILENAME: app/extensions/ControlsPane/__tests__/paneControlsFollowSheetChanges.test.ts
// PURPOSE: The pane-control cache is re-read when the SHEET COLLECTION changes
//          (a rename, a delete, a move, an add -- from any direction) and when
//          the active sheet changes.
// CONTEXT: X13 (wave D; wave C sheets fix-up, W7). A rename rewrites every
//          dropdown source that names the sheet ("Data!A1:A5" becomes
//          "'My Facts'!A1:A5", in the backend). The pane re-read its controls
//          only on a "sheet:activated" window event that nothing dispatches,
//          so the open pane kept the OLD source -- whose sheet no longer
//          exists -- until the workbook was reopened.
//
//          The hook is AppEvents.SHEET_CHANGED: the Shell translator fans the
//          `sheets` mutation domain out as it (bootstrap.ts), which every sheet
//          route announces -- the tauri-api wrappers, an MCP tool's
//          backend-initiated `mutation:refresh`, and undo/redo -- and it is
//          also the plain "the active sheet changed" event. The translator's
//          mapping is pinned below from its source, so the premise cannot rot
//          silently.

/* eslint-disable @typescript-eslint/naming-convention --
 * The doubles stand in for the manifest constants, whose real names are
 * SCREAMING_CASE / PascalCase because that is what the module imports. */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

const h = vi.hoisted(() => ({
  refreshControlsCache: vi.fn(async () => undefined),
  refreshCache: vi.fn(async () => undefined),
}));

vi.mock("@api", () => ({
  ExtensionRegistry: { registerAddIn: () => undefined },
}));
vi.mock("@api/ui", () => ({
  registerPanel: () => undefined,
  unregisterPanel: () => undefined,
}));
vi.mock("@api/controlValues", () => ({ registerControlValuesProvider: () => undefined }));
vi.mock("@api/componentStoreRegistry", () => ({ registerPaneControlStoreService: () => undefined }));
vi.mock("@api/objectGeometry", () => ({ refuseUndoWhileAGestureLands: () => () => undefined }));
vi.mock("@api/scriptableObjects", () => ({
  ObjectScriptManager: { getAllScripts: () => [], removeScript: () => undefined },
}));
vi.mock("@api/objectScriptBackend", () => ({ deleteObjectScriptsForInstance: async () => undefined }));
vi.mock("../manifest", () => ({
  ControlsPaneManifest: { id: "calcula.controlspane", name: "Controls Pane", version: "1.0.0", description: "double" },
  ControlsPanePanelDefinition: { id: "controls-pane" },
  AddFilterDialogDefinition: { id: "add-filter" },
  AddControlDialogDefinition: { id: "add-control" },
  CONTROLS_PANE_TAB_ID: "controls-pane",
}));
vi.mock("../lib/filterPaneStore", () => ({
  refreshCache: h.refreshCache,
  clearCache: () => undefined,
  isRibbonFilterChangeLanding: () => false,
  refreshCacheAndReapplyChangedFilters: async () => [],
}));
vi.mock("../lib/controlsPaneStore", () => ({
  refreshControlsCache: h.refreshControlsCache,
  clearControlsCache: () => undefined,
  getAllControls: () => [],
  getControlById: () => null,
  buildNamedControlList: () => [],
}));
vi.mock("../lib/filterBadge", () => ({ registerFilterBadge: () => () => undefined }));
vi.mock("../lib/filterPaneBackend", () => ({ filterPaneBackend: { set: () => undefined } }));
vi.mock("../components/CustomControlHost", () => ({
  ensureCustomControlWiring: () => undefined,
  disposeCustomControlWiring: () => undefined,
  releaseAllPaneControlFrames: () => undefined,
  seedCustomControlRuntime: () => undefined,
  getCustomControlProperties: () => undefined,
  removeCustomControlRuntime: () => undefined,
  paneControlInstanceId: (id: string) => `pane-${id}`,
}));

import { AppEvents, emitAppEvent } from "@api/events";
import type { ExtensionContext } from "@api/contract";
import ControlsPaneExtension from "../index";

const CONTEXT = {
  invokeBackend: async () => undefined,
  ui: { dialogs: { register: () => undefined } },
} as unknown as ExtensionContext;

/** Re-reads of the pane-control cache since the last reset. */
function rereads(): number {
  return h.refreshControlsCache.mock.calls.length;
}

beforeEach(() => {
  ControlsPaneExtension.activate?.(CONTEXT);
  h.refreshControlsCache.mockClear();
  h.refreshCache.mockClear();
});

afterEach(() => {
  ControlsPaneExtension.deactivate?.();
});

describe("the pane re-reads its controls when the sheet collection changes", () => {
  it("the `sheets` domain's fan-out (a rename or delete, from any direction) re-reads the controls", () => {
    // Exactly what the Shell translator dispatches for the `sheets` domain:
    // the bare window event, with no detail.
    window.dispatchEvent(new CustomEvent(AppEvents.SHEET_CHANGED));
    expect(rereads(), "a renamed sheet's dropdown sources stayed stale in the open pane").toBe(1);
  });

  it("a plain sheet switch re-reads them too (a source with no sheet prefix reads the ACTIVE sheet)", () => {
    emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: 1, sheetName: "Data" });
    expect(rereads()).toBe(1);
  });

  it("deactivate takes the listener away", () => {
    ControlsPaneExtension.deactivate?.();
    window.dispatchEvent(new CustomEvent(AppEvents.SHEET_CHANGED));
    expect(rereads()).toBe(0);
    ControlsPaneExtension.activate?.(CONTEXT);
    h.refreshControlsCache.mockClear();
  });
});

describe("the premise: the Shell fans the `sheets` domain out as SHEET_CHANGED", () => {
  it("bootstrap.ts maps `sheets` to AppEvents.SHEET_CHANGED", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../../src/shell/bootstrap.ts"), "utf8");
    const noComments = src
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
    expect(noComments).toMatch(/\bsheets:\s*\[[^\]]*AppEvents\.SHEET_CHANGED[^\]]*\]/);
  });
});
