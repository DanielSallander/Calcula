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
  /** The `.calp` this module was pulled from; absent for the user's own code. */
  sourcePackage?: string | null;
  /** Workbook-wide, or attached to one sheet. Round-trips through every write. */
  scope?: { type: string; name?: string };
}
const store = new Map<string, StoredScript>();
/**
 * Ids whose per-record READ fails while the listing still names them.
 *
 * Faithful to the real backend: `list_scripts` answers from the summary index,
 * so a record whose `get_script` fails is still LISTED and still clickable.
 */
const unreadable = new Set<string>();

/** The one-shot object-script mount the dialog uses for `api.*` macros. */
const runOnce = vi.fn(async (_options: unknown) => undefined);

vi.mock("@api", async () => {
  // The REAL origin rule: a provenance decision in a test must agree with the one
  // definition every gate reads, or the test pins a rule the product does not have.
  const origin = await vi.importActual<typeof import("@api/scriptHost/scriptOrigin")>(
    "@api/scriptHost/scriptOrigin",
  );
  return {
    scriptOriginForStoredRecord: origin.scriptOriginForStoredRecord,
    originTagTitle: origin.originTagTitle,

  listWorkbookScripts: async () =>
    [...store.values()].map((s) => ({ id: s.id, name: s.name })),
  getWorkbookScript: async (id: string) => {
    if (unreadable.has(id)) throw new Error(`Script '${id}' could not be read`);
    const found = store.get(id);
    if (!found) throw new Error(`Script '${id}' not found`);
    return found;
  },
  // The generic module inventory the library lists through. Reads each record
  // through `get`, so a record that lists but cannot be READ comes back flagged.
  listWorkbookScriptRecords: async () =>
    [...store.values()].map((summary) => {
      const found = unreadable.has(summary.id) ? undefined : store.get(summary.id);
      return found
        ? {
            id: found.id,
            name: found.name,
            description: found.description ?? null,
            source: found.source,
            sourcePackage: found.sourcePackage ?? null,
            scope: found.scope,
            loadError: null,
          }
        : {
            id: summary.id,
            name: summary.name,
            description: null,
            source: "",
            sourcePackage: null,
            loadError: `Script '${summary.id}' could not be read`,
          };
    }),
  parseModuleScriptRuntime: (description: string | null | undefined) => {
    if (typeof description !== "string") return null;
    const match = /\bruntime=(objectScript|notebook)\b/.exec(description);
    return match ? match[1] : null;
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
  };
});

vi.mock("@api/notifications", () => ({ showToast: vi.fn() }));
vi.mock("@api/grid", () => ({ refreshGridData: vi.fn() }));

/**
 * The consent/confirm door, doubled in its TAURI shape.
 *
 * `mockReturnValue(Promise.resolve(...))`, never a synchronous boolean: under
 * Tauri `confirm` resolves asynchronously, and a synchronous double is exactly
 * what let `if (!window.confirm(m))` — which tests `!Promise`, always false —
 * pass review six times. A test that cannot tell those apart cannot pin a gate.
 */
const confirmAsync = vi.fn(() => Promise.resolve(true));
vi.mock("@api/dialogs", () => ({
  confirmAsync: (...args: unknown[]) => confirmAsync(...(args as [])),
  alertAsync: vi.fn(() => Promise.resolve(undefined)),
  promptAsync: vi.fn(() => Promise.resolve(null)),
}));

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
import {
  registerScriptEditorProvider,
  resetScriptEditorProvider,
} from "@api/scriptEditorService";

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
  unreadable.clear();
  runOnce.mockClear();
  confirmAsync.mockClear();
  confirmAsync.mockReturnValue(Promise.resolve(true));
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

// =============================================================================
// A PUBLISHER'S MACRO LOOKS LIKE A PUBLISHER'S MACRO.
//
// A `.calp` may ship module scripts; `core/calp/src/pull.rs` materializes them
// into the subscriber's workbook stamped with `source_package`, and they list
// here beside the user's own. The library dropped that stamp, so the two were
// indistinguishable — and the consent model rests entirely on the user being
// able to tell them apart BEFORE pressing Run.
// =============================================================================

describe("MacroLibraryDialog provenance", () => {
  const OBJECT_SCRIPT_MACRO = {
    id: "macro-vendor-close",
    name: "Vendor close",
    description: buildMacroDescription({
      runtime: "objectScript",
      actionCount: 2,
      recordedAt: "2026-09-01T10:00:00.000Z",
    }),
    source: "async function vendorClose(api) {}\n",
  };

  it("badges the list row with the application it came from", async () => {
    store.set(OBJECT_SCRIPT_MACRO.id, {
      ...OBJECT_SCRIPT_MACRO,
      sourcePackage: "Acme Finance Pack",
    });
    await render();

    const badge = container.querySelector("[data-macro-source-package]");
    expect(badge).not.toBeNull();
    expect(badge!.getAttribute("data-macro-source-package")).toBe("Acme Finance Pack");
    expect(badge!.textContent).toBe("Acme Finance Pack");
  });

  it("leaves the user's own macro unbadged — local is the baseline", async () => {
    store.set(OBJECT_SCRIPT_MACRO.id, { ...OBJECT_SCRIPT_MACRO, sourcePackage: null });
    await render();

    expect(container.querySelector("[data-macro-source-package]")).toBeNull();
  });

  it("states in the detail pane that the user did not write it, before Run", async () => {
    store.set(OBJECT_SCRIPT_MACRO.id, {
      ...OBJECT_SCRIPT_MACRO,
      sourcePackage: "Acme Finance Pack",
    });
    await render();
    await selectFirstRow();

    const note = container.querySelector("[data-macro-provenance]");
    expect(note).not.toBeNull();
    expect(note!.textContent).toContain("Acme Finance Pack");
    expect(note!.textContent).toMatch(/you did not write this macro/i);
    // ...and the Run note no longer promises the unlocked tier for it.
    const routeNote = container.querySelector("[data-macro-run-route]")!;
    expect(routeNote.textContent).toMatch(/restricted object script/i);
  });

  it("Run asks for the restricted tier and names the stored record", async () => {
    store.set(OBJECT_SCRIPT_MACRO.id, {
      ...OBJECT_SCRIPT_MACRO,
      sourcePackage: "Acme Finance Pack",
    });
    await render();
    await selectFirstRow();

    await press(buttonNamed("Run (object script)")!);

    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(runOnce.mock.calls[0][0]).toMatchObject({
      accessLevel: "restricted",
      scriptId: OBJECT_SCRIPT_MACRO.id,
    });
  });
});

// =============================================================================
// EDITING A PUBLISHER'S MACRO — the content-keyed bypass, on screen.
//
// The Rust consent gate matches by EXACT SOURCE. Typing one character into this
// textarea therefore made a publisher's macro unrecognisable to it: no stored
// module held those bytes, so no owner was found, so nothing refused the run.
// The whole package-consent model was one keystroke deep.
//
// The fix is the escape hatch that gate already documents — a LOCAL record
// holding the source authorises it — made real: Save becomes "Save as my copy"
// and writes a new, unstamped module. The publisher's record is never touched,
// so a refresh from the application still matches the hash the user approved.
// =============================================================================

describe("MacroLibraryDialog — a publisher's macro is forked, never overwritten", () => {
  const THEIRS = {
    id: "macro-vendor-close",
    name: "Vendor close",
    description: buildMacroDescription({
      runtime: "notebook",
      actionCount: 2,
      recordedAt: "2026-09-01T10:00:00.000Z",
    }),
    source: "Calcula.setCellValue(0, 0, 'theirs');\n",
    sourcePackage: "Acme Finance Pack",
  };

  async function editSource(text: string): Promise<void> {
    const area = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(area, text);
      area.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
  }

  async function editName(text: string): Promise<void> {
    const input = container.querySelector("input") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
  }

  it("REFUSES Run once the publisher's code has been edited, and says why on screen", async () => {
    store.set(THEIRS.id, { ...THEIRS });
    await render();
    await selectFirstRow();

    // Before the edit: Run is live, because this is the application's own code.
    expect(buttonNamed("Run")!.disabled).toBe(false);

    await editSource("Calcula.setCellValue(0, 0, 'mine');\n");

    const run = buttonNamed("Run")!;
    expect(run.disabled).toBe(true);
    expect(run.style.cursor).toBe("not-allowed");
    // A tooltip is not a message: the refusal is readable without hovering.
    const note = container.querySelector("[data-macro-fork-required]");
    expect(note, "no on-screen explanation of the refusal").not.toBeNull();
    expect(note!.textContent).toContain("Acme Finance Pack");
    expect(note!.textContent).toMatch(/Save as my copy/i);
  });

  // THE TWO SURFACES MUST AGREE ABOUT WHAT THE OTHER ONE DOES. The Object
  // Script Editor opens a publisher's module READ-ONLY (it may be read, run and
  // stepped through, never edited), because an edit stored under the
  // application's name stops matching the code the user consented to. Sending
  // someone there to "edit" without saying so sends them to a window that will
  // silently refuse their keystrokes.
  it("says the Object Script Editor is read-only for a publisher's macro", async () => {
    store.set(THEIRS.id, { ...THEIRS });
    // The button only speaks about the editor when the editor is THERE — without
    // a provider it correctly says the extension is not loaded instead.
    registerScriptEditorProvider({ openMacroInEditor: async () => {} });
    try {
      await render();
      await selectFirstRow();
    } finally {
      // Registered for this assertion only; the module-level provider is global.
      resetScriptEditorProvider();
    }

    const edit = container.querySelector("[data-macro-edit-in-editor]") as HTMLButtonElement;
    const title = edit.getAttribute("title") ?? "";
    expect(title).toMatch(/read-only/i);
    expect(title).toContain("Acme Finance Pack");
    expect(title).toMatch(/Save as my copy/i);
  });

  it("offers the way out as a CONTROL, not only as prose", async () => {
    store.set(THEIRS.id, { ...THEIRS });
    await render();
    await selectFirstRow();
    await editSource("Calcula.setCellValue(0, 0, 'mine');\n");

    const save = container.querySelector("[data-macro-save-button]") as HTMLButtonElement;
    expect(save.getAttribute("data-macro-save-mode")).toBe("fork");
    expect(save.textContent).toBe("Save as my copy");
    expect(save.disabled).toBe(false);
  });

  it("forking writes a NEW local module and leaves the publisher's byte-for-byte", async () => {
    store.set(THEIRS.id, { ...THEIRS });
    await render();
    await selectFirstRow();
    await editSource("Calcula.setCellValue(0, 0, 'mine');\n");

    await press(container.querySelector("[data-macro-save-button]") as HTMLButtonElement);

    // The application's record is exactly as it arrived — so a refresh from the
    // application still matches the consent hash the user approved.
    expect(store.get(THEIRS.id)).toEqual(THEIRS);

    const copy = [...store.values()].find((s) => s.id !== THEIRS.id);
    expect(copy, "no local copy was written").toBeDefined();
    expect(copy!.source).toBe("Calcula.setCellValue(0, 0, 'mine');\n");
    expect(copy!.sourcePackage ?? null).toBeNull();
    // The runtime marker rides along, or the copy would route to the wrong
    // interpreter; the lineage is written down rather than hidden.
    expect(copy!.description).toContain("runtime=notebook");
    expect(copy!.description).toContain("Acme Finance Pack");
  });

  it("the copy is then selected, unbadged, and runnable", async () => {
    store.set(THEIRS.id, { ...THEIRS });
    await render();
    await selectFirstRow();
    await editSource("Calcula.setCellValue(0, 0, 'mine');\n");
    await press(container.querySelector("[data-macro-save-button]") as HTMLButtonElement);

    // Selection follows the copy, so the next Run is unambiguously the user's.
    expect(rows()).toHaveLength(2);
    expect(container.querySelector("[data-macro-fork-required]")).toBeNull();
    expect(container.querySelector("[data-macro-provenance]")).toBeNull();
    const run = buttonNamed("Run")!;
    expect(run.disabled).toBe(false);
  });

  it("a RENAME still writes back in place — with the stamp intact", async () => {
    store.set(THEIRS.id, { ...THEIRS });
    await render();
    await selectFirstRow();
    await editName("Vendor close (theirs)");

    const save = container.querySelector("[data-macro-save-button]") as HTMLButtonElement;
    // A rename changes no executable byte, so it is not a fork.
    expect(save.getAttribute("data-macro-save-mode")).toBe("inPlace");
    await press(save);

    expect(store.size).toBe(1);
    const stored = store.get(THEIRS.id)!;
    expect(stored.name).toBe("Vendor close (theirs)");
    // THE LAUNDERING THIS CLOSES: the write used to omit the field entirely.
    expect(stored.sourcePackage).toBe("Acme Finance Pack");
  });

  it("does not promise a tier for a macro the module runtime runs", async () => {
    store.set(THEIRS.id, { ...THEIRS });
    await render();
    await selectFirstRow();

    const note = container.querySelector("[data-macro-provenance]")!;
    expect(note.textContent).toContain("Acme Finance Pack");
    // The module runtime is the tier-less QuickJS interpreter; what protects the
    // user on that route is consent, and that is what the note names.
    expect(note.textContent).not.toMatch(/restricted/i);
    expect(note.textContent).toMatch(/consent/i);
  });

  it("the user's own macro is untouched by any of this", async () => {
    store.set("macro-mine", {
      id: "macro-mine",
      name: "Mine",
      description: THEIRS.description,
      source: "Calcula.setCellValue(0, 0, 'v1');\n",
      sourcePackage: null,
    });
    await render();
    await selectFirstRow();
    await editSource("Calcula.setCellValue(0, 0, 'v2');\n");

    const save = container.querySelector("[data-macro-save-button]") as HTMLButtonElement;
    expect(save.getAttribute("data-macro-save-mode")).toBe("inPlace");
    expect(buttonNamed("Run")!.disabled).toBe(false);

    await press(save);
    expect(store.size).toBe(1);
    expect(store.get("macro-mine")!.source).toBe("Calcula.setCellValue(0, 0, 'v2');\n");
  });
});

// =============================================================================
// WHAT IS SHOWN AND WHAT THE BUTTONS ACT ON MUST BE THE SAME MODULE.
//
// Three defects, one theme. A failed load left the PREVIOUS module in `loaded`
// while the list highlighted the row the user had just clicked, so Run, Delete
// and Save all acted on a module that was no longer on screen. A rename sent a
// hard-coded workbook scope, so it moved a sheet-scoped macro to the whole
// workbook. And switching rows threw an edited buffer away with no prompt — on
// the ONE route the product tells users to take when adapting a distributed
// macro, because the Object Script Editor is read-only for those and sends them
// here to press "Save as my copy".
// =============================================================================

describe("MacroLibraryDialog — the selected module and the acted-on module agree", () => {
  const GOOD: StoredScript = {
    id: "macro-good",
    name: "Good macro",
    description: buildMacroDescription({
      runtime: "notebook",
      actionCount: 1,
      recordedAt: "2026-09-01T10:00:00.000Z",
    }),
    source: "Calcula.setCellValue(0, 0, 'good');\n",
  };
  const BROKEN: StoredScript = {
    id: "macro-broken",
    name: "Broken macro",
    description: buildMacroDescription({
      runtime: "notebook",
      actionCount: 1,
      recordedAt: "2026-09-02T10:00:00.000Z",
    }),
    source: "Calcula.setCellValue(0, 0, 'broken');\n",
  };

  async function selectRow(index: number): Promise<void> {
    await act(async () => {
      rows()[index].dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function editSource(text: string): Promise<void> {
    const area = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(area, text);
      area.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
  }

  async function editName(text: string): Promise<void> {
    const input = container.querySelector("input") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
  }

  function textarea(): HTMLTextAreaElement | null {
    return container.querySelector("textarea");
  }

  // -- (2) A FAILED LOAD LEAVES NOTHING LOADED --------------------------------

  it("clears the loaded module when the one the user clicked cannot be read", async () => {
    store.set(GOOD.id, { ...GOOD });
    store.set(BROKEN.id, { ...BROKEN });
    unreadable.add(BROKEN.id);
    await render();

    await selectRow(0);
    expect(textarea()!.value).toContain("'good'");

    await selectRow(1);

    // THE MISMATCH THIS CLOSES: the previous macro's source stayed in the
    // textarea (and in `loaded`) while row 1 was highlighted.
    expect(textarea()).toBeNull();
    expect(container.textContent).not.toContain("'good'");
    const nothing = container.querySelector("[data-macro-nothing-loaded]");
    expect(nothing, "a failed load left a module loaded").toBeTruthy();
  });

  it("says WHICH module failed, and says it where a failed load can be seen", async () => {
    store.set(GOOD.id, { ...GOOD });
    store.set(BROKEN.id, { ...BROKEN });
    unreadable.add(BROKEN.id);
    await render();
    await selectRow(0);
    await selectRow(1);

    // The message used to be rendered INSIDE the "something is loaded" branch,
    // so the one failure that matters most produced no text at all.
    const error = container.querySelector("[data-macro-error]");
    expect(error, "a failed load rendered no message").toBeTruthy();
    expect(error!.textContent).toContain("Broken macro");
    expect(error!.textContent).toMatch(/could not be read/i);
  });

  it("refuses Run, Delete, Save and Add Button rather than aiming them elsewhere", async () => {
    store.set(GOOD.id, { ...GOOD });
    store.set(BROKEN.id, { ...BROKEN });
    unreadable.add(BROKEN.id);
    await render();
    await selectRow(0);
    await selectRow(1);

    // Delete is the one that cannot be taken back. A user who reads "could not
    // be read" and presses Delete to clear the broken entry would have deleted
    // "Good macro" instead.
    expect(buttonNamed("Delete")!.disabled).toBe(true);
    expect(buttonNamed("Run")!.disabled).toBe(true);
    expect(
      (container.querySelector("[data-macro-save-button]") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (container.querySelector("[data-macro-add-button]") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (container.querySelector("[data-macro-edit-in-editor]") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    // ...and the macro those controls used to point at is still there.
    expect(store.has(GOOD.id)).toBe(true);
  });

  it("loads normally again once a readable module is chosen", async () => {
    store.set(GOOD.id, { ...GOOD });
    store.set(BROKEN.id, { ...BROKEN });
    unreadable.add(BROKEN.id);
    await render();
    await selectRow(1);
    expect(textarea()).toBeNull();

    await selectRow(0);
    expect(textarea()!.value).toContain("'good'");
    expect(buttonNamed("Run")!.disabled).toBe(false);
    expect(container.querySelector("[data-macro-error]")).toBeNull();
  });

  // -- (3) THE STORED SCOPE SURVIVES A RENAME AND A FORK ----------------------

  const SHEET_SCOPED: StoredScript = {
    id: "macro-sheet",
    name: "Sheet close",
    description: buildMacroDescription({
      runtime: "notebook",
      actionCount: 1,
      recordedAt: "2026-09-01T10:00:00.000Z",
    }),
    source: "Calcula.setCellValue(0, 0, 'scoped');\n",
    scope: { type: "sheet", name: "Budget" },
  };

  it("a rename leaves a sheet-scoped macro on its sheet", async () => {
    store.set(SHEET_SCOPED.id, { ...SHEET_SCOPED });
    await render();
    await selectRow(0);
    await editName("Sheet close (renamed)");

    await press(container.querySelector("[data-macro-save-button]") as HTMLButtonElement);

    const stored = store.get(SHEET_SCOPED.id)!;
    expect(stored.name).toBe("Sheet close (renamed)");
    // THE SILENT WIDENING THIS CLOSES: the write sent `{ type: "workbook" }`
    // unconditionally, so a rename — which changes no executable byte — made the
    // macro resolve from every sheet in the workbook.
    expect(stored.scope).toEqual({ type: "sheet", name: "Budget" });
  });

  it("an edit to the user's own macro leaves its scope alone too", async () => {
    store.set(SHEET_SCOPED.id, { ...SHEET_SCOPED });
    await render();
    await selectRow(0);
    await editSource("Calcula.setCellValue(0, 0, 'edited');\n");

    await press(container.querySelector("[data-macro-save-button]") as HTMLButtonElement);

    const stored = store.get(SHEET_SCOPED.id)!;
    expect(stored.source).toBe("Calcula.setCellValue(0, 0, 'edited');\n");
    expect(stored.scope).toEqual({ type: "sheet", name: "Budget" });
  });

  it('"Save as my copy" gives the copy the original\'s scope', async () => {
    const theirs: StoredScript = {
      ...SHEET_SCOPED,
      id: "macro-vendor-scoped",
      name: "Vendor scoped",
      sourcePackage: "Acme Finance Pack",
    };
    store.set(theirs.id, { ...theirs });
    await render();
    await selectRow(0);
    await editSource("Calcula.setCellValue(0, 0, 'mine');\n");

    const save = container.querySelector("[data-macro-save-button]") as HTMLButtonElement;
    expect(save.getAttribute("data-macro-save-mode")).toBe("fork");
    await press(save);

    const copy = [...store.values()].find((s) => s.id !== theirs.id)!;
    expect(copy.source).toBe("Calcula.setCellValue(0, 0, 'mine');\n");
    // A fork differs from its original in an id and a stamp. Not in where it
    // resolves from — that would hand the user a macro that behaves differently
    // from the one they were adapting.
    expect(copy.scope).toEqual({ type: "sheet", name: "Budget" });
    // ...and the publisher's record is byte-for-byte as it arrived, scope too.
    expect(store.get(theirs.id)).toEqual(theirs);
  });

  // -- (4) AN EDITED BUFFER IS NOT DISCARDED WITHOUT ASKING -------------------

  const VENDOR: StoredScript = {
    id: "macro-vendor",
    name: "Vendor close",
    description: buildMacroDescription({
      runtime: "notebook",
      actionCount: 2,
      recordedAt: "2026-09-01T10:00:00.000Z",
    }),
    source: "Calcula.setCellValue(0, 0, 'theirs');\n",
    sourcePackage: "Acme Finance Pack",
  };

  it("keeps the edited buffer when the user refuses to discard it", async () => {
    store.set(VENDOR.id, { ...VENDOR });
    store.set(GOOD.id, { ...GOOD });
    await render();
    await selectRow(0);
    await editSource("Calcula.setCellValue(0, 0, 'mine');\n");

    // The Tauri shape: a Promise, resolving to the refusal.
    confirmAsync.mockReturnValue(Promise.resolve(false));
    await selectRow(1);

    // THE WORK ITSELF, asserted first: without the prompt this reads back as
    // "…'good'…" — the other module's source, and the user's edit gone.
    expect(textarea()!.value).toBe("Calcula.setCellValue(0, 0, 'mine');\n");
    expect(confirmAsync, "the buffer was discarded with no prompt").toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-macro-save-button]")!
      .getAttribute("data-macro-save-mode")).toBe("fork");
  });

  it("names the route that would have kept the work — 'Save as my copy'", async () => {
    store.set(VENDOR.id, { ...VENDOR });
    store.set(GOOD.id, { ...GOOD });
    await render();
    await selectRow(0);
    await editSource("Calcula.setCellValue(0, 0, 'mine');\n");

    confirmAsync.mockReturnValue(Promise.resolve(false));
    await selectRow(1);

    const message = String(confirmAsync.mock.calls[0][0]);
    expect(message).toContain("Vendor close");
    expect(message).toMatch(/unsaved edits/i);
    // The dialog told this user to come here and press that button; the prompt
    // that stands between them and losing the work must name it.
    expect(message).toMatch(/Save as my copy/i);
    expect(message).toContain("Acme Finance Pack");
  });

  it("discards and moves on when the user agrees", async () => {
    store.set(VENDOR.id, { ...VENDOR });
    store.set(GOOD.id, { ...GOOD });
    await render();
    await selectRow(0);
    await editSource("Calcula.setCellValue(0, 0, 'mine');\n");

    confirmAsync.mockReturnValue(Promise.resolve(true));
    await selectRow(1);

    expect(confirmAsync).toHaveBeenCalledTimes(1);
    expect(textarea()!.value).toBe(GOOD.source);
  });

  it("does not ask when there is nothing to lose", async () => {
    store.set(VENDOR.id, { ...VENDOR });
    store.set(GOOD.id, { ...GOOD });
    await render();
    await selectRow(0);

    // No edit: switching costs the user nothing, so a prompt would be noise —
    // and a prompt the user learns to click through is a prompt that stops
    // protecting them on the one occasion it matters.
    await selectRow(1);
    expect(confirmAsync).not.toHaveBeenCalled();
    expect(textarea()!.value).toBe(GOOD.source);
  });

  it("re-selecting the module already open never prompts", async () => {
    store.set(VENDOR.id, { ...VENDOR });
    store.set(GOOD.id, { ...GOOD });
    await render();
    await selectRow(0);
    await editSource("Calcula.setCellValue(0, 0, 'mine');\n");

    await selectRow(0);
    expect(confirmAsync).not.toHaveBeenCalled();
    expect(textarea()!.value).toBe("Calcula.setCellValue(0, 0, 'mine');\n");
  });
});
