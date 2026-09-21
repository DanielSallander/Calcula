//! FILENAME: app/extensions/MacroRecorder/__tests__/recordedMacroDialogLayout.test.tsx
// PURPOSE: The review dialog puts the editable source BESIDE the prose, and the
//          hooks seven E2E specs steer by survive that re-parenting.
// CONTEXT: The dialog's whole point is the source box (see the component's file
//          header), and stacked it competed with every banner for height. The
//          layout is now two panes — but a layout change is exactly the kind of
//          edit that silently drops a `data-*` attribute, and the specs that
//          drive this dialog address it by attribute only. So this test pins
//          both: the two panes exist, and every attribute hook is still there.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { MacroTarget } from "../lib/types";

// --- The recording under review ----------------------------------------------

interface FakeRecording {
  name: string;
  actions: unknown[];
  target: MacroTarget;
  recordedAt: string;
  saved: { id: string; name: string; runtime: MacroTarget } | null;
  saveError: string | null;
}

let recording: FakeRecording | null = null;
/** What `moduleRuntimeSupport` answers — drives the module-runtime banner. */
let runtimeSupported = true;
/** Actions the codegen could not express — drives the unsupported banner. */
let unsupported: string[] = [];

vi.mock("@api/notifications", () => ({ showToast: vi.fn() }));
vi.mock("@api/lib", () => ({ requestMacroToNotebook: vi.fn() }));
vi.mock("@api/locale", () => ({ getCachedLocale: () => ({ decimalSeparator: "." }) }));

// PARTIAL: `a1.ts` pulls `colLetter` from this same module, so a wholesale
// replacement breaks the anchor field before the layout is even rendered.
vi.mock("../lib/actionCodegen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/actionCodegen")>()),
  generateMacroSource: () => ({
    source: "// Macro1\nfunction macro1() {\n  api.setValue(0, 0, 1);\n}\n",
    unsupported,
  }),
}));

vi.mock("../lib/flow", () => ({
  getAnchorCell: () => ({ row: 0, col: 0 }),
  getFinishedRecording: () => recording,
  moduleRuntimeSupport: () => ({
    supported: runtimeSupported,
    reasons: runtimeSupported ? [] : ["setFillColor"],
  }),
  resolveAnchorSheetIndex: async () => 0,
  setFinishedSavedModule: vi.fn(),
}));

vi.mock("../lib/buttonScript", () => ({
  designModeHint: () => "",
  linkMacroButton: vi.fn(async () => undefined),
}));

vi.mock("../lib/macroLibrary", () => ({
  describeMacroRuntime: (r: string) => r,
  saveMacroModule: vi.fn(async () => ({ id: "m1", name: "Macro1", runtime: "objectScript" })),
}));

import { RecordedMacroDialog } from "../components/RecordedMacroDialog";

// --- Harness ------------------------------------------------------------------

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

function render(): void {
  act(() => {
    root.render(<RecordedMacroDialog isOpen onClose={() => {}} />);
  });
}

function dialog(): HTMLElement {
  const el = host.querySelector("[data-macro-result-dialog]");
  if (!el) throw new Error("the result dialog did not render");
  return el as HTMLElement;
}

beforeEach(() => {
  recording = {
    name: "Macro1",
    actions: [{ kind: "setValue" }],
    target: "objectScript",
    recordedAt: "2026-09-21T10:00:00Z",
    saved: { id: "m1", name: "Macro1", runtime: "objectScript" },
    saveError: null,
  };
  runtimeSupported = true;
  unsupported = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

describe("RecordedMacroDialog layout", () => {
  it("renders the prose and the source as two side-by-side panes", () => {
    render();

    const settings = dialog().querySelector('[data-testid="recorded-macro-settings"]');
    const sourcePane = dialog().querySelector('[data-testid="recorded-macro-source"]');
    expect(settings).not.toBeNull();
    expect(sourcePane).not.toBeNull();

    // SIBLINGS, not nested: a source pane inside the scrolling prose column is
    // the stacked layout again, and the code scrolls away with everything else.
    expect(settings!.parentElement).toBe(sourcePane!.parentElement);
    expect(settings!.contains(sourcePane!)).toBe(false);

    // The row that makes them side by side.
    const body = settings!.parentElement as HTMLElement;
    expect(body.style.display).toBe("flex");
    expect(body.style.flexDirection).toBe("row");
  });

  it("gives the source pane the textarea and nothing else", () => {
    render();

    const sourcePane = dialog().querySelector(
      '[data-testid="recorded-macro-source"]',
    ) as HTMLElement;
    const boxes = sourcePane.querySelectorAll("textarea");
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.value).toContain("function macro1()");

    // The prose column must NOT hold a copy of the editor.
    const settings = dialog().querySelector(
      '[data-testid="recorded-macro-settings"]',
    ) as HTMLElement;
    expect(settings.querySelectorAll("textarea")).toHaveLength(0);

    // `styles.code`'s own 220 minimum would push the box out under the footer
    // inside a flex pane, so the instance lowers it.
    expect(boxes[0]!.style.minHeight).toBe("160px");
  });

  it("keeps every data-macro hook the E2E specs steer by", () => {
    unsupported = ["setFillColor"];
    runtimeSupported = false;
    render();

    const box = dialog();
    expect(box.querySelector("[data-macro-saved-banner]")).not.toBeNull();
    expect(box.querySelector("[data-macro-unsupported]")).not.toBeNull();
    expect(box.querySelector('[data-macro-module-runtime="no"]')).not.toBeNull();
    expect(box.querySelector("[data-macro-result-close]")).not.toBeNull();
  });

  it("shows the save-error banner in the prose pane when the auto-save failed", () => {
    recording = { ...recording!, saved: null, saveError: "disk full" };
    render();

    const settings = dialog().querySelector(
      '[data-testid="recorded-macro-settings"]',
    ) as HTMLElement;
    const banner = settings.querySelector("[data-macro-save-error]");
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain("disk full");
    expect(dialog().querySelector("[data-macro-saved-banner]")).toBeNull();
  });

  it("puts a refusal between the body and the footer, never inside the scroller", async () => {
    render();

    // Refuse: "Save as Button Script" with unsaved edits in the box.
    const editor = dialog().querySelector("textarea") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setter.call(editor, "// edited\n");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const save = [...dialog().querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Save as Button Script"),
    );
    expect(save).toBeTruthy();
    await act(async () => {
      save!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const refusal = [...dialog().querySelectorAll("div")].find((d) =>
      d.textContent?.startsWith("You have unsaved edits in the source box."),
    );
    expect(refusal).toBeTruthy();

    // The reason a footer button refused sits next to that button — not in a
    // column the user may have scrolled away from.
    const settings = dialog().querySelector('[data-testid="recorded-macro-settings"]');
    expect(settings!.contains(refusal!)).toBe(false);
    expect(refusal!.parentElement).toBe(dialog());
  });
});
