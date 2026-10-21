//! FILENAME: app/extensions/ConditionalFormatting/components/__tests__/cfDialogs.test.tsx
// PURPOSE: The quick dialog's "A Date Occurring" rule, the New Rule dialog's
//          starting category (each More Rules... door opens it where Excel
//          does), and both dialogs keeping a refusal on screen.
// CONTEXT: The backend has evaluated `timePeriod` rules all along (16 periods,
//          @api/backend TimePeriodRule) but no door could create one: the quick
//          dialog had no date entry and New Rule's "Format only cells with"
//          list stopped at Specific Text. New Rule also ALWAYS opened on
//          "Format only cells that contain", so a gallery's More Rules...
//          landed on the wrong page. And both dialogs awaited the add with no
//          catch: a refusal closed nothing, said nothing, and escaped as an
//          unhandled rejection.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  addConditionalFormat: vi.fn(),
  invalidateAndRefresh: vi.fn(async () => undefined),
}));

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  addConditionalFormat: (...a: unknown[]) => h.addConditionalFormat(...a),
  restoreFocusToGrid: vi.fn(),
}));
vi.mock("../../lib/cfStore", () => ({ invalidateAndRefresh: () => h.invalidateAndRefresh() }));

import { QuickCFDialog } from "../QuickCFDialog";
import { NewRuleDialog } from "../NewRuleDialog";

const SELECTION = { startRow: 0, startCol: 0, endRow: 4, endCol: 0 };

let container: HTMLDivElement;
let root: Root;
let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  h.addConditionalFormat.mockReset();
  h.addConditionalFormat.mockResolvedValue({ success: true });
  h.invalidateAndRefresh.mockClear();
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  act(() => root.unmount());
  document.body.innerHTML = "";
});

function render(node: React.ReactNode): void {
  act(() => {
    root.render(node);
  });
}

function button(text: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no button "${text}"`);
  return found;
}

function selectWithOption(value: string): HTMLSelectElement {
  const found = Array.from(document.querySelectorAll("select")).find((s) =>
    Array.from(s.options).some((o) => o.value === value),
  );
  if (!found) throw new Error(`no select offering "${value}"`);
  return found;
}

function choose(select: HTMLSelectElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
  await new Promise((r) => setTimeout(r, 0));
}

describe("A Date Occurring (quick dialog)", () => {
  it("offers Excel's ten periods, Yesterday selected, and writes a timePeriod rule", async () => {
    const onClose = vi.fn();
    render(<QuickCFDialog isOpen onClose={onClose} data={{ ruleType: "dateOccurring", selection: SELECTION }} />);
    expect(document.body.textContent).toContain("Format cells that contain a date occurring:");
    const periods = selectWithOption("yesterday");
    expect(Array.from(periods.options).map((o) => o.textContent)).toEqual([
      "Yesterday",
      "Today",
      "Tomorrow",
      "In the last 7 days",
      "Last week",
      "This week",
      "Next week",
      "Last month",
      "This Month",
      "Next month",
    ]);
    expect(periods.value).toBe("yesterday");
    // No free-text value box for a date rule.
    expect(document.querySelector("input[type='text']")).toBeNull();

    choose(periods, "thisMonth");
    act(() => button("OK").click());
    await settle();
    expect(h.addConditionalFormat).toHaveBeenCalledWith(
      {
        rule: { type: "timePeriod", period: "thisMonth" },
        format: { backgroundColor: "#FFC7CE", textColor: "#9C0006" },
        ranges: [SELECTION],
        stopIfTrue: false,
      },
      { target: undefined },
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a refusal stays on screen with the reason, and the dialog stays open", async () => {
    h.addConditionalFormat.mockRejectedValue(new Error("The sheet is protected."));
    const onClose = vi.fn();
    render(<QuickCFDialog isOpen onClose={onClose} data={{ ruleType: "greaterThan", selection: SELECTION }} />);
    act(() => button("OK").click());
    await settle();
    expect(unhandled).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector("[role='alert']")?.textContent).toContain("The sheet is protected.");
    expect(h.invalidateAndRefresh).not.toHaveBeenCalled();
  });

  it("a success:false answer is a refusal too", async () => {
    h.addConditionalFormat.mockResolvedValue({ success: false, error: "Invalid value" });
    const onClose = vi.fn();
    render(<QuickCFDialog isOpen onClose={onClose} data={{ ruleType: "equalTo", selection: SELECTION }} />);
    act(() => button("OK").click());
    await settle();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector("[role='alert']")?.textContent).toContain("Invalid value");
  });
});

describe("New Rule: where each door opens it", () => {
  function selectedCategory(): string | null {
    const el = document.querySelector("[data-rule-category][aria-selected='true']");
    return el?.getAttribute("data-rule-category") ?? null;
  }

  it("opens on 'Format only cells that contain' by default (the item, and Highlight's More Rules...)", () => {
    render(<NewRuleDialog isOpen onClose={vi.fn()} data={{ selection: SELECTION }} />);
    expect(selectedCategory()).toBe("formatContaining");
  });

  it("opens on 'top or bottom ranked values' from Top/Bottom's More Rules...", () => {
    render(<NewRuleDialog isOpen onClose={vi.fn()} data={{ selection: SELECTION, initialCategory: "topBottom" }} />);
    expect(selectedCategory()).toBe("topBottom");
  });

  it("opens on 'based on their values' with the gallery's own format style", () => {
    render(
      <NewRuleDialog
        isOpen
        onClose={vi.fn()}
        data={{ selection: SELECTION, initialCategory: "formatByValues", initialFormatStyle: "iconSet" }}
      />,
    );
    expect(selectedCategory()).toBe("formatByValues");
    expect(selectWithOption("iconSet").value).toBe("iconSet");
  });

  it("an unknown category falls back to the default rather than a blank page", () => {
    render(<NewRuleDialog isOpen onClose={vi.fn()} data={{ selection: SELECTION, initialCategory: "nonsense" }} />);
    expect(selectedCategory()).toBe("formatContaining");
  });

  it("'Format only cells with' offers Dates Occurring (Excel's third entry) and writes a timePeriod rule", async () => {
    const onClose = vi.fn();
    render(<NewRuleDialog isOpen onClose={onClose} data={{ selection: SELECTION }} />);
    const kind = selectWithOption("dates");
    expect(Array.from(kind.options).map((o) => o.textContent)).toEqual([
      "Cell Value",
      "Specific Text",
      "Dates Occurring",
      "Blanks",
      "No Blanks",
      "Errors",
      "No Errors",
    ]);
    choose(kind, "dates");
    choose(selectWithOption("last7Days"), "last7Days");
    act(() => button("OK").click());
    await settle();
    expect(h.addConditionalFormat).toHaveBeenCalledTimes(1);
    expect(h.addConditionalFormat.mock.calls[0][0].rule).toEqual({ type: "timePeriod", period: "last7Days" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the color-scale presets offered are Excel's twelve, and the rule is Excel's", async () => {
    render(
      <NewRuleDialog
        isOpen
        onClose={vi.fn()}
        data={{ selection: SELECTION, initialCategory: "formatByValues", initialFormatStyle: "colorScale" }}
      />,
    );
    const presets = Array.from(document.querySelectorAll("select")).find((s) => s.options.length === 12);
    expect(presets).toBeDefined();
    act(() => button("OK").click());
    await settle();
    expect(h.addConditionalFormat.mock.calls[0][0].rule).toEqual({
      type: "colorScale",
      minPoint: { valueType: "min", color: "#F8696B" },
      midPoint: { valueType: "percentile", value: 50, color: "#FFEB84" },
      maxPoint: { valueType: "max", color: "#63BE7B" },
    });
  });

  it("a refusal stays on screen with the reason, and the dialog stays open", async () => {
    h.addConditionalFormat.mockRejectedValue(new Error("Formula is not valid"));
    const onClose = vi.fn();
    render(<NewRuleDialog isOpen onClose={onClose} data={{ selection: SELECTION, initialCategory: "topBottom" }} />);
    act(() => button("OK").click());
    await settle();
    expect(unhandled).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector("[role='alert']")?.textContent).toContain("Formula is not valid");
  });
});
