//! FILENAME: app/extensions/ScriptableObjects/__tests__/scriptConsentDialogInspect.test.tsx
// PURPOSE: The consent prompt's INSPECT affordance, for every shape of
//          application the load path can hand it.
// CONTEXT: An application may ship object scripts, macros, or ONLY macros —
//          `core/calp/src/pull.rs` materializes `modules/*.json` independently of
//          `object_scripts/*.json`. Inspect was built from the object-script ids
//          alone and returned early when there were none, so on the macro-only
//          prompt it rendered a button that silently did nothing while the text
//          beside it promised "you can inspect the script source code before
//          allowing execution". That is the transparency requirement inverted on
//          the one screen it matters most: the last one before a stranger's code
//          is switched on.
//
//          The prompt also introduced every application as including N object
//          scripts, which for a macro-only application read "includes 0 object
//          scripts" above an empty list.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const openMacroInEditor = vi.fn(async (_id: string) => undefined);
let providerThrows: Error | null = null;

vi.mock("@api/scriptEditorService", () => ({
  requireScriptEditorProvider: () => {
    if (providerThrows) throw providerThrows;
    return { openMacroInEditor, openDraftInEditor: async () => undefined };
  },
}));

const emitted: Array<{ name: string; detail: unknown }> = [];
vi.mock("@api/events", () => ({
  emitAppEvent: (name: string, detail: unknown) => {
    emitted.push({ name, detail });
  },
}));

import ScriptConsentDialog from "../components/ScriptConsentDialog";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root;

function render(data: Record<string, unknown>): void {
  act(() => {
    root.render(
      React.createElement(ScriptConsentDialog, {
        onClose: () => undefined,
        data,
      } as never),
    );
  });
}

/** The footer button whose label starts with "Inspect", or null. */
function inspectButton(): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").startsWith("Inspect"),
    ) ?? null
  );
}

const OBJECT_ONLY = {
  packageName: "Quarterly Reports",
  scriptCount: 1,
  scriptNames: ["Refresh"],
  scriptIds: ["obj-refresh"],
  moduleScriptNames: [],
  moduleScriptIds: [],
  requestedCapabilities: [],
  changedScripts: [],
};

const MACRO_ONLY = {
  packageName: "Quarterly Reports",
  scriptCount: 0,
  scriptNames: [],
  scriptIds: [],
  moduleScriptNames: ["Month end"],
  moduleScriptIds: ["macro-month-end"],
  requestedCapabilities: [],
  changedScripts: [],
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
  emitted.length = 0;
  openMacroInEditor.mockClear();
  providerThrows = null;
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe("Inspect opens something, or is not offered at all", () => {
  it("an object script opens through the ordinary edit-script route", () => {
    render(OBJECT_ONLY);
    const button = inspectButton();
    expect(button).not.toBeNull();
    act(() => {
      button!.click();
    });
    expect(emitted).toEqual([
      { name: "scriptable-objects:edit-script", detail: { scriptId: "obj-refresh" } },
    ]);
    expect(openMacroInEditor).not.toHaveBeenCalled();
  });

  it("a MACRO-ONLY application opens its first macro instead of doing nothing", () => {
    render(MACRO_ONLY);
    const button = inspectButton();
    expect(
      button,
      "the prompt for a macro-only application must still offer the source",
    ).not.toBeNull();
    act(() => {
      button!.click();
    });
    expect(
      openMacroInEditor.mock.calls,
      "Inspect was built from the object-script ids and returned early when there " +
        "were none, so on this prompt it did nothing at all",
    ).toEqual([["macro-month-end"]]);
    expect(emitted).toEqual([]);
  });

  it("nothing to inspect means no button, never an inert one", () => {
    render({ ...MACRO_ONLY, moduleScriptNames: [], moduleScriptIds: [] });
    expect(inspectButton()).toBeNull();
  });

  it("an editor that cannot be reached says so on the prompt", () => {
    providerThrows = new Error("The Object Script Editor is unavailable");
    render(MACRO_ONLY);
    act(() => {
      inspectButton()!.click();
    });
    expect(container.textContent).toContain("The Object Script Editor is unavailable");
  });
});

describe("the prompt describes the application it actually received", () => {
  it("a macro-only application is not introduced as including 0 object scripts", () => {
    render(MACRO_ONLY);
    const text = (container.textContent ?? "").replace(/\s+/g, " ");
    expect(text).not.toContain("0 object script");
    expect(text).toContain('The package "Quarterly Reports" includes 1 macro');
    expect(text).toContain("Month end");
  });

  it("an application with both kinds still reads as one list then the other", () => {
    render({ ...OBJECT_ONLY, moduleScriptNames: ["Month end"], moduleScriptIds: ["m1"] });
    const text = (container.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toContain('The package "Quarterly Reports" includes 1 object script');
    expect(text).toContain("It also includes 1 macro");
  });
});
