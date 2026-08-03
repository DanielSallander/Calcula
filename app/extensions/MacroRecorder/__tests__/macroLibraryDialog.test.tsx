//! FILENAME: app/extensions/MacroRecorder/__tests__/macroLibraryDialog.test.tsx
// PURPOSE: The listing surface actually shows a saved macro, and offers the
//          action that can really run it for the runtime it was recorded for.
// CONTEXT: "The macro must be findable afterwards" is the requirement the whole
//          auto-save rests on — a store with no window over it would recreate
//          the failure this change is fixing. This renders the real dialog over
//          a fake module store and asserts what the user sees.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// --- Fake module store --------------------------------------------------------

interface StoredScript {
  id: string;
  name: string;
  description: string | null;
  source: string;
}
const store = new Map<string, StoredScript>();

vi.mock("@api", () => ({
  listWorkbookScripts: async () =>
    [...store.values()].map((s) => ({ id: s.id, name: s.name })),
  getWorkbookScript: async (id: string) => {
    const found = store.get(id);
    if (!found) throw new Error(`Script '${id}' not found`);
    return found;
  },
  saveWorkbookScript: async (s: StoredScript) => {
    store.set(s.id, { ...s });
  },
  deleteWorkbookScript: async (id: string) => {
    store.delete(id);
  },
  runWorkbookScript: async () => ({
    type: "success",
    output: ["ran"],
    cellsModified: 2,
    durationMs: 3,
    screenUpdating: true,
  }),
}));

vi.mock("@api/notifications", () => ({ showToast: vi.fn() }));

vi.mock("@api/dialogWindow", () => ({
  useDialogWindow: () => ({
    ref: React.createRef<HTMLDivElement>(),
    style: {},
    onHeaderMouseDown: () => undefined,
    resizeHandles: null,
    reset: () => undefined,
  }),
}));

vi.mock("../lib/flow", () => ({
  getAnchorCell: () => ({ sheetIndex: 0, row: 0, col: 0 }),
}));

const hasProvider = { value: true };
vi.mock("@api/buttonControlService", () => ({
  hasButtonControlProvider: () => hasProvider.value,
  requireButtonControlProvider: () => {
    throw new Error("not used in this test");
  },
}));

import { MacroLibraryDialog, buttonEntryPoint, functionNameOf } from "../components/MacroLibraryDialog";
import { buildMacroDescription } from "../lib/macroLibrary";

// --- Harness ------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(MacroLibraryDialog, {
        isOpen: true,
        onClose: () => undefined,
      } as never),
    );
  });
  // Let the list + source loads settle.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function rows(): HTMLElement[] {
  return Array.from(container.querySelectorAll("[data-macro-library-item]"));
}

function buttonNamed(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;
}

beforeEach(() => {
  store.clear();
  hasProvider.value = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

// -----------------------------------------------------------------------------

describe("MacroLibraryDialog", () => {
  it("lists a macro that was auto-saved after recording", async () => {
    store.set("macro-macro1245", {
      id: "macro-macro1245",
      name: "Macro1245",
      description: buildMacroDescription({
        runtime: "objectScript",
        actionCount: 5,
        recordedAt: "2026-07-31T10:00:00.000Z",
      }),
      source: "async function macro1245(api) {}\n",
    });

    await render();

    expect(rows()).toHaveLength(1);
    expect(container.textContent).toContain("Macro1245");
    expect(container.textContent).toContain("Object script");
  });

  it("says so plainly when there is nothing saved yet", async () => {
    await render();
    expect(rows()).toHaveLength(0);
    expect(container.textContent).toContain("No script modules yet");
  });

  it("shows the source when a macro is selected", async () => {
    store.set("macro-m", {
      id: "macro-m",
      name: "M",
      description: buildMacroDescription({
        runtime: "notebook",
        actionCount: 1,
        recordedAt: "x",
      }),
      source: "Calcula.setCellValue(0, 0, '42');\n",
    });
    await render();

    await act(async () => {
      rows()[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.value).toContain("Calcula.setCellValue(0, 0, '42');");
  });

  it("offers Run for a QuickJS module", async () => {
    store.set("macro-m", {
      id: "macro-m",
      name: "M",
      description: buildMacroDescription({
        runtime: "notebook",
        actionCount: 1,
        recordedAt: "x",
      }),
      source: "Calcula.setCellValue(0, 0, '42');\n",
    });
    await render();
    await act(async () => {
      rows()[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const run = buttonNamed("Run");
    expect(run).toBeDefined();
    expect(run!.disabled).toBe(false);

    await act(async () => {
      run!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("2 cell(s) changed");
  });

  it("does NOT offer Run for an object-script macro, and explains why", async () => {
    store.set("macro-m", {
      id: "macro-m",
      name: "M",
      description: buildMacroDescription({
        runtime: "objectScript",
        actionCount: 1,
        recordedAt: "x",
      }),
      source: "async function m(api) {}\n",
    });
    await render();
    await act(async () => {
      rows()[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(buttonNamed("Run")!.disabled).toBe(true);
    expect(container.textContent).toContain("Attach it to a button");
  });

  it("disables Add Button when the Controls extension is absent", async () => {
    hasProvider.value = false;
    store.set("macro-m", {
      id: "macro-m",
      name: "M",
      description: null,
      source: "x",
    });
    await render();
    await act(async () => {
      rows()[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const add = buttonNamed("Add Button")!;
    expect(add.disabled).toBe(true);
    expect(add.title).toContain("Controls extension is not loaded");
  });
});

describe("buttonEntryPoint", () => {
  it("calls the function the recorded module actually declares", () => {
    const source = "async function macro1245(api) {\n  await api.setCellValue(0,0,'x');\n}\n";
    const wrapped = buttonEntryPoint(source, "Macro1245");
    expect(wrapped).toContain("await macro1245(button.api);");
    expect(wrapped).toContain("function setup(button) {");
    expect(wrapped).toContain(source.trimEnd());
  });

  it("finds the entry point of a hand-edited module", () => {
    expect(functionNameOf("function doIt(api) {}", "X")).toBe("doIt");
  });

  it("falls back to a usable identifier when nothing is declared", () => {
    expect(functionNameOf("// nothing here", "Macro 12:45")).toBe("Macro1245");
    expect(functionNameOf("// nothing here", "12:45")).toBe("recordedMacro");
  });
});
