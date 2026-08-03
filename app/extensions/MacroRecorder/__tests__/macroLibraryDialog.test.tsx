//! FILENAME: app/extensions/MacroRecorder/__tests__/macroLibraryDialog.test.tsx
// PURPOSE: The listing surface shows a saved macro and RUNS it — in whichever
//          runtime its source was written for — and every control it refuses to
//          offer looks refused.
// CONTEXT: "The macro must be findable afterwards" is the requirement the whole
//          auto-save rests on. "Run must actually run" is the requirement the
//          user filed twice. This renders the real dialog over a fake module
//          store and asserts what the user sees and what gets invoked.

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

/** The one-shot object-script mount the dialog uses for `api.*` macros. */
const runOnce = vi.fn(async (_options: unknown) => undefined);

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
  runObjectScriptOnce: (options: unknown) => runOnce(options),
}));

vi.mock("@api/notifications", () => ({ showToast: vi.fn() }));
vi.mock("@api/grid", () => ({ refreshGridData: vi.fn() }));

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
  getAnchorCell: () => ({ row: 0, col: 0 }),
  resolveAnchorSheetIndex: async () => 0,
}));

const hasProvider = { value: true };
vi.mock("@api/buttonControlService", () => ({
  hasButtonControlProvider: () => hasProvider.value,
  requireButtonControlProvider: () => {
    throw new Error("not used in this test");
  },
}));

import { MacroLibraryDialog } from "../components/MacroLibraryDialog";
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

async function selectFirstRow(): Promise<void> {
  await act(async () => {
    rows()[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function press(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  store.clear();
  runOnce.mockClear();
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
    await selectFirstRow();

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
    await selectFirstRow();

    const run = buttonNamed("Run");
    expect(run).toBeDefined();
    expect(run!.disabled).toBe(false);

    await press(run!);
    expect(container.textContent).toContain("2 cell(s) changed");
  });

  it("RUNS an object-script macro through a one-shot object-script mount", async () => {
    // THE REGRESSION UNDER TEST. Run used to be `disabled` for this flavour —
    // and because the footer styles background/colour/cursor inline, the
    // disabled button rendered exactly like an enabled one. Clicking it
    // produced no event, no toast and no error: "nothing happens", twice.
    const source =
      "async function m(api) { await api.setCellValue(0, 0, 'x'); }\n" +
      "function setup(context) { return m(context.api); }\n";
    store.set("macro-m", {
      id: "macro-m",
      name: "M",
      description: buildMacroDescription({
        runtime: "objectScript",
        actionCount: 1,
        recordedAt: "x",
      }),
      source,
    });
    await render();
    await selectFirstRow();

    const run = buttonNamed("Run (object script)");
    expect(run).toBeDefined();
    expect(run!.disabled).toBe(false);
    // The reason it takes the other route is ON SCREEN, not only in a tooltip.
    expect(container.textContent).toMatch(/OBJECT-SCRIPT runtime/i);
    expect(
      container.querySelector('[data-macro-run-route="objectScript"]'),
    ).not.toBeNull();

    await press(run!);

    expect(runOnce).toHaveBeenCalledTimes(1);
    const arg = runOnce.mock.calls[0][0] as {
      source: string;
      accessLevel: string;
      objectType: string;
    };
    expect(arg.source).toBe(source);
    expect(arg.accessLevel).toBe("unlocked");
    expect(arg.objectType).toBe("workbook");
    expect(container.textContent).toContain("[OK] Finished in");
  });

  it("reports a failed object-script run instead of claiming success", async () => {
    runOnce.mockRejectedValueOnce(
      new Error("blocked by the Script Security setting"),
    );
    store.set("macro-m", {
      id: "macro-m",
      name: "M",
      description: buildMacroDescription({
        runtime: "objectScript",
        actionCount: 1,
        recordedAt: "x",
      }),
      source: "function setup(context) {}\n",
    });
    await render();
    await selectFirstRow();
    await press(buttonNamed("Run (object script)")!);

    expect(container.textContent).toContain(
      "blocked by the Script Security setting",
    );
    expect(container.textContent).not.toContain("[OK]");
  });

  it("gives every DISABLED footer button a visible disabled state", async () => {
    // Nothing selected: Delete / Add Button / Save / Run are all disabled. A
    // disabled button fires no onClick, so it must not look pressable — that
    // exact mismatch is what made the previous "fix" invisible.
    await render();
    for (const label of ["Delete", "Add Button", "Save", "Run"]) {
      const btn = buttonNamed(label)!;
      expect(btn.disabled).toBe(true);
      expect(btn.style.cursor).toBe("not-allowed");
      expect(Number(btn.style.opacity)).toBeLessThan(1);
    }
    // Close is never disabled and must stay fully legible.
    expect(buttonNamed("Close")!.disabled).toBe(false);
    expect(buttonNamed("Close")!.style.cursor).toBe("pointer");
  });

  it("disables Add Button when the Controls extension is absent — and says why on screen", async () => {
    hasProvider.value = false;
    store.set("macro-m", {
      id: "macro-m",
      name: "M",
      description: null,
      source: "x",
    });
    await render();
    await selectFirstRow();

    const add = buttonNamed("Add Button")!;
    expect(add.disabled).toBe(true);
    expect(add.title).toContain("Controls extension is not loaded");
    expect(add.style.cursor).toBe("not-allowed");
    // A tooltip is not a message: the refusal has to be readable without
    // hovering the control that is refusing.
    expect(container.querySelector("[data-macro-no-buttons]")).not.toBeNull();
  });

  it("surfaces a module whose record cannot be read, instead of listing it as ordinary", async () => {
    store.set("broken", {
      id: "broken",
      name: "Broken",
      description: null,
      source: "x",
    });
    // Make the detail read fail while the summary still lists it.
    const original = store.get.bind(store);
    vi.spyOn(store, "get").mockImplementation((id: string) => {
      if (id === "broken") return undefined;
      return original(id);
    });

    await render();
    expect(container.textContent).toContain("unreadable");
    vi.restoreAllMocks();
  });
});
