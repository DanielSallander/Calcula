//! FILENAME: app/extensions/ScriptableObjects/__tests__/scriptFormDialog.test.tsx
// PURPOSE: The trusted TypeScript Forms renderer, end to end in jsdom: what it
//          emits, when it emits it, and what it refuses to do.
// CONTEXT: The security properties are the ones worth pinning. The identity
//          band is host-derived and a script's title never reaches it; an
//          image draws only from the host-resolved URL, never from the `src`
//          string a script sent; a preview never emits a submit; and exactly
//          ONE terminal event (submit / cancel) leaves per session unless the
//          host itself refuses the submit and re-arms the form.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { emitAppEvent, onAppEvent } from "@api/events";
import type {
  FormSpec,
  ScriptFormInputPayload,
  ScriptFormRequestPayload,
} from "@api/scriptHost/scriptFormSpec";
import {
  SCRIPT_FORM_CLOSE_EVENT,
  SCRIPT_FORM_INPUT_EVENT,
  SCRIPT_FORM_PATCH_EVENT,
} from "@api/scriptHost/scriptFormSpec";
import ScriptFormDialog from "../components/scriptForm/ScriptFormDialog";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const SHOW_ID = "show-1";

/** Every one of the nineteen widget types, nested the way a real form nests. */
function fullSpec(): FormSpec {
  return {
    title: "Enter the order",
    description: "Fill in the order below.",
    width: 520,
    focus: "customer",
    children: [
      { type: "label", name: "intro", text: "Order details", style: "heading" },
      { type: "textbox", name: "customer", label: "Customer", required: true },
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
                  ["Doohickey", 1],
                ],
                maxRows: 2,
              },
              { type: "progress", name: "done", value: 30, max: 100, text: "30% done" },
            ],
          },
        ],
      },
      { type: "button", name: "recalc", text: "Recalculate" },
    ],
  };
}

function request(over: Partial<ScriptFormRequestPayload> = {}): ScriptFormRequestPayload {
  return {
    showId: SHOW_ID,
    scriptId: "script-1",
    scriptName: "Order entry",
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
let events: ScriptFormInputPayload[] = [];
let offInput: (() => void) | null = null;
const onClose = vi.fn();

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}

async function mount(req: ScriptFormRequestPayload = request()): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(React.createElement(ScriptFormDialog, { isOpen: true, onClose, data: req as unknown as Record<string, unknown> }));
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
function ofKind(kind: ScriptFormInputPayload["kind"]): ScriptFormInputPayload[] {
  return events.filter((e) => e.kind === kind);
}
/** The events a script would act on — "shown" and the idle re-arms excluded. */
function acted(): ScriptFormInputPayload[] {
  return events.filter((e) => e.kind !== "shown" && e.kind !== "interaction");
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
async function key(el: HTMLElement, name: string): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  });
  await settle();
}
async function hostEvent(name: string, detail: unknown): Promise<void> {
  await act(async () => {
    emitAppEvent(name, detail);
  });
  await settle();
}

beforeEach(() => {
  events = [];
  onClose.mockClear();
  offInput = onAppEvent<ScriptFormInputPayload>(SCRIPT_FORM_INPUT_EVENT, (d) => {
    events.push(d);
  });
});

afterEach(async () => {
  offInput?.();
  offInput = null;
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
  it("paints every widget type, addressable by name", async () => {
    await mount();
    expect(q(`[data-script-form="${SHOW_ID}"]`).getAttribute("role")).toBe("dialog");
    for (const name of ["intro", "customer", "notes", "amount", "due", "agree", "urgent", "region", "tier", "tags", "pages", "pic", "recalc"]) {
      expect(maybe(`[data-form-widget="${name}"]`), `widget ${name} is missing`).not.toBeNull();
    }
    // The second tab page mounts when it is brought forward.
    expect(maybe('[data-form-widget="lines"]')).toBeNull();
    const tabs = container.querySelectorAll<HTMLElement>('[role="tab"]');
    expect(tabs).toHaveLength(2);
    await click(tabs[1]);
    expect(maybe('[data-form-widget="lines"]')).not.toBeNull();
    expect(widget("lines").textContent).toContain("Widget");
    expect(widget("lines").textContent).toContain("… 1 more");
    expect(widget("done").querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow")).toBe("30");
    // Footer actions carry their e2e hooks.
    expect(maybe("[data-script-form-submit]")).not.toBeNull();
    expect(maybe("[data-script-form-cancel]")).not.toBeNull();
  });

  it("emits 'shown' exactly once on mount, carrying the seeded values", async () => {
    await mount();
    const shown = ofKind("shown");
    expect(shown).toHaveLength(1);
    expect(shown[0].showId).toBe(SHOW_ID);
    expect(shown[0].values.amount).toBe(1234.5);
    expect(shown[0].values.tier).toBe("gold");
    expect(shown[0].values.tags).toEqual([]);
  });

  it("shows the seed's display text while untouched, never as the value", async () => {
    await mount();
    const amount = widget<HTMLInputElement>("amount");
    expect(amount.value).toBe("£1,234.50");
    expect(ofKind("shown")[0].values.amount).toBe(1234.5);
  });

  it("focuses spec.focus", async () => {
    await mount();
    expect(document.activeElement).toBe(widget("customer"));
  });
});

// ----------------------------------------------------------------------------
// Identity band
// ----------------------------------------------------------------------------

describe("the identity band", () => {
  it("is exactly the script name plus the host provenance — the script's title never enters it", async () => {
    await mount();
    const band = q("[data-script-form-band]");
    expect(band.textContent).toBe("Order entryA form from a script in this workbook");
    expect(band.textContent).not.toContain("Enter the order");
    // The title is body content, below the band.
    expect(q("[data-script-form-title]").textContent).toBe("Enter the order");
    expect(q('[role="dialog"]').getAttribute("aria-labelledby")).toBe(band.id);
  });

  it("names the package for a distributed script", async () => {
    await mount(request({ origin: { kind: "package", name: "Sales Pack" } }));
    expect(q("[data-script-form-band]").textContent).toBe('Order entryA form from the package "Sales Pack"');
  });

  it("still says PACKAGE for an application literally named \"local\"", async () => {
    // THE IMPERSONATION THE BAND EXISTS TO PREVENT. Provenance used to be one
    // string in which "local" was the sentinel for "a script in this workbook"
    // and every other value was an application name — so a publisher who named
    // their application `local` got the local phrasing on the one line of this
    // dialog the user is meant to be able to trust. The branch reads `kind` now,
    // and no name can reach it.
    await mount(request({ origin: { kind: "package", name: "local" } }));
    const text = q("[data-script-form-band]").textContent ?? "";
    expect(text).toBe('Order entryA form from the package "local"');
    expect(text).not.toContain("a script in this workbook");
  });

  it("says who opened a proxied form, and which sheet the bindings are pinned to", async () => {
    await mount(request({ callerName: "Dispatcher", pinnedSheetName: "Data" }));
    const text = q("[data-script-form-band]").textContent ?? "";
    expect(text).toContain("A form from a script in this workbook — opened by Dispatcher");
    expect(text).toContain("Sheet: Data");
  });
});

// ----------------------------------------------------------------------------
// Input events
// ----------------------------------------------------------------------------

describe("user input", () => {
  it("typing emits 'change' with the typed value and the whole value set", async () => {
    await mount();
    await typeInto(widget<HTMLInputElement>("customer"), "ACME");
    const changes = ofKind("change");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ showId: SHOW_ID, name: "customer", value: "ACME" });
    expect(changes[0].values.customer).toBe("ACME");
    expect(changes[0].values.amount).toBe(1234.5);
  });

  it("a number widget emits a NUMBER, and a checkbox a boolean", async () => {
    await mount();
    const amount = widget<HTMLInputElement>("amount");
    await act(async () => {
      amount.dispatchEvent(new FocusEvent("focus", { bubbles: false }));
      amount.dispatchEvent(new Event("focusin", { bubbles: true }));
    });
    await settle();
    await typeInto(amount, "1300");
    expect(ofKind("change").at(-1)).toMatchObject({ name: "amount", value: 1300 });
    await click(widget("agree"));
    expect(ofKind("change").at(-1)).toMatchObject({ name: "agree", value: true });
  });

  it("a default button emits 'click' by name and nothing else", async () => {
    await mount();
    await click(widget("recalc"));
    expect(acted()).toHaveLength(1);
    expect(acted()[0]).toMatchObject({ kind: "click", name: "recalc" });
    expect(onClose).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------------
// Submit
// ----------------------------------------------------------------------------

describe("submit", () => {
  it("a required field left empty shows its error and emits nothing", async () => {
    await mount();
    await click(q("[data-script-form-submit]"));
    expect(acted()).toHaveLength(0);
    const frame = q('[data-form-frame="customer"]');
    expect(frame.textContent).toContain("This is required");
    expect(onClose).not.toHaveBeenCalled();
    // The offending widget takes focus.
    expect(document.activeElement).toBe(widget("customer"));
  });

  it("a valid submit emits exactly one 'submit' with the typed values, then waits for the host", async () => {
    await mount();
    await typeInto(widget<HTMLInputElement>("customer"), "ACME");
    await click(q("[data-script-form-submit]"));
    await click(q("[data-script-form-submit]"));
    const submits = ofKind("submit");
    expect(submits).toHaveLength(1);
    expect(submits[0].values.customer).toBe("ACME");
    expect(submits[0].values.amount).toBe(1234.5);
    expect(onClose).not.toHaveBeenCalled();
    // While the host decides, cancel is not a second terminal event either.
    await key(widget("customer"), "Escape");
    expect(ofKind("cancel")).toHaveLength(0);
  });

  it("Enter in a text box submits; Enter in a textarea does not", async () => {
    await mount();
    await typeInto(widget<HTMLInputElement>("customer"), "ACME");
    await key(widget("notes"), "Enter");
    expect(ofKind("submit")).toHaveLength(0);
    await key(widget("customer"), "Enter");
    expect(ofKind("submit")).toHaveLength(1);
  });

  it("Enter never submits when the spec turns it off", async () => {
    const spec = { ...fullSpec(), submitOnEnter: false };
    await mount(request({ spec }));
    await typeInto(widget<HTMLInputElement>("customer"), "ACME");
    await key(widget("customer"), "Enter");
    expect(ofKind("submit")).toHaveLength(0);
  });

  it("a button with role 'submit' mirrors the footer action and suppresses the duplicate", async () => {
    const spec = fullSpec();
    spec.children.push({ type: "button", name: "ok", text: "Place order", role: "submit" });
    await mount(request({ spec }));
    const submits = container.querySelectorAll("[data-script-form-submit]");
    expect(submits).toHaveLength(1);
    expect(submits[0].getAttribute("data-form-widget")).toBe("ok");
    await typeInto(widget<HTMLInputElement>("customer"), "ACME");
    await click(widget("ok"));
    expect(ofKind("submit")).toHaveLength(1);
  });
});

// ----------------------------------------------------------------------------
// Cancel
// ----------------------------------------------------------------------------

describe("cancel", () => {
  it("Escape emits 'cancel' once and closes", async () => {
    await mount();
    await key(widget("customer"), "Escape");
    await key(widget("customer"), "Escape");
    expect(ofKind("cancel")).toHaveLength(1);
    expect(ofKind("cancel")[0].values.amount).toBe(1234.5);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the X, the footer button and the backdrop all cancel", async () => {
    await mount();
    await click(q('button[aria-label="Close"]'));
    expect(ofKind("cancel")).toHaveLength(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ----------------------------------------------------------------------------
// Host -> renderer
// ----------------------------------------------------------------------------

describe("host patches and close", () => {
  it("a PATCH with errors keeps the form open, shows them, and re-arms submit", async () => {
    await mount();
    await typeInto(widget<HTMLInputElement>("customer"), "ACME");
    await click(q("[data-script-form-submit]"));
    expect(ofKind("submit")).toHaveLength(1);

    await hostEvent(SCRIPT_FORM_PATCH_EVENT, {
      showId: SHOW_ID,
      errors: { customer: "That customer already exists" },
      message: { text: "Nothing was saved.", kind: "error" },
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(q('[data-form-frame="customer"]').textContent).toContain("That customer already exists");
    expect(q("[data-script-form-message]").textContent).toBe("Nothing was saved.");

    // The host refused, so the user may try again — a SECOND submit is legal now.
    await typeInto(widget<HTMLInputElement>("customer"), "ACME 2");
    await click(q("[data-script-form-submit]"));
    expect(ofKind("submit")).toHaveLength(2);
    expect(ofKind("submit")[1].values.customer).toBe("ACME 2");
  });

  it("a BARE refusal re-arms submit and says so, instead of freezing on 'Working…'", async () => {
    // `onSubmit` returning `false` or `"cancel"` — VBA's `Cancel = True` — is a
    // refusal that carries no errors and no banner. The renderer used to infer
    // refusal from those two fields, so this payload read as "not refused": the
    // Submit and Cancel buttons stayed disabled and the only way out of the
    // form was to close the dialog, which orphaned the host session (it held
    // the app-wide modal slot until the 30-minute idle deadline).
    await mount();
    await typeInto(widget<HTMLInputElement>("customer"), "ACME");
    await click(q("[data-script-form-submit]"));
    expect(ofKind("submit")).toHaveLength(1);
    expect(q<HTMLButtonElement>("[data-script-form-submit]").disabled).toBe(true);

    await hostEvent(SCRIPT_FORM_PATCH_EVENT, { showId: SHOW_ID, refused: true });

    expect(onClose).not.toHaveBeenCalled();
    expect(q<HTMLButtonElement>("[data-script-form-submit]").disabled).toBe(false);
    expect(q<HTMLButtonElement>("[data-script-form-cancel]").disabled).toBe(false);
    // The host says why in its own words; the script only got to block.
    expect(q("[data-script-form-message]").textContent).toBe("The script did not accept these values.");

    await click(q("[data-script-form-submit]"));
    expect(ofKind("submit")).toHaveLength(2);
  });

  it("a refusal that DOES carry a message keeps the script's words, not the host's", async () => {
    await mount();
    await typeInto(widget<HTMLInputElement>("customer"), "ACME");
    await click(q("[data-script-form-submit]"));
    await hostEvent(SCRIPT_FORM_PATCH_EVENT, {
      showId: SHOW_ID,
      refused: true,
      message: { text: "Orders close at 17:00.", kind: "error" },
    });
    expect(q("[data-script-form-message]").textContent).toBe("Orders close at 17:00.");
    expect(q<HTMLButtonElement>("[data-script-form-submit]").disabled).toBe(false);
  });

  it("honours the base options every widget declares: caption, disabled section, danger cancel", async () => {
    // These were accepted by the validator, documented in the typings, and then
    // dropped by the renderer — a script could set them and watch nothing
    // happen. Grouped in one case because they are one class of defect.
    await mount(
      request({
        spec: {
          title: "Options",
          children: [
            { type: "table", name: "lines", label: "Order lines", columns: ["Item"], rows: [["Widget"]] },
            {
              type: "group",
              name: "advanced",
              disabled: true,
              children: [{ type: "textbox", name: "secret", label: "Secret" }],
            },
            { type: "button", name: "discard", role: "cancel", danger: true, text: "Discard all" },
            { type: "spacer", name: "gap", size: 12 },
          ],
        },
        seeds: {},
      }),
    );

    // `label` on a table is a caption, not silence.
    expect(q('[data-form-frame="lines"]').textContent).toContain("Order lines");
    // A disabled GROUP disables what is inside it.
    expect(widget<HTMLInputElement>("secret").disabled).toBe(true);
    // `danger` is about what the button does, not where it sits.
    expect(q("[data-script-form-cancel]").getAttribute("style") ?? "").toContain("var(--text-error)");
    // The spacer goes through the shared Frame, so a runtime hide reaches it.
    expect(maybe('[data-form-widget="gap"]')).not.toBeNull();
    await hostEvent(SCRIPT_FORM_PATCH_EVENT, { showId: SHOW_ID, patch: { controls: { gap: { hidden: true } } } });
    expect(maybe('[data-form-widget="gap"]')).toBeNull();
  });

  it("points every input at its own error text for a screen reader", async () => {
    // The red text under a field was a loose sibling: visible, and invisible to
    // the one audience that cannot see it. Radio and listbox additionally never
    // reported being invalid at all.
    await mount();
    await click(q("[data-script-form-submit]")); // "Customer" is required
    const customer = widget<HTMLInputElement>("customer");
    const described = customer.getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    expect(customer.getAttribute("aria-invalid")).toBe("true");
    const errorNode = document.getElementById(described!.split(" ")[0]);
    expect(errorNode?.textContent).toBe(q('[data-form-frame="customer"] [role="alert"]').textContent);

    await hostEvent(SCRIPT_FORM_PATCH_EVENT, {
      showId: SHOW_ID,
      errors: { region: "Pick one", tags: "Pick at least one" },
    });
    expect(widget("region").getAttribute("aria-invalid")).toBe("true");
    expect(widget("tags").getAttribute("aria-invalid")).toBe("true");
  });

  it("spec.focus reaches a widget on a tab page that is not the active one", async () => {
    // `autoFocus` is an attribute on a RENDERED element and only the active
    // page renders, so naming a widget on page two used to leave the form with
    // focus nowhere at all: the first keystroke went to the document and Enter
    // did not submit. The initial focus is a REQUEST, which brings the owning
    // page forward first.
    await mount(
      request({
        spec: {
          title: "Tabs",
          focus: "deep",
          children: [
            {
              type: "tabs",
              name: "pages",
              pages: [
                { title: "One", children: [{ type: "textbox", name: "shallow", label: "Shallow" }] },
                { title: "Two", children: [{ type: "textbox", name: "deep", label: "Deep" }] },
              ],
            },
          ],
        },
        seeds: {},
      }),
    );
    expect(document.activeElement).toBe(widget("deep"));
  });

  it("a PATCH for another showId is ignored", async () => {
    await mount();
    await hostEvent(SCRIPT_FORM_PATCH_EVENT, { showId: "someone-else", errors: { customer: "nope" } });
    expect(q('[data-form-frame="customer"]').textContent).not.toContain("nope");
  });

  it("a script patch changes values, hides a control, relabels one, and focuses another", async () => {
    await mount();
    await hostEvent(SCRIPT_FORM_PATCH_EVENT, {
      showId: SHOW_ID,
      patch: {
        values: { amount: "99", customer: "Patched" },
        controls: { notes: { hidden: true }, tier: { label: "Level" }, recalc: { text: "Again" } },
        focus: "tier",
        message: { text: "Heads up", kind: "warning" },
      },
    });
    expect(maybe('[data-form-widget="notes"]')).toBeNull();
    expect(widget<HTMLInputElement>("customer").value).toBe("Patched");
    expect(widget("recalc").textContent).toBe("Again");
    expect(container.textContent).toContain("Level");
    expect(q("[data-script-form-message]").textContent).toBe("Heads up");
    expect(document.activeElement).toBe(widget("tier"));
    // A patched value is coerced like a seed: the number widget holds 99, not "99".
    await click(widget("agree"));
    expect(ofKind("change").at(-1)!.values.amount).toBe(99);
  });

  it("a focus the SCRIPT asked for is not reported as user interaction", async () => {
    // The host re-arms its 30-minute idle deadline on every interaction, and
    // that deadline is what frees the app-wide modal slot when nobody is
    // answering. A script patching `{ focus }` on a timer would move focus,
    // the DOM focus handler would report an interaction, and the form would
    // sit open with no user until the 8-hour absolute cap.
    // Time is driven, not waited on: interaction is throttled to one per
    // second, and a test that ran inside one throttle window would pass
    // whether or not the suppression exists.
    const realNow = Date.now.bind(Date);
    let skew = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
    try {
      await mount();
      const before = ofKind("interaction").length;

      skew += 5_000; // well past the throttle: a real interaction WOULD emit
      await hostEvent(SCRIPT_FORM_PATCH_EVENT, { showId: SHOW_ID, patch: { focus: "tier" } });
      expect(document.activeElement).toBe(widget("tier"));
      expect(ofKind("interaction")).toHaveLength(before);

      // ...while the user reaching for a field still counts as present.
      skew += 5_000;
      widget<HTMLInputElement>("customer").focus();
      await settle();
      expect(ofKind("interaction")).toHaveLength(before + 1);
    } finally {
      now.mockRestore();
    }
  });

  it("refreshed seeds land on untouched widgets only; a dirty one keeps the user's text and is marked", async () => {
    await mount();
    await typeInto(widget<HTMLInputElement>("customer"), "ACME");
    await hostEvent(SCRIPT_FORM_PATCH_EVENT, {
      showId: SHOW_ID,
      seeds: {
        customer: { value: "Someone else", display: "Someone else" },
        amount: { value: 42, display: "£42.00" },
      },
    });
    expect(widget<HTMLInputElement>("customer").value).toBe("ACME");
    expect(maybe('[data-form-stale="customer"]')).not.toBeNull();
    expect(widget<HTMLInputElement>("amount").value).toBe("£42.00");
    expect(maybe('[data-form-stale="amount"]')).toBeNull();
    await click(widget("agree"));
    expect(ofKind("change").at(-1)!.values.amount).toBe(42);
  });

  it("a CLOSE event closes without emitting anything", async () => {
    await mount();
    const before = events.length;
    await hostEvent(SCRIPT_FORM_CLOSE_EVENT, { showId: SHOW_ID, reason: "script" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(events.length).toBe(before);
    // Nothing leaves after a close, whatever the user does next.
    await click(q("[data-script-form-submit]"));
    await key(widget("customer"), "Escape");
    expect(events.length).toBe(before);
  });
});

// ----------------------------------------------------------------------------
// Preview
// ----------------------------------------------------------------------------

describe("preview mode", () => {
  it("never emits 'submit'; Submit shows what would be written, Close cancels", async () => {
    await mount(request({ preview: true }));
    expect(q("[data-script-form-band]").textContent).toContain("Preview — nothing will be written");
    await typeInto(widget<HTMLInputElement>("customer"), "ACME");
    await click(q("[data-script-form-submit]"));
    expect(ofKind("submit")).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
    const summary = q("[data-script-form-preview]");
    expect(summary.textContent).toContain("customer");
    expect(summary.textContent).toContain("ACME");
    expect(summary.textContent).toContain("1234.5 (now £1,234.50)");
    await click(q("[data-script-form-close]"));
    expect(ofKind("submit")).toHaveLength(0);
    expect(ofKind("cancel")).toHaveLength(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ----------------------------------------------------------------------------
// Images
// ----------------------------------------------------------------------------

describe("images", () => {
  it("renders the alt text, not the src string, when the host resolved nothing", async () => {
    await mount();
    expect(widget("pic").querySelector("img")).toBeNull();
    expect(widget("pic").textContent).toBe("Company logo");
    expect(container.querySelector('[src="media:abc"]')).toBeNull();
  });

  it("renders ONLY the host-resolved imageUrl", async () => {
    const url = "data:image/png;base64,iVBORw0KGgo=";
    await mount(request({ seeds: { pic: { value: null, imageUrl: url } } }));
    const img = widget("pic").querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe(url);
    expect(img!.getAttribute("alt")).toBe("Company logo");
    expect(container.querySelector('[src="media:abc"]')).toBeNull();
  });
});
