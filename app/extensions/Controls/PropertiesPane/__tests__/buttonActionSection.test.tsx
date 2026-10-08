//! FILENAME: app/extensions/Controls/PropertiesPane/__tests__/buttonActionSection.test.tsx
// PURPOSE: The Properties pane's "Action" section for a button (Canvas
//          contract §3/§4.4): Run code / Go to page / Back / Clear all
//          slicers, plus the destination page for "Go to page". Pins:
//            * the current action is shown, the destination lists the OTHER
//              visible pages;
//            * a choice writes the three action properties in one sequence,
//              the target by stable id AND name;
//            * a button that has code asks first -- one button does one thing --
//              and a refusal writes nothing; consent removes the code FIRST;
//            * a button holding an APPLICATION's code cannot be given an action
//              here (that code is replaced or removed through its own section).
// CONTEXT: react-dom + act like the sibling component tests; getSheets and the
//          confirm dialog doubled (Tauri shape: a Promise).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  sheets: [] as Array<{ index: number; name: string; visibility: string; sheetId?: string; kind?: string }>,
  confirm: vi.fn(),
}));

vi.mock("@api/lib", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSheets: async () => ({ sheets: h.sheets, activeIndex: 1 }),
}));
vi.mock("@api/dialogs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  confirmAsync: (...a: unknown[]) => h.confirm(...a),
}));

import { ButtonActionSection } from "../ButtonActionSection";
import type { ControlPropertyValue } from "../../lib/types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root;
let writes: Array<Array<[string, string]>>;

function bag(values: Record<string, string>): Record<string, ControlPropertyValue> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { valueType: "static" as const, value: v }]));
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

async function render(properties: Record<string, ControlPropertyValue>, heldCode = false): Promise<void> {
  act(() => {
    root.render(
      <ButtonActionSection
        sheetIndex={1}
        properties={properties}
        heldCode={heldCode}
        writeProperties={async (entries) => {
          writes.push(entries);
        }}
      />,
    );
  });
  await flush();
}

function select(testId: string): HTMLSelectElement {
  const el = container.querySelector<HTMLSelectElement>(`[data-testid="${testId}"]`);
  if (!el) throw new Error(`no ${testId}`);
  return el;
}

async function choose(testId: string, value: string): Promise<void> {
  const el = select(testId);
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

beforeEach(() => {
  h.sheets = [
    { index: 0, name: "Data", visibility: "visible", sheetId: "id-data", kind: "worksheet" },
    { index: 1, name: "Overview", visibility: "visible", sheetId: "id-overview", kind: "canvas" },
    { index: 2, name: "Details", visibility: "visible", sheetId: "id-details", kind: "canvas" },
    { index: 3, name: "Secret", visibility: "hidden", sheetId: "id-secret", kind: "worksheet" },
  ];
  h.confirm.mockReset().mockReturnValue(Promise.resolve(true));
  writes = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("the button Action section", () => {
  it("shows Run code for a button without an action, and no destination", async () => {
    await render(bag({ text: "Go", onSelect: "" }));
    expect(select("control-button-action").value).toBe("");
    expect(container.querySelector('[data-testid="control-button-action-target"]')).toBeNull();
    const labels = Array.from(select("control-button-action").options).map((o) => o.textContent);
    expect(labels).toEqual(["Run code", "Go to page", "Back", "Clear all slicers"]);
  });

  it("lists the OTHER visible pages as destinations, and shows the current one", async () => {
    await render(bag({ action: "navigate", actionTarget: "id-details", actionTargetName: "Details" }));
    expect(select("control-button-action").value).toBe("navigate");
    const target = select("control-button-action-target");
    expect(Array.from(target.options).map((o) => o.textContent)).toEqual(["Data", "Details"]);
    expect(target.value).toBe("id-details");
  });

  // SABOTAGE: write only `action` -> the old target stays behind on a
  // navigate -> back change, and a navigate has no target at all.
  it("Go to page writes the action with the first other page, by id and name", async () => {
    await render(bag({ onSelect: "" }));
    await choose("control-button-action", "navigate");
    expect(h.confirm).not.toHaveBeenCalled();
    expect(writes).toEqual([
      [
        ["action", "navigate"],
        ["actionTarget", "id-data"],
        ["actionTargetName", "Data"],
      ],
    ]);
  });

  it("changing the destination rewrites the target", async () => {
    await render(bag({ action: "navigate", actionTarget: "id-data", actionTargetName: "Data" }));
    await choose("control-button-action-target", "id-details");
    expect(writes).toEqual([
      [
        ["action", "navigate"],
        ["actionTarget", "id-details"],
        ["actionTargetName", "Details"],
      ],
    ]);
  });

  it("Run code clears all three action properties", async () => {
    await render(bag({ action: "back" }));
    await choose("control-button-action", "");
    expect(writes).toEqual([
      [
        ["action", ""],
        ["actionTarget", ""],
        ["actionTargetName", ""],
      ],
    ]);
  });

  // SABOTAGE: skip the confirm when onSelect is non-empty -> code and an
  // action sit on one button.
  it("asks before replacing a button's code, and writes NOTHING on a refusal", async () => {
    h.confirm.mockReturnValue(Promise.resolve(false));
    await render(bag({ onSelect: "Report();" }));
    await choose("control-button-action", "back");
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(String(h.confirm.mock.calls[0][0])).toMatch(/code/);
    expect(writes).toEqual([]);
    expect(select("control-button-action").value).toBe("");
  });

  it("with consent removes the code FIRST, then writes the action", async () => {
    await render(bag({ onSelect: "Report();", macroRef: "macro-report" }));
    await choose("control-button-action", "clearSlicers");
    expect(writes).toEqual([
      [
        ["onSelect", ""],
        ["macroRef", ""],
        ["action", "clearSlicers"],
        ["actionTarget", ""],
        ["actionTargetName", ""],
      ],
    ]);
  });

  it("is disabled, with its reason, on a button holding an application's code", async () => {
    await render(bag({ heldOnSelect: "Theirs();" }), true);
    expect(select("control-button-action").disabled).toBe(true);
    expect(container.textContent).toMatch(/application/);
  });
});
