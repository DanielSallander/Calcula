//! FILENAME: app/src/api/__tests__/buttonRefusalRecordWire.test.ts
// PURPOSE: A click's refusal of an application's button reaches the audit trail
//          naming the button's OWN sheet, and a failure to record it is SAID.
// CONTEXT: `recordButtonRefusal` is the one wrapper of `audit_button_refusal`
//          (app/src-tauri/src/button_cells.rs). The command used to read the
//          ACTIVE sheet itself, after the click's awaits, so a sheet switch in
//          between -- or a button on a sheet that is not the active index --
//          found no button, returned an error, and the wrapper logged it to the
//          console: the refusal of an application's code went unrecorded and
//          nobody was told. The real @api wrapper runs here with only the
//          backend door and the toast sink doubled.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: unknown }[],
  fail: null as string | null,
  toasts: [] as { message: string; variant?: string }[],
}));

vi.mock("../backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../backend")>()),
  invokeBackend: async (cmd: string, args?: unknown) => {
    h.calls.push({ cmd, args });
    if (h.fail) throw new Error(h.fail);
    return null;
  },
}));

vi.mock("../notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../notifications")>()),
  showToast: (message: string, options?: { variant?: string }) => {
    h.toasts.push({ message, variant: options?.variant });
  },
}));

import { recordButtonRefusal } from "../heldButtonCode";

beforeEach(() => {
  h.calls.length = 0;
  h.toasts.length = 0;
  h.fail = null;
});

describe("recordButtonRefusal", () => {
  // SABOTAGE: drop `sheetIndex` from the invoke arguments in recordButtonRefusal.
  it("names the button's own sheet, not whatever is active when it lands", async () => {
    await recordButtonRefusal("control", 2, 4, 1, 'the macro "Report"', "macroNotFromApplication");
    await recordButtonRefusal("cell", 5, 0, 3, 'the command "format.bold"', "command");
    expect(h.calls).toEqual([
      {
        cmd: "audit_button_refusal",
        args: {
          kind: "control",
          sheetIndex: 2,
          row: 4,
          col: 1,
          refused: 'the macro "Report"',
          reason: "macroNotFromApplication",
        },
      },
      {
        cmd: "audit_button_refusal",
        args: { kind: "cell", sheetIndex: 5, row: 0, col: 3, refused: 'the command "format.bold"', reason: "command" },
      },
    ]);
    expect(h.toasts).toEqual([]);
  });

  // SABOTAGE: drop the `showToast(` from recordButtonRefusal's catch (log only).
  it("SAYS when the refusal could not be recorded -- and never throws", async () => {
    h.fail = "There is no button control there; nothing was recorded.";
    await expect(recordButtonRefusal("control", 1, 2, 2, "x", "refused")).resolves.toBeUndefined();
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0].variant).toBe("warning");
    expect(h.toasts[0].message).toContain("could not be written to the audit trail");
    expect(h.toasts[0].message).toContain("nothing was recorded");
  });
});
