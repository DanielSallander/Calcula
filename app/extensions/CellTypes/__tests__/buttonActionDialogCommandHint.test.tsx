//! FILENAME: app/extensions/CellTypes/__tests__/buttonActionDialogCommandHint.test.tsx
// PURPOSE: plan_M8 S2 (4) -- the AUTHOR is told, under the command picker,
//          what a button's command does once the workbook is published as an
//          application: a command that opts in (`distributableTrigger: true`)
//          runs for a subscriber after they approve it; any other is removed
//          when the application arrives. The sentence is decided by the chosen
//          command's LIVE registration -- the same object the click reads.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  commands: [] as Array<{ id: string; name: string; distributableTrigger?: true; execute: () => void }>,
}));

vi.mock("../../../src/api/workbookScripts", () => ({
  listWorkbookScripts: async () => [],
}));

vi.mock("@api", () => ({
  // eslint-disable-next-line @typescript-eslint/naming-convention -- mirrors the real export's name
  ExtensionRegistry: { getAllCommands: () => h.commands },
}));

import { ButtonActionDialog } from "../components/ButtonActionDialog";
import { describeButtonCommandReach } from "../lib/buttonCommandRun";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;

const FLAGGED = "In an application you publish, subscribers can run this after they approve it.";
const UNFLAGGED = "Only in this workbook: in an application you publish, this button's command is removed when it arrives.";

async function openDialog(): Promise<void> {
  await act(async () => {
    root.render(<ButtonActionDialog isOpen={true} onClose={() => undefined} data={{ onApply: () => undefined }} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

async function chooseCommand(id: string): Promise<void> {
  const select = host.querySelector<HTMLSelectElement>("select");
  if (!select) throw new Error("the command picker is not rendered");
  await act(async () => {
    select.value = id;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function hint(): HTMLElement | null {
  return host.querySelector<HTMLElement>("[data-button-command-reach]");
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  h.commands = [
    { id: "reader.refresh", name: "Refresh the report", distributableTrigger: true, execute: () => undefined },
    { id: "cellTypes.clear", name: "Clear Cell Type", execute: () => undefined },
  ];
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

describe("the command picker's hint", () => {
  // SABOTAGE: render the flagged sentence for every command -> the unflagged
  // case goes red.
  it("says a flagged command runs for subscribers after approval, and any other is removed on arrival", async () => {
    await openDialog();
    expect(hint(), "no command chosen, nothing to say").toBeNull();

    await chooseCommand("reader.refresh");
    expect(hint()?.getAttribute("data-button-command-reach")).toBe("distributable");
    expect(hint()?.textContent).toBe(FLAGGED);

    await chooseCommand("cellTypes.clear");
    expect(hint()?.getAttribute("data-button-command-reach")).toBe("workbookOnly");
    expect(hint()?.textContent).toBe(UNFLAGGED);
  });

  it("the sentence is a function of the registration's own flag", () => {
    expect(describeButtonCommandReach({ distributableTrigger: true })).toBe(FLAGGED);
    expect(describeButtonCommandReach({})).toBe(UNFLAGGED);
    expect(describeButtonCommandReach(undefined)).toBe(UNFLAGGED);
  });
});
