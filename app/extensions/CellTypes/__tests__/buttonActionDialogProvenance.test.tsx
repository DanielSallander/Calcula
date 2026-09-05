//! FILENAME: app/extensions/CellTypes/__tests__/buttonActionDialogProvenance.test.tsx
// PURPOSE: The button-action picker says WHOSE code a button will run before
//          the button exists.
//
// `ScriptSummary` carries `sourcePackage` for exactly this picker, and the
// picker dropped it: a publisher's module and the user's own were two options
// with the same text, no line said the button would run published code, and
// "Function to call" was offered for a module the run planner
// (`planStoredModuleRun`) refuses to append a call to — so the user learned of
// the refusal only when the button did nothing. Renders the real dialog over a
// fake listing and asserts what is shown, what is withheld, and what is applied.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

interface Listed {
  id: string;
  name: string;
  sourcePackage?: string | null;
}

let listed: Listed[] = [];

vi.mock("../../../src/api/workbookScripts", () => ({
  listWorkbookScripts: async () => listed,
}));

vi.mock("@api", () => ({
  // eslint-disable-next-line @typescript-eslint/naming-convention -- mirrors the real export's name
  ExtensionRegistry: { getAllCommands: () => [] },
}));

import { ButtonActionDialog } from "../components/ButtonActionDialog";
import type { ButtonAction } from "../types/button";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;
const onApply = vi.fn((_action: ButtonAction, _label: string) => undefined);
const onClose = vi.fn();

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function openDialog(): Promise<void> {
  await act(async () => {
    root.render(
      <ButtonActionDialog isOpen={true} onClose={onClose} data={{ onApply }} />,
    );
  });
  await flush();
}

function radio(index: number): HTMLInputElement {
  return host.querySelectorAll<HTMLInputElement>("input[type=radio]")[index];
}

function scriptSelect(): HTMLSelectElement {
  const el = host.querySelector<HTMLSelectElement>("[data-button-script-select]");
  if (!el) throw new Error("script select not rendered");
  return el;
}

async function chooseScriptKind(): Promise<void> {
  await act(async () => {
    radio(1).click();
  });
}

async function selectScript(id: string): Promise<void> {
  await act(async () => {
    const el = scriptSelect();
    el.value = id;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function typeFunctionName(text: string): Promise<void> {
  const input = host.querySelector<HTMLInputElement>("[data-button-function-name]");
  if (!input) throw new Error("function field not rendered");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function optionLabels(): string[] {
  return [...scriptSelect().options].map((o) => o.textContent ?? "");
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  onApply.mockClear();
  onClose.mockClear();
  listed = [
    { id: "mine", name: "Report", sourcePackage: null },
    { id: "theirs", name: "Report", sourcePackage: "SalesApp" },
  ];
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

describe("ButtonActionDialog provenance", () => {
  it("labels a distributed module with its application, so two 'Report's differ", async () => {
    await openDialog();
    await chooseScriptKind();

    const labels = optionLabels().slice(1); // drop the placeholder
    expect(labels).toEqual(["Report", 'Report — from application "SalesApp"']);
  });

  it("says the button will run published code, only once approved, when one is chosen", async () => {
    await openDialog();
    await chooseScriptKind();

    expect(host.querySelector("[data-button-script-provenance]")).toBeNull();

    await selectScript("theirs");
    const note = host.querySelector<HTMLElement>("[data-button-script-provenance]");
    expect(note).not.toBeNull();
    expect(note?.getAttribute("data-button-script-provenance")).toBe("SalesApp");
    expect(note?.textContent).toContain('"SalesApp"');
    expect(note?.textContent).toContain("exactly as published");
    expect(note?.textContent).toContain("only if you have approved that application");

    await selectScript("mine");
    expect(host.querySelector("[data-button-script-provenance]")).toBeNull();
  });

  it("withholds 'Function to call' for a distributed module and says why", async () => {
    await openDialog();
    await chooseScriptKind();

    await selectScript("mine");
    expect(host.querySelector("[data-button-function-name]")).not.toBeNull();
    expect(host.querySelector("[data-button-function-withheld]")).toBeNull();

    await selectScript("theirs");
    expect(host.querySelector("[data-button-function-name]")).toBeNull();
    const why = host.querySelector<HTMLElement>("[data-button-function-withheld]");
    expect(why).not.toBeNull();
    expect(why?.textContent).toContain('"SalesApp"');
    expect(why?.textContent).toContain("code you have not approved");
  });

  it("never applies a function name onto a distributed module", async () => {
    await openDialog();
    await chooseScriptKind();

    // Typed for the user's own module, then the choice moves to a publisher's.
    await selectScript("mine");
    await typeFunctionName("Go");
    await selectScript("theirs");

    const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")];
    const insert = buttons.find((b) => b.textContent === "Insert Button");
    if (!insert) throw new Error("Insert Button not rendered");
    expect(insert.disabled).toBe(false);
    await act(async () => {
      insert.click();
    });

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toEqual({
      kind: "script",
      scriptId: "theirs",
      functionName: undefined,
    });
  });

  it("still applies the typed function name for the user's own module", async () => {
    await openDialog();
    await chooseScriptKind();
    await selectScript("mine");
    await typeFunctionName("Go");

    const insert = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Insert Button",
    );
    await act(async () => {
      insert?.click();
    });

    expect(onApply.mock.calls[0][0]).toEqual({
      kind: "script",
      scriptId: "mine",
      functionName: "Go",
    });
  });
});
