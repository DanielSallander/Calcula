//! FILENAME: app/extensions/ScriptableObjects/__tests__/applicationCommandButtonsListing.test.tsx
// PURPOSE: plan_M8 S3 (4) -- "Code in This File" lists the button cells an
//          application brought that run a Calcula COMMAND, end to end from the
//          backend's cell-type listing to the rendered section, each row saying
//          whether a click runs it here: never (the page's rule over the LIVE
//          registration), or approved / waiting / elsewhere (the approval Rust's
//          command gate asks, under `button-commands:<application>` at the
//          sha256 of the command id, over the approvals that count on THIS
//          computer).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createHash } from "node:crypto";

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  invokeBackend: async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "get_sheets") return { sheets: [{ index: 0, name: "Notes" }, { index: 1, name: "Dashboard" }] };
    if (cmd === "get_all_cell_types") {
      if (args?.sheetIndex !== 1) return [];
      const stamp = { workspace: "ws", application: "Sales", version: "1.2.0" };
      return [
        // The application's command button: listed.
        { sheetIndex: 1, row: 4, col: 1, typeId: "calcula.button", params: { label: "Refresh", action: { kind: "command", commandId: "reader.refresh" }, fromApplication: stamp } },
        // The user's own command button: not the application's, not listed.
        { sheetIndex: 1, row: 5, col: 1, typeId: "calcula.button", params: { label: "Mine", action: { kind: "command", commandId: "format.bold" } } },
        // The application's MACRO button: not a command.
        { sheetIndex: 1, row: 6, col: 1, typeId: "calcula.button", params: { action: { kind: "script", scriptId: "m" }, fromApplication: stamp } },
        // A HELD command (a working copy): runs nowhere, not listed here.
        { sheetIndex: 1, row: 7, col: 1, typeId: "calcula.button", params: { heldAction: { kind: "command", commandId: "reader.refresh" }, fromApplication: stamp } },
        // A stamp that names no application: no application to approve it for.
        { sheetIndex: 1, row: 8, col: 1, typeId: "calcula.button", params: { action: { kind: "command", commandId: "reader.refresh" }, fromApplication: {} } },
        // Not a button.
        { sheetIndex: 1, row: 9, col: 1, typeId: "calcula.checkbox", params: { action: { kind: "command", commandId: "reader.refresh" }, fromApplication: stamp } },
        { sheetIndex: 1, row: 1, col: 3, typeId: "calcula.button", params: { action: { kind: "command", commandId: "cellTypes.clear" }, fromApplication: stamp } },
      ];
    }
    throw new Error(`unexpected command ${cmd}`);
  },
}));

import { listApplicationCellCommands, type ApplicationCellCommand } from "@api/heldButtonCode";
import type { ConsentReport } from "@api/distributedConsent";
import {
  ApplicationCommandButtonsSection,
  describeApplicationCommandState,
  type CommandRegistryLookup,
} from "../components/ApplicationCommandButtonsSection";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** Calcula's registry: reader.refresh opts in; cellTypes.clear does not. */
const REGISTRY: CommandRegistryLookup = {
  getCommand: (id) =>
    id === "reader.refresh"
      ? { name: "Refresh the report", distributableTrigger: true }
      : id === "cellTypes.clear"
        ? { name: "Clear Cell Type" }
        : undefined,
  isCommandShadowed: () => false,
};

const report = (over: Partial<ConsentReport> = {}): ConsentReport => ({ consents: [], ignored: [], ...over });
const approvedUnder = (packageName: string, id: string, hash: string) => ({
  packageName,
  scripts: [{ id, sourceHash: hash }],
  grantedCapabilities: [],
  grantedAt: "2026-10-01T00:00:00Z",
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
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

describe("listApplicationCellCommands", () => {
  // SABOTAGE: drop the `cellButtonApplication` filter -> the user's own
  // command button is listed as the application's.
  it("lists exactly the button cells an application brought whose LIVE action is a command, in cell order", async () => {
    const listed = await listApplicationCellCommands();
    expect(listed.map((e) => [e.cell, e.application, e.commandId, e.caption])).toEqual([
      ["Dashboard!D2", "Sales", "cellTypes.clear", ""],
      ["Dashboard!B5", "Sales", "reader.refresh", "Refresh"],
    ]);
    expect(listed[1].commandHash, "the hash Rust's gate asks: the sha256 of the id's own bytes").toBe(
      sha256("reader.refresh"),
    );
  });
});

describe("each row says whether a click runs the command here", () => {
  async function entryFor(commandId: string): Promise<ApplicationCellCommand> {
    return (await listApplicationCellCommands()).find((e) => e.commandId === commandId)!;
  }

  // SABOTAGE: drop the `judgeApplicationCommand` check from
  // describeApplicationCommandState -> the unflagged command reads "waiting".
  it("a command whose live registration does not opt in never runs here, approved or not", async () => {
    const entry = await entryFor("cellTypes.clear");
    const said = describeApplicationCommandState(
      entry,
      report({ consents: [approvedUnder("button-commands:Sales", "cellTypes.clear", sha256("cellTypes.clear"))] }),
      REGISTRY,
    );
    expect(said).toEqual({
      state: "neverRuns",
      text: "Never runs here: it is not on Calcula's list of commands a button from an application may run.",
    });
  });

  // SABOTAGE: ask the application's BARE key instead of its command key -> the
  // bare-record case reads "approved".
  it("approved only under the application's COMMAND key, at the hash of the id", async () => {
    const entry = await entryFor("reader.refresh");
    const hash = sha256("reader.refresh");
    expect(
      describeApplicationCommandState(entry, report({ consents: [approvedUnder("button-commands:Sales", "reader.refresh", hash)] }), REGISTRY)
        .state,
    ).toBe("approved");
    expect(
      describeApplicationCommandState(entry, report({ consents: [approvedUnder("Sales", "reader.refresh", hash)] }), REGISTRY).state,
      "an approval under the application's BARE key is not a command approval",
    ).toBe("waiting");
    expect(
      describeApplicationCommandState(
        entry,
        report({ consents: [approvedUnder("button-commands:Sales", "reader.refresh", sha256("other"))] }),
        REGISTRY,
      ).state,
      "the id matches but the hash does not",
    ).toBe("waiting");
    expect(
      describeApplicationCommandState(
        entry,
        report({ ignored: [{ packageName: "button-commands:Sales", reason: "otherComputer" }] }),
        REGISTRY,
      ).state,
    ).toBe("elsewhere");
    expect(describeApplicationCommandState(entry, null, REGISTRY).state).toBe("unknown");
  });

  it("the section renders each row with its state, and nothing when there is nothing", async () => {
    const entries = await listApplicationCellCommands();
    await act(async () => {
      root.render(<ApplicationCommandButtonsSection entries={entries} error={null} report={report()} />);
    });
    const section = host.querySelector("[data-testid='application-command-buttons-section']")!;
    expect(section.textContent).toContain("Buttons from an application that run a Calcula command (2)");
    const row = host.querySelector("[data-application-command-button='Dashboard!B5']")!;
    expect(row.textContent).toContain('Dashboard!B5 "Refresh" (button cell)');
    expect(row.textContent).toContain("for 'Sales'");
    await act(async () => {
      root.render(<ApplicationCommandButtonsSection entries={[]} error={null} report={report()} />);
    });
    expect(host.querySelector("[data-testid='application-command-buttons-section']")).toBeNull();
    await act(async () => {
      root.render(<ApplicationCommandButtonsSection entries={[]} error="backend down" report={null} />);
    });
    expect(host.textContent).toContain("Could not read the command buttons: backend down");
  });
});
