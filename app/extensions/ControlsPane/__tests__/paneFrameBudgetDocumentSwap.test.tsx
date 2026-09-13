//! FILENAME: app/extensions/ControlsPane/__tests__/paneFrameBudgetDocumentSwap.test.tsx
// PURPOSE: That File > New / File > Open takes the pane's script frames — and
//          the live-frame budget they hold — with the workbook they belong to.
// CONTEXT: The on-grid host hands its charges back on the document lifecycle
//          (`releaseAllShapeHtmlOverlays`, wired to AFTER_OPEN / AFTER_NEW). The
//          pane host did not, and this extension had no document listener at
//          all: its only refresh triggers are the mutation-domain fan-out and a
//          "sheet:activated" event nothing in the repo dispatches. A card
//          releases its slot when REACT unmounts it, which covers deleting a
//          control and closing the pane — and File > Open unmounts nothing, so
//          the departed workbook's tiles stayed on screen holding their frames.
//
//          The cap is 24 frames for the whole SESSION and it is SHARED with the
//          on-grid host, so those charges are slots no later workbook ever gets.
//          Worse than on-grid: a pane frame is never parked, so nothing could
//          preempt it either — the next workbook's shapes were simply refused,
//          with a sentence ("this workbook already has 24") counting the
//          previous workbook's tiles.
//
//          `paneFrameBudgetDispose.test.tsx` covers the same release reached
//          from the extension's deactivate. This file covers the DOCUMENT
//          lifecycle, and drives it through the real activate() wiring rather
//          than by calling the release directly — the defect was never in the
//          sweep, it was that nothing called one.

/* eslint-disable @typescript-eslint/naming-convention --
 * The doubles below stand in for React components, a singleton class and the
 * manifest constants, whose real names are PascalCase / SCREAMING_CASE because
 * that is what JSX and the modules' own imports require; a camelCase double
 * would simply not be the export the code under test imports. */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// Everything the extension entry point and the card touch on their way to the
// budget, doubled down to what the assertions depend on. `@api/events` is
// deliberately NOT doubled: AFTER_OPEN travels over the real bus, and the card's
// html arrives over the real `shape:setHtmlContent` — those two events ARE the
// scenario.
vi.mock("@api", () => ({
  ExtensionRegistry: { registerAddIn: () => undefined },
  getShapeBitmap: () => null,
  hasShapeBitmapRenderer: () => false,
}));
vi.mock("@api/ui", () => ({
  registerPanel: () => undefined,
  unregisterPanel: () => undefined,
}));
vi.mock("@api/controlValues", () => ({
  registerControlValuesProvider: () => undefined,
}));
vi.mock("@api/componentStoreRegistry", () => ({
  registerPaneControlStoreService: () => undefined,
}));
vi.mock("@api/layout", () => ({
  Button: () => null,
  Stack: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
  StatusText: () => null,
  useSurfaceLayout: () => ({ container: "sidebar" }),
}));
vi.mock("@api/scriptableObjects", () => ({
  ObjectScriptManager: {
    getScript: () => null,
    getAllScripts: () => [],
    registerScript: () => undefined,
    removeScript: () => undefined,
    mountScript: async () => undefined,
  },
}));
vi.mock("@api/objectScriptBackend", () => ({
  saveObjectScript: async () => undefined,
  deleteObjectScriptsForInstance: async () => undefined,
}));
vi.mock("../manifest", () => ({
  ControlsPaneManifest: {
    id: "calcula.controlspane",
    name: "Controls Pane",
    version: "1.0.0",
    description: "test double",
  },
  ControlsPanePanelDefinition: { id: "controls-pane" },
  AddFilterDialogDefinition: { id: "add-filter" },
  AddControlDialogDefinition: { id: "add-control" },
  CONTROLS_PANE_TAB_ID: "controls-pane",
}));
vi.mock("../lib/filterPaneStore", () => ({
  refreshCache: () => undefined,
  clearCache: () => undefined,
}));
vi.mock("../lib/controlsPaneStore", () => ({
  // The entry point's imports...
  refreshControlsCache: async () => undefined,
  clearControlsCache: () => undefined,
  getAllControls: () => [],
  buildNamedControlList: () => [],
  // ...and the card's.
  commitValue: async () => undefined,
  getControlById: () => null,
  updateControlAsync: async () => undefined,
}));
vi.mock("../lib/filterBadge", () => ({ registerFilterBadge: () => () => undefined }));
vi.mock("../lib/filterPaneBackend", () => ({ filterPaneBackend: { set: () => undefined } }));
vi.mock("../lib/controlsPaneEvents", () => ({
  ControlsPaneEvents: { CONTROL_DELETED: "controlspane:control-deleted" },
}));

import { AppEvents, emitAppEvent } from "@api/events";
import type { ExtensionContext } from "@api/contract";
import ControlsPaneExtension from "../index";
import {
  CustomControlHost,
  paneControlInstanceId,
  removeCustomControlRuntime,
} from "../components/CustomControlHost";
import {
  resetScriptFrameBudget,
  scriptFrameBudgetUsage,
} from "../../_shared/scriptFrame";
import type { PaneControl } from "../lib/controlsPaneTypes";

/** A pane control id survives the swap in the worst case: ids are allocated per
 *  document, so the next workbook's first custom control can carry the same one
 *  — which is what makes leftover html a wrong PICTURE and not merely a leak. */
const CONTROL: PaneControl = {
  id: "control-1",
  name: "Revenue tile",
  controlType: "custom",
  order: 0,
} as PaneControl;

const WORKBOOK_A_HTML = "<b>Workbook A revenue</b>";

/** activate() only reads `invokeBackend` and `ui.dialogs.register` off it. */
const CONTEXT = {
  invokeBackend: async () => undefined,
  ui: { dialogs: { register: () => undefined } },
} as unknown as ExtensionContext;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetScriptFrameBudget();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  // The real wiring, installed the way the shell installs it. The AFTER_OPEN
  // subscription under test is one of the listeners this registers.
  ControlsPaneExtension.activate?.(CONTEXT);
});

afterEach(() => {
  act(() => root.unmount());
  ControlsPaneExtension.deactivate?.();
  removeCustomControlRuntime(CONTROL.id);
  resetScriptFrameBudget();
  document.body.innerHTML = "";
});

/** Workbook A's tile: its script has rendered html, so the card holds a frame
 *  and therefore a budget slot.
 *
 *  The card is MOUNTED before the html is emitted, in that order: the card's own
 *  mount effect is what installs the wiring when the extension has not (the
 *  "after deactivate" case below), and an event emitted into a window with no
 *  listener is simply lost — which would make a card with no frame look like a
 *  released one. */
function renderTile(html: string): void {
  act(() => {
    root.render(React.createElement(CustomControlHost, { control: CONTROL }));
  });
  act(() => {
    emitAppEvent("shape:setHtmlContent", {
      instanceId: paneControlInstanceId(CONTROL.id),
      html,
    });
  });
}

/** File > Open. `announceBackendStateReplaced` fans several more events out,
 *  none of which this extension listens to; AFTER_OPEN is the one that matters
 *  and it is emitted by `openFile` (and by `checkoutApplication`) exactly so. */
function openAnotherWorkbook(): void {
  act(() => {
    emitAppEvent(AppEvents.AFTER_OPEN, { path: "C:/books/B.cala" });
  });
}

describe("File > Open with a pane tile on screen", () => {
  it("hands the tile's frame budget back to the next workbook", () => {
    renderTile(WORKBOOK_A_HTML);
    expect(host.querySelector("iframe")).not.toBeNull();
    expect(scriptFrameBudgetUsage().frames).toBe(1);

    openAnotherWorkbook();

    // The charge is gone AND so is the element it stood for — forgetting a
    // charge whose iframe is still in the DOM would be the same fiction in the
    // other direction, so both halves are asserted.
    expect(scriptFrameBudgetUsage()).toEqual({ frames: 0, bytes: 0 });
    expect(host.querySelector("iframe")).toBeNull();
  });

  it("does not paint workbook A's html in a card the new workbook reuses the id of", () => {
    renderTile(WORKBOOK_A_HTML);
    // Workbook A's tile has a frame. Asserted through `src` rather than the old
    // `srcdoc` content since BUG-0113 — the html is pushed to the loader now,
    // and that handshake does not run in jsdom. The property this test is about
    // is unaffected: what must NOT survive the swap is the ELEMENT, and its
    // absence below is what proves the previous workbook's tile is gone.
    expect(host.querySelector("iframe")?.getAttribute("src")).toContain(
      encodeURIComponent(paneControlInstanceId(CONTROL.id)),
    );

    openAnotherWorkbook();

    // The card is still mounted (React unmounts nothing on a document swap) and
    // the control id is the same one — so the ONLY thing standing between the
    // user and the previous workbook's tile is the runtime having left with its
    // document. Its script is re-mounted by ScriptableObjects on this same
    // event and will re-declare if it still exists.
    expect(host.querySelector("iframe")).toBeNull();
  });

  it("also releases on File > New", () => {
    renderTile(WORKBOOK_A_HTML);
    expect(scriptFrameBudgetUsage().frames).toBe(1);

    act(() => {
      emitAppEvent(AppEvents.AFTER_NEW, {});
    });

    expect(scriptFrameBudgetUsage()).toEqual({ frames: 0, bytes: 0 });
    expect(host.querySelector("iframe")).toBeNull();
  });
});

describe("the document listener itself", () => {
  it("is removed on deactivate, so a second activation does not double-release", () => {
    ControlsPaneExtension.deactivate?.();
    renderTile(WORKBOOK_A_HTML);
    // Nothing is listening any more, so the tile keeps its frame: the charge
    // tracks the element, which is still on screen. A listener that outlived
    // deactivate would drop a charge for an iframe React is still rendering.
    openAnotherWorkbook();
    expect(scriptFrameBudgetUsage().frames).toBe(1);
    expect(host.querySelector("iframe")).not.toBeNull();
    // Re-activate so afterEach's deactivate is symmetric.
    ControlsPaneExtension.activate?.(CONTEXT);
  });
});
