//! FILENAME: app/extensions/ScriptableObjects/__tests__/heldButtonCodeListing.test.tsx
// PURPOSE: "Code in This File" lists the button code a working copy HOLDS --
//          the WIRING, end to end from the backend listings to the rendered
//          section (review finding: `listHeldButtonCode` and
//          `HeldButtonCodeSection` had no test at all) -- for button CONTROLS
//          and, since the review, button CELLS (Cell Type: Button, BUG-0260),
//          whose held actions a push publishes too.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({ calls: [] as { cmd: string; args: unknown }[] }));

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  invokeBackend: async (cmd: string, args?: Record<string, unknown>) => {
    h.calls.push({ cmd, args });
    if (cmd === "get_sheets") {
      return { sheets: [{ index: 0, name: "Notes" }, { index: 1, name: "Dashboard" }] };
    }
    if (cmd === "get_all_controls") {
      return args?.sheetIndex === 1
        ? [
            {
              sheetIndex: 1,
              row: 1,
              col: 1,
              metadata: {
                controlType: "button",
                properties: {
                  heldOnSelect: { valueType: "static", value: "Report();" },
                  heldFrom: {
                    valueType: "static",
                    value: JSON.stringify({ workspace: "ws", application: "Sales", version: "1.2.0" }),
                  },
                },
              },
            },
            // A live button of the author's own: not held, not listed.
            { sheetIndex: 1, row: 4, col: 4, metadata: { controlType: "button", properties: { onSelect: { valueType: "static", value: "Mine();" } } } },
          ]
        : [];
    }
    if (cmd === "get_all_cell_types") {
      return args?.sheetIndex === 1
        ? [
            {
              sheetIndex: 1,
              row: 2,
              col: 2,
              typeId: "calcula.button",
              params: {
                label: "Go",
                heldAction: { scriptId: "macro-report", kind: "script", functionName: "Exfiltrate" },
                fromApplication: { workspace: "ws", application: "Sales", version: "1.2.0" },
              },
            },
            // A kept (live) action is not held.
            { sheetIndex: 1, row: 3, col: 3, typeId: "calcula.button", params: { action: { kind: "script", scriptId: "macro-app" } } },
            { sheetIndex: 1, row: 5, col: 5, typeId: "calcula.checkbox", params: { heldAction: { kind: "command" } } },
          ]
        : [];
    }
    throw new Error(`unexpected command ${cmd}`);
  },
}));

import { createHash } from "node:crypto";
import { listHeldButtonCode, readHeldCellButtonAction, type HeldButtonCodeEntry } from "@api/heldButtonCode";
import type { ConsentReport } from "@api/distributedConsent";
import { HeldButtonCodeSection, describeHeldInlineApproval } from "../components/HeldButtonCodeSection";
import {
  CarriedApprovalsSection,
  describeApprovalKey,
  describeIgnoredReason,
} from "../components/CarriedApprovalsSection";

/** sha256 hex with node:crypto -- never the code under test's own hash. */
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  h.calls.length = 0;
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

describe("listHeldButtonCode", () => {
  // SABOTAGE: drop the `get_all_cell_types` scan from listHeldButtonCode.
  it("lists held control code AND held button-cell actions, located, in cell order", async () => {
    const entries = await listHeldButtonCode();
    expect(entries.map((e) => [e.kind, e.cell])).toEqual([
      ["control", "Dashboard!B2"],
      ["cell", "Dashboard!C3"],
    ]);
    expect(entries[0]).toMatchObject({ application: "Sales", version: "1.2.0", onSelect: "Report();" });
    // M6: held inline code is an approval item -- the id the Rust door asks,
    // the hash of the exact bytes, and the door's verdict.
    expect(entries[0].inline).toEqual({
      id: `buttonAction:${sha256("Report();")}`,
      hash: sha256("Report();"),
      verdict: { runs: true, application: "Sales" },
    });
    expect(entries[0].onSelectValueType).toBe("static");
    expect(entries[1].inline).toBeNull();
    // The action exactly as it is published: canonical JSON, keys sorted.
    expect(entries[1].cellAction).toBe('{"functionName":"Exfiltrate","kind":"script","scriptId":"macro-report"}');
    expect(entries[1]).toMatchObject({ application: "Sales", onSelect: null, macroRef: null });
  });

  it("reads a held action only from a button cell's heldAction", () => {
    expect(readHeldCellButtonAction({ action: { kind: "script", scriptId: "x" } })).toBeNull();
    expect(readHeldCellButtonAction(null)).toBeNull();
  });
});

describe("Code in This File's held-code section", () => {
  // SABOTAGE: drop the `entry.cellAction` block from HeldRow.
  it("shows each held entry's code verbatim, with its application", async () => {
    const entries = await listHeldButtonCode();
    await act(async () => {
      root.render(<HeldButtonCodeSection entries={entries} error={null} />);
    });
    const section = host.querySelector("[data-testid='held-button-code-section']")!;
    expect(section.textContent).toContain("Button code that came with an application (2)");
    for (const row of host.querySelectorAll<HTMLButtonElement>("[data-held-button-code] > button")) {
      await act(async () => {
        row.click();
      });
    }
    expect(host.querySelector("[data-held-button-code='Dashboard!B2']")!.textContent).toContain("Report();");
    const cell = host.querySelector("[data-held-button-code='Dashboard!C3']")!;
    expect(cell.textContent).toContain("(button cell)");
    expect(cell.textContent).toContain("'Sales' v1.2.0");
    expect(cell.textContent).toContain("Runs the macro macro-report and calls Exfiltrate()");
    expect(cell.querySelector("[data-held-cell-action]")!.textContent).toContain('"functionName":"Exfiltrate"');
  });

  // Phase 3 of BUG-0257: a held macro LINK runs after approval. Phase 4 (M6):
  // held INLINE code runs too, after the approval of its exact bytes -- it is
  // no longer listed as inert anywhere.
  //
  // SABOTAGE: make describeHeldEntry always return a "held (inert)" line
  // (components/HeldButtonCodeSection.tsx).
  it("says a held LINK and held inline code both run after approval, and neither is inert", async () => {
    const base = {
      application: "Sales",
      version: "1.2.0",
      sheetIndex: 1,
      sheetName: "Dashboard",
      col: 1,
      kind: "control" as const,
    };
    const entries = [
      { ...base, row: 1, cell: "Dashboard!B2", onSelect: null, macroRef: "macro-report" },
      { ...base, row: 2, cell: "Dashboard!B3", onSelect: "Report();", macroRef: null },
    ];
    await act(async () => {
      root.render(<HeldButtonCodeSection entries={entries} error={null} />);
    });
    for (const row of host.querySelectorAll<HTMLButtonElement>("[data-held-button-code] > button")) {
      await act(async () => {
        row.click();
      });
    }
    const link = host.querySelector("[data-held-button-code='Dashboard!B2']")!;
    expect(link.textContent).toContain("runs after approval");
    expect(link.textContent).not.toContain("inert");
    expect(link.querySelector("[data-held-macro-link]")!.textContent).toBe(
      "Runs the application's macro macro-report when clicked, only after you approve the application's code.",
    );
    const inline = host.querySelector("[data-held-button-code='Dashboard!B3']")!;
    expect(inline.textContent).toContain("runs after approval");
    expect(inline.textContent).not.toContain("inert");
    expect(inline.querySelector("[data-held-inline-code]")!.textContent).toBe("Report();");
    expect(host.querySelector("[data-testid='held-button-code-section']")!.textContent).not.toContain("inert");
  });

  it("renders nothing when nothing is held", async () => {
    await act(async () => {
      root.render(<HeldButtonCodeSection entries={[]} error={null} />);
    });
    expect(host.querySelector("[data-testid='held-button-code-section']")).toBeNull();
  });
});

// ===========================================================================
// M6: each held inline row says where it stands with its approval ON THIS
// COMPUTER -- the exact question the Rust door asks (`consent_granted_in`:
// the application's record, verbatim, listing `buttonAction:<sha256>` with the
// hash of the bytes), over the approvals that count here.
// ===========================================================================

describe("held inline code shows its approval state", () => {
  const CODE = "Report();";
  const ID = `buttonAction:${sha256(CODE)}`;

  const report = (over: Partial<ConsentReport> = {}): ConsentReport => ({ consents: [], ignored: [], ...over });
  const sealedHere = (scripts: Array<{ id: string; sourceHash: string }>) => ({
    packageName: "Sales",
    scripts,
    grantedCapabilities: [],
    grantedAt: "2026-10-01T00:00:00Z",
  });

  async function heldInline(): Promise<HeldButtonCodeEntry> {
    const entries = await listHeldButtonCode();
    return entries.find((e) => e.kind === "control")!;
  }

  async function stateIn(r: ConsentReport | null): Promise<string> {
    const entry = await heldInline();
    await act(async () => {
      root.render(<HeldButtonCodeSection entries={[entry]} error={null} report={r} />);
    });
    return host.querySelector("[data-held-approval]")!.getAttribute("data-held-approval")!;
  }

  // SABOTAGE: make describeHeldInlineApproval answer "approved" whenever the
  // application has ANY record (drop the id/hash match) -> the "other bytes"
  // row reads approved.
  it("approved on this computer: the record lists exactly these bytes", async () => {
    expect(await stateIn(report({ consents: [sealedHere([{ id: ID, sourceHash: sha256(CODE) }])] }))).toBe(
      "approved",
    );
    expect(host.textContent).toContain("Approved on this computer");
  });

  it("an approval of OTHER bytes, or under another application, is still waiting", async () => {
    expect(
      await stateIn(report({ consents: [sealedHere([{ id: ID, sourceHash: sha256("Other();") }])] })),
      "the id matches but the bytes do not",
    ).toBe("waiting");
    expect(
      await stateIn(
        report({ consents: [{ ...sealedHere([{ id: ID, sourceHash: sha256(CODE) }]), packageName: "Someone Else" }] }),
      ),
      "another application's record approves nothing of Sales'",
    ).toBe("waiting");
    expect(host.textContent).toContain("Waiting for your approval");
  });

  // SABOTAGE: drop the `ignored` check from describeHeldInlineApproval -> the
  // row reads "waiting" and never says the old approval does not count here.
  it("an approval from another computer does not count here, and the row says so", async () => {
    expect(await stateIn(report({ ignored: [{ packageName: "Sales", reason: "otherComputer" }] }))).toBe(
      "elsewhere",
    );
    expect(host.textContent).toContain("an approval from another computer does not count here");
    // ...and an unsealed record reads the same way: it was never made HERE.
    expect(await stateIn(report({ ignored: [{ packageName: "Sales", reason: "unsealed" }] }))).toBe("elsewhere");
    // Another application's ignored record says nothing about this one.
    expect(await stateIn(report({ ignored: [{ packageName: "Someone Else", reason: "otherComputer" }] }))).toBe(
      "waiting",
    );
  });

  it("approvals that could not be read are said, never read as 'none'", async () => {
    expect(await stateIn(null)).toBe("unknown");
    expect(host.textContent).toContain("could not be read");
  });

  it("code no click can run says why, approved or not", () => {
    const entry: HeldButtonCodeEntry = {
      application: "Sales",
      version: "1.2.0",
      onSelect: CODE,
      macroRef: null,
      sheetIndex: 1,
      sheetName: "Dashboard",
      row: 1,
      col: 1,
      cell: "Dashboard!B2",
      kind: "control",
      inline: {
        id: ID,
        hash: sha256(CODE),
        verdict: { runs: false, why: "it sits on a shape, and only a button runs code when it is clicked" },
      },
    };
    const said = describeHeldInlineApproval(entry, report({ consents: [sealedHere([{ id: ID, sourceHash: sha256(CODE) }])] }));
    expect(said).toEqual({
      state: "neverRuns",
      text: "Never runs here: it sits on a shape, and only a button runs code when it is clicked.",
    });
  });
});

describe("approvals this workbook carried from elsewhere", () => {
  // SABOTAGE: render `entry.keyId` (or the whole entry as JSON) in a row of
  // CarriedApprovalsSection -> the hex id appears on screen.
  it("names the application and the reason, and never a key id", async () => {
    const ignored = [
      // Rust reports only { packageName, reason }; an extra field a future
      // Rust adds -- a key id, say -- must still never reach the screen.
      { packageName: "Sales", reason: "otherComputer" as const, keyId: "a1b2c3d4e5f60718" },
      { packageName: "Sales", reason: "otherComputer" as const, keyId: "0f1e2d3c4b5a6978" },
      { packageName: "custom-functions:Sales", reason: "unsealed" as const },
      { packageName: "Payroll", reason: "altered" as const },
    ];
    await act(async () => {
      root.render(<CarriedApprovalsSection report={{ consents: [], ignored }} error={null} />);
    });
    const section = host.querySelector("[data-testid='carried-approvals-section']")!;
    const text = section.textContent ?? "";
    expect(text).toContain("Approvals this workbook carried from elsewhere (3)");
    expect(text).toContain("Sales — approved on another computer");
    expect(text).toContain("Sales (custom functions) — approved before approvals were tied to a computer");
    expect(text).toContain("Payroll — changed after it was approved");
    expect(text).not.toMatch(/[0-9a-f]{12,}/);
    expect(section.innerHTML).not.toMatch(/[0-9a-f]{12,}/);
  });

  it("renders nothing when nothing was carried, and says it when approvals cannot be read", async () => {
    await act(async () => {
      root.render(<CarriedApprovalsSection report={{ consents: [], ignored: [] }} error={null} />);
    });
    expect(host.querySelector("[data-testid='carried-approvals-section']")).toBeNull();
    await act(async () => {
      root.render(<CarriedApprovalsSection report={null} error="backend down" />);
    });
    expect(host.textContent).toContain("Could not read this workbook's approvals: backend down");
  });

  it("describes every reason Rust reports, and every approval namespace", () => {
    expect(describeIgnoredReason("keyUnavailable")).toContain("approvals key cannot be read");
    expect(describeApprovalKey("lib:Charts Pack")).toBe("Charts Pack (script library)");
    expect(describeApprovalKey("chart-marks:Sales")).toBe("Sales (chart marks)");
    expect(describeApprovalKey("chart-transforms:Sales")).toBe("Sales (chart transforms)");
    // plan_M8 S3: an application's command-button approvals have their own key.
    expect(describeApprovalKey("button-commands:Sales")).toBe("Sales (button commands)");
    expect(describeApprovalKey("Sales")).toBe("Sales");
  });
});
