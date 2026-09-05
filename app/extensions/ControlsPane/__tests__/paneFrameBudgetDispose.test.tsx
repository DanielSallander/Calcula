//! FILENAME: app/extensions/ControlsPane/__tests__/paneFrameBudgetDispose.test.tsx
// PURPOSE: That tearing the pane's wiring down hands back the live-frame budget
//          the pane's cards were holding.
// CONTEXT: The frame budget is ONE cap of 24 shared with the on-grid host, and
//          it is per SESSION — nothing ever reset it per document, so a charge
//          nobody releases is a slot no workbook gets back. Each card releases
//          its own slot on React unmount, which covers the ordinary case;
//          `disposeCustomControlWiring` (the extension's deactivate) cleared
//          `paneFrames` and released nothing, so a teardown that takes the pane
//          out WITHOUT unmounting the React tree left the charge standing with
//          no id left to release it under.

/* eslint-disable @typescript-eslint/naming-convention --
 * The doubles below stand in for React components and a singleton class, whose
 * real names are PascalCase because that is what JSX and the module's own
 * imports require; a camelCase double would simply not be the export the card
 * imports. */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// The card is a leaf of the pane's own layout and script plumbing; none of it
// decides anything this test asserts, so it is doubled down to what renders.
// `@api/events` is deliberately NOT doubled: the card's html arrives over the
// real `shape:setHtmlContent` event, which is how a script gives a pane control
// something to render and therefore how the card comes to hold a frame at all.
vi.mock("@api", () => ({
  getShapeBitmap: () => null,
  hasShapeBitmapRenderer: () => false,
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
    registerScript: () => undefined,
    mountScript: async () => undefined,
  },
}));
vi.mock("@api/objectScriptBackend", () => ({ saveObjectScript: async () => undefined }));
vi.mock("../lib/controlsPaneStore", () => ({
  commitValue: async () => undefined,
  getControlById: () => null,
  updateControlAsync: async () => undefined,
}));

import { emitAppEvent } from "@api/events";
import {
  CustomControlHost,
  disposeCustomControlWiring,
  ensureCustomControlWiring,
  paneControlInstanceId,
  removeCustomControlRuntime,
} from "../components/CustomControlHost";
import {
  resetScriptFrameBudget,
  scriptFrameBudgetUsage,
} from "../../_shared/scriptFrame";
import type { PaneControl } from "../lib/controlsPaneTypes";

const CONTROL: PaneControl = {
  id: "pane-control-1",
  name: "Live tile",
  controlType: "custom",
  order: 0,
} as PaneControl;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetScriptFrameBudget();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  removeCustomControlRuntime(CONTROL.id);
  resetScriptFrameBudget();
  document.body.innerHTML = "";
});

/** Render the card with html its script has produced — the state in which it
 *  holds a frame, and therefore a budget slot. */
function renderCard(): void {
  // The wiring the card's own effect installs, installed first so the event
  // below is heard: the script may well have rendered before the pane opened.
  ensureCustomControlWiring();
  act(() => {
    emitAppEvent("shape:setHtmlContent", {
      instanceId: paneControlInstanceId(CONTROL.id),
      html: "<button>Save</button>",
    });
    root.render(React.createElement(CustomControlHost, { control: CONTROL }));
  });
}

describe("disposing the pane's custom-control wiring", () => {
  it("hands back the frame budget its cards were holding", () => {
    renderCard();
    expect(host.querySelector("iframe")).not.toBeNull();
    expect(scriptFrameBudgetUsage().frames).toBe(1);

    // The extension deactivating without React unmounting the tree.
    disposeCustomControlWiring();

    expect(scriptFrameBudgetUsage()).toEqual({ frames: 0, bytes: 0 });
  });
});
