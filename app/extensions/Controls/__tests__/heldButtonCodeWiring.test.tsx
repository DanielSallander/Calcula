//! FILENAME: app/extensions/Controls/__tests__/heldButtonCodeWiring.test.tsx
// PURPOSE: The WIRING of a button's held code (BUG-0257), not just its leaves:
//          an in-cell click on a button holding an application's code asks the
//          Rust button door and says ITS answer (phase 4: the door runs held
//          inline code only once its exact bytes are approved, and refuses it
//          otherwise -- the page no longer decides that from the metadata it
//          read); the Properties pane hides the editable OnSelect row on a held
//          button and shows the code read-only; and "Remove the application's
//          code" reaches the backend only after a confirm that showed the code.
//          (Review finding: `heldButtonCodeUi.test.tsx` tests its leaves in
//          isolation, so each wire could be cut silently.)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  properties: {} as Record<string, { valueType: string; value: string }>,
  toasts: [] as { message: string; options: unknown }[],
  /** Every backend command the page sent through @api. */
  sent: [] as { cmd: string; args: unknown }[],
  /** The button door's answer. */
  door: null as unknown,
  confirm: vi.fn(),
  removed: [] as unknown[][],
  setProperty: [] as unknown[][],
  /** Every "Make this my own" the pane sent: (sheet, row, col, shownOnSelect, shownMacroRef). */
  adopted: [] as unknown[][],
  /** When set, Rust refuses the adoption with this message. */
  adoptRefusal: null as string | null,
}));

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  invokeBackend: async (cmd: string, args?: unknown) => {
    h.sent.push({ cmd, args });
    return cmd === "run_control_action" ? h.door : undefined;
  },
}));
vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/notifications")>()),
  showToast: (message: string, options?: unknown) => h.toasts.push({ message, options }),
}));
vi.mock("@api/dialogs", () => ({ confirmAsync: (...a: unknown[]) => h.confirm(...a) }));
vi.mock("@api/workbookScripts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/workbookScripts")>()),
  listWorkbookScripts: async () => [],
  listWorkbookScriptRecords: async () => [],
}));
vi.mock("../lib/designMode", () => ({ getDesignMode: () => false }));
vi.mock("../lib/controlApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/controlApi")>()),
  getControlMetadata: async () => ({ controlType: "button", properties: h.properties }),
  setControlProperty: async (...a: unknown[]) => {
    h.setProperty.push(a);
    return { controlType: "button", properties: h.properties };
  },
  removeApplicationButtonCode: async (...a: unknown[]) => {
    h.removed.push(a);
    return { controlType: "button", properties: { onSelect: { valueType: "static", value: "" } } };
  },
  // Rust MOVES the held code into the live slot and drops the stamp.
  adoptHeldButtonCode: async (...a: unknown[]) => {
    h.adopted.push(a);
    if (h.adoptRefusal) throw h.adoptRefusal;
    return {
      controlType: "button",
      properties: {
        text: { valueType: "static", value: "Run report" },
        onSelect: { valueType: "static", value: String(a[3] ?? "") },
      },
    };
  },
}));
vi.mock("../../../src/api/lib", () => ({
  getAllStyles: async () => [{}, { button: true }],
  getCell: async () => ({ styleIndex: 1 }),
  applyFormatting: async () => {},
}));
vi.mock("../../../src/api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/api/grid")>()),
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: 0 } }),
}));

import { buttonClickInterceptor, refreshStyleCache } from "../Button/interceptors";
import { isCellReleaseClaim, type CellReleaseClaim } from "@api/cellClickInterceptors";

/**
 * An in-cell button's press is CLAIMED for its release (BUG-0258 design phase
 * 4: buttons act on release, sliding off cancels): nothing ran at the press.
 * Release it on the same cell, as Core's press session does.
 */
async function releaseOnTheButton(answer: unknown, row: number, col: number): Promise<void> {
  expect(isCellReleaseClaim(answer), "the button's press was not claimed for its release").toBe(true);
  await (answer as CellReleaseClaim).runAtRelease({ clientX: 0, clientY: 0, row, col });
}

import { PropertiesPane } from "../PropertiesPane/PropertiesPane";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
// jsdom has no ResizeObserver; the pane's code inputs observe their size.
if (!("ResizeObserver" in globalThis)) {
  Reflect.set(
    globalThis,
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
}

const STAMP = JSON.stringify({ workspace: "ws", application: "Sales", version: "1.2.0" });

/** A working copy's button: its code HELD, no live code. */
function heldButton(): Record<string, { valueType: string; value: string }> {
  return {
    text: { valueType: "static", value: "Run report" },
    heldOnSelect: { valueType: "static", value: "Report();" },
    heldFrom: { valueType: "static", value: STAMP },
  };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  h.properties = heldButton();
  h.toasts.length = 0;
  h.sent.length = 0;
  h.door = { kind: "nothing", message: null };
  h.removed.length = 0;
  h.setProperty.length = 0;
  h.adopted.length = 0;
  h.adoptRefusal = null;
  h.confirm.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

/** What the page sent, minus the door: a click must run nothing on its own. */
const pageRuns = () => h.sent.filter((c) => c.cmd === "run_script");
const doorAsked = () => h.sent.filter((c) => c.cmd === "run_control_action");

describe("an IN-CELL click on a held button", () => {
  const REFUSAL =
    "DISTRIBUTED_SCRIPT_NOT_CONSENTED: the button at Sheet1!A1 came with the application 'Sales', and you have " +
    "not approved its code, so it did not run. The approval screen, which shows the code, comes back the next " +
    "time this workbook is opened or the application is updated.";

  // SABOTAGE: answer a held button on the page again (read the metadata in
  // executeButtonAction and toast a held sentence instead of asking the door)
  // -> the door is never asked, red.
  it("asks the door, and says ITS refusal of code nobody approved -- naming the approval", async () => {
    h.door = { kind: "refused", reason: "notConsented", message: REFUSAL };
    await refreshStyleCache();
    await releaseOnTheButton(await buttonClickInterceptor(0, 0, { clientX: 0, clientY: 0 }), 0, 0);
    expect(doorAsked(), "the click decided a held button on the page").toHaveLength(1);
    expect(pageRuns()).toEqual([]);
    expect(h.toasts).toEqual([{ message: REFUSAL, options: { variant: "error" } }]);
    expect(h.toasts[0].message).not.toMatch(/does not run in a working copy/);
    // Rust recorded the refusal; the page records nothing more.
    expect(h.sent.map((c) => c.cmd)).not.toContain("audit_button_refusal");
  });

  it("and once its bytes are approved the door runs it: the click says nothing more than the repaint", async () => {
    h.door = {
      kind: "ran",
      result: { type: "success", output: [], cellsModified: 1, durationMs: 1, screenUpdating: true },
      unavailable: [],
    };
    let repainted = 0;
    const onRefresh = () => {
      repainted += 1;
    };
    window.addEventListener("grid:refresh", onRefresh);
    try {
      await refreshStyleCache();
      await releaseOnTheButton(await buttonClickInterceptor(0, 0, { clientX: 0, clientY: 0 }), 0, 0);
    } finally {
      window.removeEventListener("grid:refresh", onRefresh);
    }
    expect(doorAsked()).toHaveLength(1);
    expect(pageRuns(), "the page ran held code itself").toEqual([]);
    expect(repainted).toBe(1);
    expect(h.toasts).toEqual([]);
  });

  // Phase 3 of BUG-0257: the in-cell path used to ignore `macroRef` entirely,
  // so an application's LINKED button did nothing once it sat in a cell. It now
  // goes through the same one rule as a floating button: the door answers
  // `link`, and the phase-3 route runs it.
  //
  // SABOTAGE: drop the `link:` handler from clickButtonControl
  // (Controls/lib/controlClick.ts).
  it("runs a held macro LINK through the seam, as its application's macro, naming the button", async () => {
    h.door = { kind: "link" };
    const { registerMacroRunProvider, resetMacroRunProvider } = await import("@api/macroRunService");
    const runs: unknown[][] = [];
    const unregister = registerMacroRunProvider({
      runMacroByRef: async (...args: unknown[]) => {
        runs.push(args);
        return { status: "ran", name: "Report" };
      },
    });
    try {
      h.properties = {
        text: { valueType: "static", value: "Run report" },
        heldMacroRef: { valueType: "static", value: "macro-report" },
        heldFrom: { valueType: "static", value: STAMP },
      };
      await refreshStyleCache();
      await releaseOnTheButton(await buttonClickInterceptor(3, 1, { clientX: 0, clientY: 0 }), 3, 1);
      expect(runs.map((r) => r[0])).toEqual(["macro-report"]);
      const { explicitRun, ...rest } = (runs[0][1] ?? {}) as Record<string, unknown>;
      expect(rest).toEqual({
        requirePackage: "Sales",
        trigger: { kind: "buttonControl", sheetIndex: 0, row: 3, col: 1 },
      });
      // A person clicked it (owner decision B): the pass for this macro.
      const { claimExplicitMacroRun } = await import("@api/explicitMacroRun");
      expect(claimExplicitMacroRun(explicitRun)).toEqual({ door: "button", macroId: "macro-report" });
      // Not the inert notice: a held LINK is not inert.
      expect(h.toasts.map((t) => t.message).join(" ")).not.toContain("does not run in a working copy");
    } finally {
      unregister();
      resetMacroRunProvider();
    }
  });
});

async function renderPane(): Promise<void> {
  await act(async () => {
    root.render(
      <PropertiesPane data={{ row: 2, col: 1, sheetIndex: 0, controlType: "button" }} {...({} as never)} />,
    );
  });
  // The pane loads its metadata asynchronously.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("the Properties pane on a held button", () => {
  // SABOTAGE: drop `!(showHeldCode && def.key === "onSelect")` from the row
  // filter in PropertiesPane.tsx (the editable OnSelect row comes back).
  it("hides the editable OnSelect field and shows the held code read-only", async () => {
    await renderPane();
    expect(host.querySelector("[data-held-code='onSelect']")?.textContent).toBe("Report();");
    expect(host.textContent).not.toMatch(/OnSelect/);
  });

  it("shows the editable field on a button with no held code", async () => {
    h.properties = { text: { valueType: "static", value: "Mine" } };
    await renderPane();
    expect(host.querySelector("[data-held-code]")).toBeNull();
    expect(host.textContent).toMatch(/OnSelect/);
  });

  // The remove step: shows the code, awaits the Tauri-shaped confirm, and only
  // then reaches the backend.
  //
  // SABOTAGE: call `onRemove()` without awaiting `requestHeldRemoval` in
  // HeldCodeSection.
  it("removes the application's code only after a confirm that showed it", async () => {
    await renderPane();
    const remove = host.querySelector<HTMLButtonElement>("[data-held-remove]");
    expect(remove, "no remove step on a held button").not.toBeNull();

    h.confirm.mockReturnValue(Promise.resolve(false));
    await act(async () => {
      remove!.click();
    });
    expect(String(h.confirm.mock.calls[0][0])).toContain("Report();");
    expect(h.removed, "removed without a yes").toEqual([]);

    h.confirm.mockReturnValue(Promise.resolve(true));
    await act(async () => {
      remove!.click();
    });
    expect(h.removed).toEqual([[0, 2, 1, "button"]]);
    expect(h.setProperty, "the remove step is not an ordinary property write").toEqual([]);
    // The pane shows the button as it now is: no held code.
    expect(host.querySelector("[data-held-code]")).toBeNull();
  });

  // Phase 4 of BUG-0257: the pane says what a click does with held inline
  // code by the door's rule (here: a static, stamped, approvable action).
  //
  // SABOTAGE: pass `inlineVerdict={null}` from PropertiesPane -> no note -> red.
  it("says the held inline code runs when clicked, after the application's approval", async () => {
    await renderPane();
    expect(host.querySelector("[data-held-code-note='onSelect']")?.textContent).toBe(
      "Runs when clicked, after you approve the application's code.",
    );
    expect(host.textContent).not.toMatch(/inert/i);
  });

  // "Make this my own": shows the code, awaits the Tauri-shaped confirm, and
  // only then asks Rust to MOVE it -- with the texts it showed.
  //
  // SABOTAGE: drop `onAdopt={handleAdoptHeld}` from PropertiesPane -> red.
  it("makes the code the author's own only after a confirm that showed it", async () => {
    await renderPane();
    const adopt = host.querySelector<HTMLButtonElement>("[data-held-adopt]");
    expect(adopt, "no Make this my own step on a held button").not.toBeNull();

    h.confirm.mockReturnValue(Promise.resolve(false));
    await act(async () => {
      adopt!.click();
    });
    expect(String(h.confirm.mock.calls[0][0])).toContain("OnSelect:\nReport();");
    expect(h.adopted, "adopted without a yes").toEqual([]);

    h.confirm.mockReturnValue(Promise.resolve(true));
    await act(async () => {
      adopt!.click();
    });
    expect(h.adopted).toEqual([[0, 2, 1, "Report();", null]]);
    expect(h.setProperty, "adopting is not an ordinary property write").toEqual([]);
    expect(h.removed, "adopting is not a removal").toEqual([]);
    // The pane shows the button as it now is: its own code, editable, no held view.
    expect(host.querySelector("[data-held-code]")).toBeNull();
    expect(host.textContent).toMatch(/OnSelect/);
    expect(h.toasts).toEqual([]);
  });

  // The held code may change while the dialog is open. The pane sends what the
  // dialog SHOWED, and Rust -- which compares it under the lock of the move --
  // refuses; the refusal is said and the pane re-reads the button.
  //
  // SABOTAGE: in PropertiesPane.handleAdoptHeld, ignore `shown` and send a fresh
  // read (`getControlMetadata(...)`'s heldOnSelect / heldMacroRef) -> the newer
  // code goes to Rust -> red.
  it("sends the texts the dialog showed, never a fresh read, and says Rust's refusal", async () => {
    await renderPane();
    const adopt = host.querySelector<HTMLButtonElement>("[data-held-adopt]")!;
    let answer!: (yes: boolean) => void;
    h.confirm.mockReturnValue(new Promise<boolean>((resolve) => (answer = resolve)));
    await act(async () => {
      adopt.click();
    });
    // Under the open dialog the button's held code becomes something else.
    h.properties = { ...heldButton(), heldOnSelect: { valueType: "static", value: "Exfiltrate();" } };
    const refusal =
      "The application's code on the button at Sheet1!B3 changed after it was shown; nothing was changed. " +
      "Review it again before making it your own.";
    h.adoptRefusal = refusal;
    await act(async () => {
      answer(true);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(h.adopted, "the pane sent code the dialog never showed").toEqual([[0, 2, 1, "Report();", null]]);
    expect(h.toasts.map((t) => t.message)).toEqual([`Could not make the application's code your own: ${refusal}`]);
    // Re-read: the held view shows what the button holds NOW.
    expect(host.querySelector("[data-held-code='onSelect']")?.textContent).toBe("Exfiltrate();");
  });

  // Ctrl+Z after "Make this my own" puts the application's code back in Rust
  // and announces only the `controls` domain (CONTROLS_CHANGED). The pane must
  // re-read: otherwise it keeps offering the adopted code as the author's own,
  // editable, and hides the application's code the button holds again.
  //
  // SABOTAGE: drop the CONTROLS_CHANGED listener from PropertiesPane -> red.
  it("re-reads the button after an undo, and shows the held code again", async () => {
    await renderPane();
    h.confirm.mockReturnValue(Promise.resolve(true));
    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-held-adopt]")!.click();
    });
    expect(host.querySelector("[data-held-code]"), "precondition: the pane shows the adopted button").toBeNull();

    // The undo restored the held code in the store, and the shell announced it.
    h.properties = heldButton();
    await act(async () => {
      window.dispatchEvent(new CustomEvent("app:controls-changed"));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(host.querySelector("[data-held-code='onSelect']")?.textContent, "the pane did not re-read after the undo").toBe(
      "Report();",
    );
    expect(host.querySelector("[data-held-adopt]")).not.toBeNull();
  });
});
