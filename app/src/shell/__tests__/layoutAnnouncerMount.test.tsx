//! FILENAME: app/src/shell/__tests__/layoutAnnouncerMount.test.tsx
// PURPOSE: The shell mounts the app's polite live region exactly ONCE, and
//          @api/announce reaches it through the real Layout (M8 S6).
// CONTEXT: With no region mounted, `announce()` is a silent no-op by design
//          (before the shell mounts, in unit tests) -- so a Layout that lost
//          the mount would leave every keyboard announcement unheard with no
//          error anywhere. Only the mount itself is proved here: everything
//          else Layout renders is reduced to nothing, the way
//          layoutClosePrompt.test.tsx reduces it. The region and the seam are
//          REAL.

// The module doubles below must export the REAL (PascalCase) names Layout imports.
/* eslint-disable @typescript-eslint/naming-convention */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const h = vi.hoisted(() => ({
  gridContext: { state: { selection: null, displayFormulaBar: true }, dispatch: () => {} },
}));

// ---- the native window, the dialog plugin, the document -----------------------
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async () => () => {},
    destroy: () => {},
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: async () => "", confirm: async () => false }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => undefined }));
vi.mock("../../core/lib/file-api", () => ({
  updateWindowTitle: () => {},
  isFileModified: async () => false,
  prepareSave: async () => null,
  writePreparedSave: async () => {},
  getCurrentFilePath: async () => null,
}));
vi.mock("../../api/lifecycleGuards", () => ({ runClosePreparations: async () => {} }));
vi.mock("../../api/dialogs", () => ({ askSaveDiscardCancelAsync: async () => "cancel" }));

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
  emitAppEvent: () => {},
  checkLifecycleGuards: async () => null,
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
import { ANNOUNCE_SETTLE_MS } from "../Announcer";
import { announce } from "../../api/announce";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Layout mounts the app's polite live region", () => {
  it("renders exactly one announcer region, and @api/announce reaches it", async () => {
    act(() => {
      root.render(<Layout />);
    });
    const regions = host.querySelectorAll<HTMLElement>("[data-testid='app-announcer']");
    expect(regions, "Layout must mount the announcer exactly once").toHaveLength(1);
    expect(regions[0].getAttribute("role")).toBe("status");
    expect(regions[0].getAttribute("aria-live")).toBe("polite");

    announce("North, selected, 2 of 5");
    // The region writes once it has settled (Announcer.tsx ANNOUNCE_SETTLE_MS).
    await new Promise<void>((resolve) => setTimeout(resolve, ANNOUNCE_SETTLE_MS + 30));
    expect(regions[0].textContent).toBe("North, selected, 2 of 5");
  });
});
