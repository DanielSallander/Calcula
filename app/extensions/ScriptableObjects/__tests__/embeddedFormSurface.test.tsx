//! FILENAME: app/extensions/ScriptableObjects/__tests__/embeddedFormSurface.test.tsx
// PURPOSE: The trusted renderer for a form EMBEDDED on a sheet (M3c) in jsdom:
//          that it paints the ONE shared widget tree, that its identity band is
//          host-derived, that a script cannot dismiss it, and — the state no
//          other surface has — that an ORPHAN is VISIBLE rather than a box that
//          quietly stopped painting.
// CONTEXT: react-dom + act, like scriptPaneSection.test.tsx
//          (@testing-library/react is not installed here). The surface is
//          driven by the SAME `ScriptPaneStore` the task pane uses, which is
//          itself the claim: if someone gives the embedded surface its own
//          state container, these tests keep passing only for as long as the
//          two containers agree — which is why scriptPaneSharedTree.test.ts
//          reads the source as well.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EMBEDDED_FORM_ORPHAN_REMEDY } from "@api/scriptHost/embeddedFormPlacements";
import type { FormSpec } from "@api/scriptHost/scriptFormSpec";
import type { ScriptPaneInputPayload, ScriptPaneRequestPayload } from "@api/scriptHost/scriptPaneSpec";
import { createScriptPaneStore, type ScriptPaneStore } from "../lib/scriptPaneStore";
import { ScriptEmbeddedFormView } from "../components/scriptEmbed";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const PANE_ID = "pane-11";
const PLACEMENT_ID = "9f1c2b7a-1111-2222-3333-444455556666";

function spec(): FormSpec {
  return {
    title: "Order details",
    description: "Fill this in on the sheet.",
    children: [
      { type: "label", name: "intro", text: "Order", style: "heading" },
      { type: "textbox", name: "customer", label: "Customer" },
      { type: "number", name: "amount", label: "Amount", min: 0 },
      { type: "dropdown", name: "tier", label: "Tier", options: ["gold", "silver"] },
      { type: "checkbox", name: "agree", label: "I agree" },
      { type: "button", name: "recalc", text: "Recalculate" },
      { type: "button", name: "dismiss", text: "Done", role: "cancel" },
    ],
  };
}

function request(over: Partial<ScriptPaneRequestPayload> = {}): ScriptPaneRequestPayload {
  return {
    paneId: PANE_ID,
    paneKey: PLACEMENT_ID,
    scriptId: "script-1",
    scriptName: "Order entry",
    origin: { kind: "local" },
    spec: spec(),
    seeds: { amount: { value: 1234.5, display: "1234.5" } },
    embedPlacementId: PLACEMENT_ID,
    open: false,
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root | null = null;
let inputs: ScriptPaneInputPayload[] = [];
let store: ScriptPaneStore;

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}

async function render(element: React.ReactElement): Promise<void> {
  await act(async () => {
    root!.render(element);
  });
  await settle();
}

async function mountOpen(req: ScriptPaneRequestPayload = request()): Promise<void> {
  store = createScriptPaneStore(req, (p) => inputs.push(p));
  await render(
    React.createElement(ScriptEmbeddedFormView, {
      placementId: PLACEMENT_ID,
      state: { kind: "open", store },
      badge: null,
      width: 320,
    }),
  );
}

function q<T extends HTMLElement = HTMLElement>(selector: string): T {
  const el = container.querySelector<T>(selector);
  if (!el) throw new Error(`no element for ${selector}`);
  return el;
}
function maybe<T extends HTMLElement = HTMLElement>(selector: string): T | null {
  return container.querySelector<T>(selector);
}
function widget<T extends HTMLElement = HTMLElement>(name: string): T {
  return q<T>(`[data-form-widget="${name}"]`);
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  inputs = [];
});

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  container.remove();
  vi.restoreAllMocks();
});

// ----------------------------------------------------------------------------
// It paints the ONE tree
// ----------------------------------------------------------------------------

describe("an embedded form paints the shared widget tree", () => {
  it("renders every widget the spec describes, seeded from the host's seeds", async () => {
    await mountOpen();
    // The widgets carry `data-form-widget`, which is FormWidgetTree's own
    // attribute — the surface has no widget arms of its own to give them one.
    expect(widget("customer")).toBeTruthy();
    expect(widget<HTMLInputElement>("amount").value).toBe("1234.5");
    expect(widget("tier")).toBeTruthy();
    expect(widget("agree")).toBeTruthy();
    expect(widget("recalc")).toBeTruthy();
  });

  it("reports a user edit through the shared store, once", async () => {
    await mountOpen();
    const input = widget<HTMLInputElement>("customer");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "Acme");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    const changes = inputs.filter((i) => i.kind === "change");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ paneId: PANE_ID, name: "customer", value: "Acme" });
  });

  it("does NOT report visibility from its own mount — the layer owns that signal", async () => {
    await mountOpen();
    // The task pane's section reports here, and this surface deliberately does
    // not. "visible"/"hidden" arm and tear down the host's bound-cell watch, and
    // this component is NOT mounted exactly while the placement is painted: the
    // layer hides a scrolled-away surface with `display: none`, which unmounts
    // no React tree, so a mount-driven report armed the watch once and never
    // took it down — a form scrolled out of the viewport went on re-reading its
    // bound cells (one audit entry each) and announcing them to the script.
    expect(inputs.filter((i) => i.kind === "visible")).toEqual([]);
    await act(async () => root!.unmount());
    root = null;
    expect(inputs.filter((i) => i.kind === "hidden")).toEqual([]);
  });

  it("lands a host patch through the shared body — values, controls and the script's message", async () => {
    await mountOpen();
    await act(async () => {
      store.applyPatch({ patch: { values: { customer: "Beta" }, message: { text: "saved", kind: "info" } } });
    });
    await settle();
    expect(widget<HTMLInputElement>("customer").value).toBe("Beta");
    expect(q("[data-script-embed-message]").textContent).toContain("saved");
    // A patch echoes nothing back to the host.
    expect(inputs.filter((i) => i.kind === "change")).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------------
// The chrome, and what a script cannot do to it
// ----------------------------------------------------------------------------

describe("the identity band is host chrome", () => {
  it("names the script and where it came from, and the script's title is BODY content", async () => {
    await mountOpen();
    const band = q("[data-script-embed-band]");
    expect(band.textContent).toContain("Order entry");
    expect(band.textContent).toContain("a script in this workbook");
    // The script's own title must never appear in the band — that is the
    // impersonation the band exists to prevent.
    expect(band.textContent).not.toContain("Order details");
    expect(q("[data-script-embed-title]").textContent).toBe("Order details");
  });

  it("says the PACKAGE for a distributed script, and branches on kind, never on a name", async () => {
    await mountOpen(request({ origin: { kind: "package", name: "local" } }));
    // A package literally named "local" still reads as a package.
    expect(q("[data-script-embed-band]").textContent).toContain('the package "local"');
  });

  it("names the pinned sheet when the bindings are pinned to one", async () => {
    await mountOpen(request({ pinnedSheetName: "Sheet1" }));
    expect(q("[data-script-embed-band]").textContent).toContain("Sheet: Sheet1");
  });

  it("has NO close affordance: the object belongs to the sheet, and the user removes it there", async () => {
    await mountOpen();
    expect(maybe("[data-script-pane-close]")).toBeNull();
    expect(container.querySelectorAll("button[aria-label*='Close']").length).toBe(0);
    // ...and a `role: "cancel"` button is an ordinary click, not a dismiss:
    // treating it as one would leave a dead box the user cannot remove.
    await act(async () => {
      widget("dismiss").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(inputs.filter((i) => i.kind === "close")).toHaveLength(0);
    expect(inputs.filter((i) => i.kind === "click").map((i) => i.name)).toEqual(["dismiss"]);
  });

  it("paints a host notice in its own slot, above the script's message", async () => {
    await mountOpen();
    await act(async () => {
      store.setHostBanner({ text: "This script is being slowed down.", kind: "warning" });
      store.applyPatch({ patch: { message: { text: "all good", kind: "info" } } });
    });
    await settle();
    const banner = q("[data-script-embed-host-banner]");
    expect(banner.textContent).toContain("being slowed down");
    // The script's message did not replace it: two slots, two owners.
    expect(q("[data-script-embed-message]").textContent).toContain("all good");
  });

  it("paints the script's badge in the band — an embedded surface has no tab to carry one", async () => {
    store = createScriptPaneStore(request(), (p) => inputs.push(p));
    await render(
      React.createElement(ScriptEmbeddedFormView, {
        placementId: PLACEMENT_ID,
        state: { kind: "open", store },
        badge: "3",
        width: 320,
      }),
    );
    expect(q("[data-script-embed-badge]").textContent).toBe("3");
  });
});

// ----------------------------------------------------------------------------
// The two inert states — the ones a blank box would hide
// ----------------------------------------------------------------------------

describe("an orphan is VISIBLE", () => {
  it("says the anchor was deleted, names what the user can do, and paints no widgets", async () => {
    await render(
      React.createElement(ScriptEmbeddedFormView, {
        placementId: PLACEMENT_ID,
        state: { kind: "orphaned", scriptName: "Order entry" },
        badge: null,
        width: 320,
      }),
    );
    const notice = q("[data-script-embed-orphan]");
    expect(notice.textContent).toContain("Order entry");
    expect(notice.textContent).toContain("the cell it was anchored to was deleted");
    // A refusal names what the user can do (the house rule for refusals) — and
    // the something has to EXIST. This card told the user to "drag it onto a
    // cell to put it back" for the whole of M3c while no code could drag it, so
    // the remedy is now the ONE constant the inert sentence and the host's
    // refusal read, and it names the grid-menu items that really are offered on
    // the orphan's anchor cell (embeddedFormUx.test.ts pins that end).
    expect(notice.textContent).toContain(EMBEDDED_FORM_ORPHAN_REMEDY);
    expect(notice.textContent).not.toMatch(/drag/i);
    // No widget tree: an orphan's bindings resolve against cells that now
    // belong to other rows.
    expect(maybe("[data-form-widget]")).toBeNull();
    // ...and it is still THERE. The placement survived; only the session did not.
    expect(q(`[data-script-embed="${PLACEMENT_ID}"]`)).toBeTruthy();
  });

  it("paints a refusal sentence rather than an empty box when the host could not start it", async () => {
    await render(
      React.createElement(ScriptEmbeddedFormView, {
        placementId: PLACEMENT_ID,
        state: {
          kind: "refused",
          scriptName: null,
          reason: "The script for this form is not running. Start it from Code in This File.",
        },
        badge: null,
        width: 320,
      }),
    );
    expect(q("[data-script-embed-refusal]").textContent).toContain("not running");
    expect(maybe("[data-form-widget]")).toBeNull();
  });
});
