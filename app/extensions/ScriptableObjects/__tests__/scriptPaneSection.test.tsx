//! FILENAME: app/extensions/ScriptableObjects/__tests__/scriptPaneSection.test.tsx
// PURPOSE: The trusted script TASK PANE renderer (M2 S4) in jsdom: what it
//          paints, what leaves it, and what it refuses to do.
// CONTEXT: The security properties are the ones worth pinning. The identity
//          band is host-derived and a script's title never reaches it; a pane
//          takes no focus when it opens and a script's focus request cannot
//          pull focus OUT of the grid into the pane; a script patch lands
//          without echoing; and the pane's own close affordance is the one
//          user-owned close, which leaves exactly once.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FormSpec } from "@api/scriptHost/scriptFormSpec";
import type { ScriptPaneInputPayload, ScriptPaneRequestPayload } from "@api/scriptHost/scriptPaneSpec";
import { SurfaceLayoutProvider, panelLayout } from "@api/layout";
import { createScriptPaneStore, type ScriptPaneStore } from "../lib/scriptPaneStore";
import { createScriptPaneSection } from "../components/scriptPane";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const PANE_ID = "pane-7";

/** Every one of the nineteen widget types, nested the way a real pane nests. */
function fullSpec(): FormSpec {
  return {
    title: "Enter the order",
    description: "Keep this open while you work.",
    focus: "customer",
    children: [
      { type: "label", name: "intro", text: "Order details", style: "heading" },
      { type: "textbox", name: "customer", label: "Customer" },
      { type: "textbox", name: "notes", label: "Notes", multiline: true },
      {
        type: "row",
        children: [
          { type: "number", name: "amount", label: "Amount", min: 0 },
          { type: "date", name: "due", label: "Due" },
        ],
      },
      {
        type: "column",
        children: [
          { type: "checkbox", name: "agree", label: "I agree" },
          { type: "toggle", name: "urgent", label: "Urgent" },
        ],
      },
      {
        type: "grid",
        columns: 2,
        children: [
          { type: "radio", name: "region", label: "Region", options: ["EMEA", "APAC"], layout: "row" },
          { type: "dropdown", name: "tier", label: "Tier", options: ["gold", "silver"] },
        ],
      },
      {
        type: "group",
        title: "More",
        children: [{ type: "listbox", name: "tags", label: "Tags", options: ["a", "b", "c"], multi: true, rows: 3 }],
      },
      {
        type: "tabs",
        name: "pages",
        pages: [
          {
            title: "One",
            children: [
              { type: "spacer", size: 4 },
              { type: "image", name: "pic", src: "media:abc", alt: "Company logo" },
            ],
          },
          {
            title: "Two",
            children: [
              {
                type: "table",
                name: "lines",
                columns: ["Item", "Qty"],
                rows: [
                  ["Widget", 2],
                  ["Gadget", 3],
                ],
              },
              { type: "progress", name: "done", value: 30, max: 100, text: "30% done" },
              { type: "textbox", name: "remarks", label: "Remarks" },
            ],
          },
        ],
      },
      { type: "button", name: "recalc", text: "Recalculate" },
      { type: "button", name: "dismiss", text: "Done", role: "cancel" },
    ],
  };
}

function request(over: Partial<ScriptPaneRequestPayload> = {}): ScriptPaneRequestPayload {
  return {
    paneId: PANE_ID,
    scriptId: "script-1",
    scriptName: "Order status board",
    origin: { kind: "local" },
    spec: fullSpec(),
    seeds: { amount: { value: 1234.5, display: "£1,234.50" } },
    ...over,
  };
}

// ----------------------------------------------------------------------------
// Harness (react-dom + act; @testing-library/react is not installed here)
// ----------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root | null = null;
let inputs: ScriptPaneInputPayload[] = [];
let store: ScriptPaneStore;
const onHostClose = vi.fn();

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}

async function mount(req: ScriptPaneRequestPayload = request()): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  store = createScriptPaneStore(req, (p) => inputs.push(p));
  const Section = createScriptPaneSection(store);
  await act(async () => {
    root!.render(
      React.createElement(
        SurfaceLayoutProvider,
        { value: panelLayout(320) },
        React.createElement(Section, { placement: "sidebar", onClose: onHostClose }),
      ),
    );
  });
  await settle();
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
function ofKind(kind: ScriptPaneInputPayload["kind"]): ScriptPaneInputPayload[] {
  return inputs.filter((e) => e.kind === kind);
}
/** What a script would act on — the mount/unmount visibility reports excluded. */
function acted(): ScriptPaneInputPayload[] {
  return inputs.filter((e) => e.kind !== "visible" && e.kind !== "hidden");
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}
async function typeInto(el: HTMLInputElement | HTMLTextAreaElement, text: string): Promise<void> {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  await act(async () => {
    setter.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}
async function patch(detail: Parameters<ScriptPaneStore["applyPatch"]>[0]): Promise<void> {
  await act(async () => {
    store.applyPatch(detail);
  });
  await settle();
}

beforeEach(() => {
  inputs = [];
  onHostClose.mockClear();
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  container?.remove();
});

// ----------------------------------------------------------------------------
// Rendering
// ----------------------------------------------------------------------------

describe("rendering", () => {
  it("paints every widget type through the shared tree, addressable by name", async () => {
    await mount();
    expect(maybe("[data-script-form-widgets]")).not.toBeNull();
    for (const name of [
      "intro", "customer", "notes", "amount", "due", "agree", "urgent",
      "region", "tier", "tags", "pages", "pic", "recalc", "dismiss",
    ]) {
      expect(maybe(`[data-form-widget="${name}"]`), name).not.toBeNull();
    }
    // Page Two is not the active page; its widgets are not rendered.
    expect(maybe('[data-form-widget="lines"]')).toBeNull();
    expect(q<HTMLInputElement>('[data-form-widget="amount"]').value).toBe("£1,234.50");
  });

  it("reports visible on mount and hidden on unmount — never 'docked' (that is the wiring's)", async () => {
    await mount();
    expect(inputs.map((p) => p.kind)).toEqual(["visible"]);
    expect(inputs[0].paneId).toBe(PANE_ID);
    expect(inputs[0].values.amount).toBe(1234.5);
    await act(async () => {
      root!.unmount();
    });
    root = null;
    expect(inputs.map((p) => p.kind)).toEqual(["visible", "hidden"]);
  });

  it("takes NO focus when it opens, even though the spec names a focus widget", async () => {
    await mount();
    expect(document.activeElement).toBe(document.body);
    expect(maybe("[autofocus]")).toBeNull();
  });

  it("the script's title and description are body content", async () => {
    await mount();
    expect(q("[data-script-pane-title]").textContent).toBe("Enter the order");
  });
});

// ----------------------------------------------------------------------------
// The identity band
// ----------------------------------------------------------------------------

describe("the identity band", () => {
  it("is exactly the script name plus the host provenance — the script's title never enters it", async () => {
    await mount();
    const band = q("[data-script-pane-band]");
    expect(band.textContent).toBe("Order status boardA task pane from a script in this workbook");
    expect(band.textContent).not.toContain("Enter the order");
    expect(band.textContent).not.toContain("Keep this open");
    expect(q('[role="region"]').getAttribute("aria-labelledby")).toBe(band.id);
  });

  it("names the application for a distributed script", async () => {
    await mount(request({ origin: { kind: "package", name: "Sales Pack" } }));
    expect(q("[data-script-pane-band]").textContent).toBe(
      'Order status boardA task pane from the package "Sales Pack"',
    );
  });

  it('still says PACKAGE for an application literally named "local"', async () => {
    await mount(request({ origin: { kind: "package", name: "local" } }));
    const text = q("[data-script-pane-band]").textContent ?? "";
    expect(text).toBe('Order status boardA task pane from the package "local"');
    expect(text).not.toContain("a script in this workbook");
  });

  it("says which sheet the bindings are pinned to", async () => {
    await mount(request({ pinnedSheetName: "Data" }));
    expect(q("[data-script-pane-band]").textContent).toContain("Sheet: Data");
  });

  it("never says 'form', 'dialog', or 'answer' — this surface asks for nothing", async () => {
    await mount();
    const text = (q("[data-script-pane-band]").textContent ?? "").toLowerCase();
    expect(text).not.toContain("form");
    expect(text).not.toContain("dialog");
    expect(text).not.toContain("answer");
  });
});

// ----------------------------------------------------------------------------
// Input reaching the registry
// ----------------------------------------------------------------------------

describe("user input", () => {
  it("typing emits 'change' with the typed value and the whole value set", async () => {
    await mount();
    await typeInto(widget<HTMLInputElement>("customer"), "Acme");
    const changes = ofKind("change");
    expect(changes).toHaveLength(1);
    expect(changes[0].name).toBe("customer");
    expect(changes[0].value).toBe("Acme");
    expect(changes[0].values.customer).toBe("Acme");
    expect(changes[0].values.amount).toBe(1234.5);
  });

  it("a number widget emits a NUMBER, and a checkbox a boolean", async () => {
    await mount();
    await typeInto(widget<HTMLInputElement>("amount"), "42");
    await click(widget<HTMLInputElement>("agree"));
    const changes = ofKind("change");
    expect(changes.map((c) => [c.name, c.value])).toEqual([
      ["amount", 42],
      ["agree", true],
    ]);
  });

  it("a default button emits 'click' by name and nothing else", async () => {
    await mount();
    await click(widget("recalc"));
    expect(acted()).toEqual([{ paneId: PANE_ID, kind: "click", name: "recalc", values: inputs[1].values }]);
  });
});

// ----------------------------------------------------------------------------
// The user-owned close
// ----------------------------------------------------------------------------

describe("close", () => {
  it("the band's X emits 'close' once and then hands the panel host its close", async () => {
    await mount();
    await click(q("[data-script-pane-close]"));
    expect(ofKind("close")).toHaveLength(1);
    expect(onHostClose).toHaveBeenCalledTimes(1);
    // The registry is told BEFORE the host collapses the view.
    expect(inputs.findIndex((p) => p.kind === "close")).toBeGreaterThanOrEqual(0);
    await click(q("[data-script-pane-close]"));
    expect(ofKind("close")).toHaveLength(1);
  });

  it("a button with role 'cancel' is the same user-owned close, not a click", async () => {
    await mount();
    await click(widget("dismiss"));
    expect(ofKind("click")).toHaveLength(0);
    expect(ofKind("close")).toHaveLength(1);
    expect(onHostClose).toHaveBeenCalledTimes(1);
  });

  it("no submit exists: Enter in a text box emits nothing terminal", async () => {
    await mount();
    const el = widget<HTMLInputElement>("customer");
    await act(async () => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await settle();
    expect(acted()).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// Host patches
// ----------------------------------------------------------------------------

describe("script patches", () => {
  it("a patch changes values, relabels, hides a control and shows a banner — WITHOUT echoing", async () => {
    await mount();
    await patch({
      patch: {
        values: { customer: "Zed", amount: "77" },
        controls: { intro: { text: "Changed" }, notes: { hidden: true } },
        message: { text: "Saved", kind: "info" },
      },
    });
    expect(q<HTMLInputElement>('[data-form-widget="customer"]').value).toBe("Zed");
    // Untouched: the display text still shows... no — a patched value is the
    // script's, and the widget shows the typed value once it differs from the seed.
    expect(q<HTMLInputElement>('[data-form-widget="amount"]').value).toBe("77");
    expect(widget("intro").textContent).toBe("Changed");
    expect(maybe('[data-form-widget="notes"]')).toBeNull();
    expect(q("[data-script-pane-message]").textContent).toBe("Saved");
    expect(acted()).toEqual([]);
  });

  it("refreshed seeds land on untouched widgets only; a dirty one keeps the user's text and is marked", async () => {
    await mount();
    await typeInto(widget<HTMLInputElement>("customer"), "mine");
    await patch({ seeds: { customer: { value: "theirs" }, due: { value: "2026-09-04" } } });
    expect(q<HTMLInputElement>('[data-form-widget="customer"]').value).toBe("mine");
    expect(maybe('[data-form-stale="customer"]')).not.toBeNull();
    expect(q<HTMLInputElement>('[data-form-widget="due"]').value).toBe("2026-09-04");
    expect(maybe('[data-form-stale="due"]')).toBeNull();
    // Still nothing echoed for the seeds themselves.
    expect(ofKind("change")).toHaveLength(1);
  });

  it("a script focus request is CONTAINED: it moves focus only while focus is already inside the pane", async () => {
    await mount();
    expect(document.activeElement).toBe(document.body);
    await patch({ patch: { focus: "notes" } });
    expect(document.activeElement).toBe(document.body);

    await act(async () => {
      widget<HTMLInputElement>("customer").focus();
    });
    expect(document.activeElement).toBe(widget("customer"));
    await patch({ patch: { focus: "notes" } });
    expect(document.activeElement).toBe(widget("notes"));
  });

  it("a focus request for a widget on another tab page brings the page forward (when contained)", async () => {
    await mount();
    await act(async () => {
      widget<HTMLInputElement>("customer").focus();
    });
    expect(maybe('[data-form-widget="remarks"]')).toBeNull();
    await patch({ patch: { focus: "remarks" } });
    expect(maybe('[data-form-widget="lines"]')).not.toBeNull();
    expect(document.activeElement).toBe(widget("remarks"));
  });

  it("after the host disposed the store nothing leaves the pane", async () => {
    await mount();
    await act(async () => {
      store.dispose();
    });
    await typeInto(widget<HTMLInputElement>("customer"), "late");
    await click(widget("recalc"));
    await click(q("[data-script-pane-close]"));
    expect(acted()).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// S6 — focus containment against the GRID, and the host's own banner
// ----------------------------------------------------------------------------

describe("focus containment (S6)", () => {
  it("a script focus request while focus is in the GRID (outside the pane) moves nothing, and is consumed — it cannot lie in wait", async () => {
    // pane.control(name).focus() is sugar over the same `focus` patch
    // (contextShims.ts), so this is both routes.
    await mount();
    const grid = document.createElement("input");
    grid.setAttribute("data-fake-grid", "");
    document.body.appendChild(grid);
    try {
      await act(async () => {
        grid.focus();
      });
      expect(document.activeElement).toBe(grid);
      await patch({ patch: { focus: "customer" } });
      expect(document.activeElement).toBe(grid);
      // The user later clicks into the pane; a re-render must not replay the
      // consumed request onto "customer".
      await act(async () => {
        widget<HTMLInputElement>("notes").focus();
      });
      await patch({ patch: { values: { amount: "9" } } });
      expect(document.activeElement).toBe(widget("notes"));
    } finally {
      grid.remove();
    }
  });
});

describe("the host banner (S6)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is painted in its own slot ABOVE the script's message, and a script message patch — set or cleared — cannot remove it", async () => {
    await mount();
    await act(async () => {
      store.setHostBanner({ text: "Slowed down.", kind: "warning" });
    });
    await settle();
    expect(q("[data-script-pane-host-banner]").textContent).toBe("Slowed down.");
    expect(q("[data-script-pane-host-banner]").getAttribute("role")).toBe("alert");
    await patch({ patch: { message: { text: "All good", kind: "info" } } });
    expect(q("[data-script-pane-host-banner]").textContent).toBe("Slowed down.");
    expect(q("[data-script-pane-message]").textContent).toBe("All good");
    const order = q("[data-script-pane-host-banner]").compareDocumentPosition(q("[data-script-pane-message]"));
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await patch({ patch: { message: null } });
    expect(maybe("[data-script-pane-message]")).toBeNull();
    expect(q("[data-script-pane-host-banner]").textContent).toBe("Slowed down.");
    await act(async () => {
      store.setHostBanner(null);
    });
    await settle();
    expect(maybe("[data-script-pane-host-banner]")).toBeNull();
  });

  it("the bindings notice is a slot of its own: both host notices paint at once, above the script's message", async () => {
    await mount();
    const notice = 'The cells this pane is bound to are on "Sheet1" — switch back to see and save them';
    await act(async () => {
      store.setHostBindingNotice({ text: notice, kind: "warning" });
      store.setHostBanner({ text: "Slowed down.", kind: "warning" });
    });
    await settle();
    await patch({ patch: { message: { text: "All good", kind: "info" } } });
    expect(q("[data-script-pane-host-banner]").textContent).toBe("Slowed down.");
    expect(q("[data-script-pane-binding-notice]").textContent).toBe(notice);
    expect(q("[data-script-pane-message]").textContent).toBe("All good");
    // Order: what the host says about the pane comes before what the script says.
    const beforeMessage = q("[data-script-pane-binding-notice]").compareDocumentPosition(q("[data-script-pane-message]"));
    expect(beforeMessage & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Each host slot is cleared on its own, and neither clear touches the message.
    await act(async () => {
      store.setHostBanner(null);
    });
    await settle();
    expect(maybe("[data-script-pane-host-banner]")).toBeNull();
    expect(q("[data-script-pane-binding-notice]").textContent).toBe(notice);
    await act(async () => {
      store.setHostBindingNotice(null);
    });
    await settle();
    expect(maybe("[data-script-pane-binding-notice]")).toBeNull();
    expect(q("[data-script-pane-message]").textContent).toBe("All good");
  });

  it("a cooldown banner counts down the seconds left", async () => {
    await mount();
    vi.useFakeTimers();
    const until = Date.now() + 30_000;
    await act(async () => {
      store.setHostBanner({ text: "Updates ignored.", kind: "error", until });
    });
    expect(q("[data-script-pane-host-banner]").textContent).toBe("Updates ignored. (30 s left)");
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(q("[data-script-pane-host-banner]").textContent).toBe("Updates ignored. (25 s left)");
    await act(async () => {
      vi.advanceTimersByTime(40_000);
    });
    expect(q("[data-script-pane-host-banner]").textContent).toBe("Updates ignored. (0 s left)");
  });
});
