//! FILENAME: app/extensions/ConditionalFormatting/components/__tests__/cfDataBarOptions.test.tsx
// PURPOSE: BUG-0728 -- New Rule's data-bar page offers every option the
//          painter honours, as Excel's dialog does, and writes each into the
//          rule: Show Bar Only, Fill (solid / gradient) and colour, Border (none
//          / solid) and colour, Bar Direction, and the "Negative Value and Axis
//          Settings" sub-dialog (negative fill and border colour or "same as
//          positive", axis position, axis colour). The icon-set page offers
//          Reverse Icon Order and Show Icon Only.
// CONTEXT: The page offered six preset colours and nothing else, so a rule
//          with a solid fill, no border, a midpoint axis or a right-to-left bar
//          could be made only by a script. Excel's "same as positive" follows
//          the positive colour (NegativeBarFormat.ColorType = SameAsPositive,
//          [LIVE] lane uiforms probe1 P3b); the stored rule has no flag, so OK
//          writes the positive colour itself.

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

import { NewRuleDialog } from "../NewRuleDialog";
import { dataBarRule } from "../../lib/presetRules";
import { DEFAULT_DATA_BAR_UI, dataBarRuleFromUi, dataBarUiOf, type DataBarUi } from "../../lib/dataBarOptions";
import { findHardcodedColours } from "@api/layout";

const SELECTION = { startRow: 0, startCol: 0, endRow: 4, endCol: 0 };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  h.addConditionalFormat.mockReset();
  h.addConditionalFormat.mockResolvedValue({ success: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

function byTestId<T extends HTMLElement>(id: string): T {
  const el = document.querySelector<T>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`no [data-testid="${id}"]`);
  return el;
}

function button(text: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).filter(
    (b) => b.textContent?.trim() === text && !b.closest("[data-testid='cf-databar-negative-panel']"),
  );
  if (found.length === 0) throw new Error(`no button "${text}"`);
  return found[found.length - 1];
}

/** A button of the Negative Value and Axis sub-dialog (New Rule has its own OK / Cancel). */
function panelButton(text: string): HTMLButtonElement {
  const panel = byTestId("cf-databar-negative-panel");
  const found = Array.from(panel.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no sub-dialog button "${text}"`);
  return found;
}

function choose(select: HTMLSelectElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function click(el: HTMLElement): void {
  act(() => {
    el.click();
  });
}

/** The OS picker closing on a colour: the native `change` commits it once. */
function pickColour(input: HTMLInputElement, hex: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, hex);
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
  await new Promise((r) => setTimeout(r, 0));
}

function openDataBarPage(): void {
  act(() => {
    root.render(
      <NewRuleDialog
        isOpen
        onClose={vi.fn()}
        data={{ selection: SELECTION, initialCategory: "formatByValues", initialFormatStyle: "dataBar" }}
      />,
    );
  });
}

function writtenRule(): Record<string, unknown> {
  expect(h.addConditionalFormat).toHaveBeenCalledTimes(1);
  return h.addConditionalFormat.mock.calls[0][0].rule;
}

describe("the options and the rule they write (lib/dataBarOptions.ts)", () => {
  it("Excel's New Rule defaults are the gradient Blue Data Bar preset", () => {
    expect(dataBarRuleFromUi(DEFAULT_DATA_BAR_UI)).toEqual(dataBarRule("#638EC6", true));
  });

  it("same as positive writes the positive colours; No Border writes no border at all", () => {
    const ui: DataBarUi = {
      ...DEFAULT_DATA_BAR_UI,
      color: "#00aa00",
      borderColor: "#003300",
      negativeFill: "sameAsPositive",
      negativeBorder: "sameAsPositive",
    };
    expect(dataBarRuleFromUi(ui)).toMatchObject({
      fillColor: "#00aa00",
      negativeFillColor: "#00aa00",
      borderColor: "#003300",
      negativeBorderColor: "#003300",
    });
    const plain = dataBarRuleFromUi({ ...ui, border: "none" });
    expect(plain).not.toHaveProperty("borderColor");
    expect(plain).not.toHaveProperty("negativeBorderColor");
  });

  it("a stored rule reads back as the controls that write it", () => {
    for (const ui of [
      DEFAULT_DATA_BAR_UI,
      { ...DEFAULT_DATA_BAR_UI, fill: "solid" as const, border: "none" as const, direction: "rightToLeft" as const },
      { ...DEFAULT_DATA_BAR_UI, negativeFill: "sameAsPositive" as const, axisPosition: "cellMidpoint" as const, axisColor: "#123456" },
      { ...DEFAULT_DATA_BAR_UI, showBarOnly: true, negativeBorder: "sameAsPositive" as const, axisPosition: "none" as const },
    ]) {
      const rule = dataBarRuleFromUi(ui);
      expect(dataBarRuleFromUi(dataBarUiOf(rule))).toEqual(rule);
    }
  });
});

describe("New Rule's data-bar page (BUG-0728)", () => {
  it("offers Excel's controls, painted with theme tokens", () => {
    openDataBarPage();
    expect(Array.from(byTestId<HTMLSelectElement>("cf-databar-fill").options).map((o) => o.textContent)).toEqual(["Solid Fill", "Gradient Fill"]);
    expect(Array.from(byTestId<HTMLSelectElement>("cf-databar-border").options).map((o) => o.textContent)).toEqual(["No Border", "Solid Border"]);
    expect(Array.from(byTestId<HTMLSelectElement>("cf-databar-direction").options).map((o) => o.textContent)).toEqual([
      "Context",
      "Left-to-Right",
      "Right-to-Left",
    ]);
    expect(byTestId<HTMLInputElement>("cf-databar-show-bar-only").checked).toBe(false);
    expect(findHardcodedColours(document.body)).toEqual([]);
  });

  it("an untouched page writes the default bar", async () => {
    openDataBarPage();
    click(button("OK"));
    await settle();
    expect(writtenRule()).toEqual(dataBarRule("#638EC6", true));
  });

  it("solid fill, a picked colour, no border, right-to-left and Show Bar Only are all written", async () => {
    openDataBarPage();
    choose(byTestId("cf-databar-fill"), "solid");
    pickColour(byTestId("cf-databar-color"), "#00b050");
    choose(byTestId("cf-databar-border"), "none");
    choose(byTestId("cf-databar-direction"), "rightToLeft");
    click(byTestId("cf-databar-show-bar-only"));
    // The border colour is offered only with a border.
    expect(byTestId<HTMLInputElement>("cf-databar-border-color").disabled).toBe(true);
    click(button("OK"));
    await settle();
    const rule = writtenRule();
    expect(rule).toMatchObject({
      type: "dataBar",
      fillColor: "#00b050",
      gradientFill: false,
      direction: "rightToLeft",
      showValue: false,
    });
    expect(rule).not.toHaveProperty("borderColor");
  });

  it("Negative Value and Axis: same fill as positive, a border colour, the cell midpoint and an axis colour", async () => {
    openDataBarPage();
    click(byTestId("cf-databar-negative-open"));
    expect(document.querySelector("[role='dialog'][aria-label='Negative Value and Axis Settings']")).not.toBeNull();
    click(byTestId("cf-databar-negative-fill-same"));
    pickColour(byTestId("cf-databar-negative-border-picker"), "#7030a0");
    click(byTestId("cf-databar-axis-cellMidpoint"));
    pickColour(byTestId("cf-databar-axis-color"), "#ff00ff");
    click(panelButton("OK"));
    expect(document.querySelector("[data-testid='cf-databar-negative-panel']")).toBeNull();
    click(button("OK")); // New Rule's
    await settle();
    expect(writtenRule()).toMatchObject({
      fillColor: "#638EC6",
      negativeFillColor: "#638EC6",
      borderColor: "#638EC6",
      negativeBorderColor: "#7030a0",
      axisPosition: "cellMidpoint",
      axisColor: "#ff00ff",
    });
  });

  it("the sub-dialog's Cancel keeps what the page had", async () => {
    openDataBarPage();
    click(byTestId("cf-databar-negative-open"));
    click(byTestId("cf-databar-axis-none"));
    click(panelButton("Cancel"));
    expect(document.querySelector("[data-testid='cf-databar-negative-panel']")).toBeNull();
    click(button("OK"));
    await settle();
    expect(writtenRule()).toMatchObject({ axisPosition: "automatic" });
  });

  it("with No Border the negative bar's border choices are not offered", () => {
    openDataBarPage();
    choose(byTestId("cf-databar-border"), "none");
    click(byTestId("cf-databar-negative-open"));
    expect(byTestId<HTMLInputElement>("cf-databar-negative-border-color").disabled).toBe(true);
    expect(byTestId<HTMLInputElement>("cf-databar-negative-border-same").disabled).toBe(true);
  });
});

describe("New Rule's icon-set page", () => {
  it("Reverse Icon Order and Show Icon Only are written", async () => {
    act(() => {
      root.render(
        <NewRuleDialog
          isOpen
          onClose={vi.fn()}
          data={{ selection: SELECTION, initialCategory: "formatByValues", initialFormatStyle: "iconSet" }}
        />,
      );
    });
    click(byTestId("cf-iconset-reverse"));
    click(byTestId("cf-iconset-icon-only"));
    click(button("OK"));
    await settle();
    expect(writtenRule()).toMatchObject({ type: "iconSet", reverseIcons: true, showIconOnly: true });
  });
});
