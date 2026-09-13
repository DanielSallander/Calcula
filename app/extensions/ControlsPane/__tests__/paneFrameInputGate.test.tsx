//! FILENAME: app/extensions/ControlsPane/__tests__/paneFrameInputGate.test.tsx
// PURPOSE: That a pane card PAINTS a script's HTML under `ui.html` and takes
//          none of the user's input until the script claims it under
//          `ui.htmlInput` — the second half of the M6b split, on the second
//          host.
// CONTEXT: The split was written for the on-grid host, whose frame is
//          `pointer-events: none` forever and where every pixel of input
//          arrives through the shims `render.setHitRegions` creates. This card
//          renders the SAME script's SAME document, and its iframe style
//          hardcoded `pointerEvents: "auto"` — so a subscribed .calp carrying a
//          pane control whose script declared only `// @capability ui.html`
//          painted `<input type=password>` inside Calcula's own chrome, and the
//          user's clicks, focus and keystrokes went to a distributed author's
//          page under a grant whose sentence promises drawing. Nothing in
//          extensions/ControlsPane consulted a capability at all, and
//          htmlInputConsentHonesty.test.ts watched the id's prose, its Rust
//          mirror and its allowlist rows — never whether the second host
//          honoured the split.
//
//          WHY THE CLAIM IS THE EVIDENCE. This host reads no capability itself,
//          exactly like the on-grid one: `render.setHitRegions` is broker-gated
//          on `ui.htmlInput` (allowlist.ts), so the arrival of the event is
//          proof the grant was made. What the pane does with the RECTANGLES is
//          the one deliberate difference — a card has no grid under it and is
//          laid out by the pane, so any non-empty claim takes the whole card
//          and `[]` hands it straight back.
//
//          TWO INPUT DEVICES, ONE GATE. Hit-transparency was the first half of
//          the fix and only the first half: an iframe keeps its place in the tab
//          order however it is styled, so the same password field was still
//          reachable with Tab and still reported what was typed. So each case
//          below asserts the frame's `inert` attribute beside its
//          `pointer-events` — the two must never be able to disagree, because
//          the consent sentence names clicking and typing in one breath.

/* eslint-disable @typescript-eslint/naming-convention --
 * The doubles below stand in for React components and a singleton class, whose
 * real names are PascalCase because that is what JSX and the module's own
 * imports require; a camelCase double would simply not be the export the card
 * imports. */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// Same doubles as paneFrameBudgetDispose.test.tsx: the card's layout and script
// plumbing decide nothing this test asserts. `@api/events` and
// `@api/scriptHost/shapeHitRegionSpec` are deliberately NOT doubled — the html
// and the claim both arrive over the real app events a script host emits, which
// is the whole path under test.
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
  SHAPE_HIT_REGIONS_EVENT,
  type ShapeHitRegion,
} from "@api/scriptHost/shapeHitRegionSpec";
import {
  CustomControlHost,
  disposeCustomControlWiring,
  ensureCustomControlWiring,
  paneControlInstanceId,
  removeCustomControlRuntime,
} from "../components/CustomControlHost";
import { resetScriptFrameBudget } from "../../_shared/scriptFrame";
import type { PaneControl } from "../lib/controlsPaneTypes";

const CONTROL: PaneControl = {
  id: "pane-control-1",
  name: "Session tile",
  controlType: "custom",
  order: 0,
} as PaneControl;

/** The finding's own payload: a credential prompt drawn inside Calcula's chrome
 *  by a script that declared nothing but `ui.html`. */
const PHISH =
  "<div>Session expired.<br>Password: <input type=password id=p>" +
  "<button onclick=\"calcula.sendMessage('k', p.value)\">Unlock</button></div>";

const FULL_CARD: ShapeHitRegion[] = [{ id: "card", x: 0, y: 0, width: 2000, height: 2000 }];

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
  // Drops the module wiring AND the runtimes, so a claim made in one test can
  // never be the reason the next one is interactive.
  disposeCustomControlWiring();
  removeCustomControlRuntime(CONTROL.id);
  resetScriptFrameBudget();
  document.body.innerHTML = "";
});

/** Render the card with the html its script produced — the state in which it
 *  holds a frame at all. */
function renderCard(): void {
  ensureCustomControlWiring();
  act(() => {
    emitAppEvent("shape:setHtmlContent", {
      instanceId: paneControlInstanceId(CONTROL.id),
      html: PHISH,
    });
    root.render(React.createElement(CustomControlHost, { control: CONTROL }));
  });
}

function frame(): HTMLIFrameElement {
  const el = host.querySelector("iframe");
  expect(el, "the card painted no frame at all").not.toBeNull();
  return el as HTMLIFrameElement;
}

/** What `render.setHitRegions` emits, for `instanceId` (the card's, unless a
 *  test names someone else's). */
function claim(regions: ShapeHitRegion[], instanceId = paneControlInstanceId(CONTROL.id)): void {
  act(() => {
    emitAppEvent(SHAPE_HIT_REGIONS_EVENT, { instanceId, regions });
  });
}

describe("a pane card whose script holds only ui.html", () => {
  it("paints the document and takes none of the user's input", () => {
    renderCard();
    // The frame really is on the card — this is a paint-only frame, not a frame
    // that failed to render. It is asserted through `src` rather than `srcdoc`
    // since BUG-0113: the document is the loader, fetched from Rust so it
    // carries its own CSP, and the script's HTML is PUSHED into it once the
    // loader announces itself. That handshake does not happen in jsdom, so what
    // reaches the body is covered where it belongs — the delivery tests in
    // `_shared/scriptFrame/__tests__/scriptFrameLoader.test.ts`. What matters
    // HERE is that the card built a frame for this instance at all, because the
    // input-gate assertions below are meaningless against a frame that is
    // missing.
    expect(frame().getAttribute("srcdoc")).toBeNull();
    expect(frame().getAttribute("src")).toContain(
      encodeURIComponent(paneControlInstanceId(CONTROL.id)),
    );
    // ...and it is hit-transparent, so the field cannot be clicked into or
    // selected in. `auto` here is the defect: every click would land in a
    // distributed author's page under a grant whose sentence says "render
    // custom HTML UI".
    expect(frame().style.pointerEvents).toBe("none");
  });

  it("is out of the tab order too — the mouse gate is half a gate", () => {
    renderCard();
    // THE OTHER INPUT DEVICE. `pointer-events: none` is a hit-testing property
    // and nothing else: an iframe keeps its place in the sequential focus order
    // however it is styled, so Tab walked off the card and into the password
    // field above, and `calcula.sendMessage('k', p.value)` shipped what was
    // typed to the script — the finding's exact failure scenario, arriving by
    // keyboard instead of by mouse, under `ui.html` alone. `inert` on the frame
    // makes the document inside it inert as well, which is what actually
    // removes the field from the tab order; `tabindex="-1"` would not have (it
    // takes out the ELEMENT and leaves its document's focusable areas).
    expect(frame().hasAttribute("inert")).toBe(true);
  });

  it("stays hit-transparent when ANOTHER instance claims input", () => {
    renderCard();
    // An on-grid shape's claim travels the same app event. It belongs to
    // Controls/index.ts, which applies its rectangles literally; it must not
    // unlock a pane card, and a pane card must not unlock its neighbour.
    claim(FULL_CARD, "control-4-2");
    expect(frame().style.pointerEvents).toBe("none");
    expect(frame().hasAttribute("inert")).toBe(true);
    claim(FULL_CARD, paneControlInstanceId("some-other-control"));
    expect(frame().style.pointerEvents).toBe("none");
    expect(frame().hasAttribute("inert")).toBe(true);
  });
});

describe("a pane card whose script claims input", () => {
  it("becomes interactive on the claim the broker gates with ui.htmlInput", () => {
    renderCard();
    claim(FULL_CARD);
    expect(frame().style.pointerEvents).toBe("auto");
    // Both devices, on one claim. A card that took the mouse but stayed inert
    // would be a text box nobody can type in; a card that took the keyboard
    // while hit-transparent would be input the user cannot see they are giving.
    // The consent sentence names clicking AND typing, so the gate has to move
    // them together.
    expect(frame().hasAttribute("inert")).toBe(false);
  });

  it("is claimed WHOLE, because a pane rectangle measures nothing", () => {
    renderCard();
    // One pixel in the corner is still a claim on the card: the numbers are
    // frame-local grid geometry and the pane lays the card out itself, so the
    // pane honours the decision and never the rectangle.
    claim([{ id: "dot", x: 0, y: 0, width: 1, height: 1 }]);
    expect(frame().style.pointerEvents).toBe("auto");
  });

  it("hands the card back on release — which is also what an unmount sends", () => {
    renderCard();
    claim(FULL_CARD);
    expect(frame().style.pointerEvents).toBe("auto");
    // `[]` is both a script's own release and the message the script host emits
    // when the script unmounts, so a card cannot stay interactive for code that
    // is gone.
    claim([]);
    expect(frame().style.pointerEvents).toBe("none");
    // ...including the keyboard: an unmounted script whose frame is still
    // painted must not keep a focusable password field on the card.
    expect(frame().hasAttribute("inert")).toBe(true);
  });
});
