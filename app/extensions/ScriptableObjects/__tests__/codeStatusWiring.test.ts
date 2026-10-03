//! FILENAME: app/extensions/ScriptableObjects/__tests__/codeStatusWiring.test.ts
// PURPOSE: The PRODUCTION reads behind the status bar's code-and-scripts
//          indicator never turn a backend failure into "No code in this file".
// CONTEXT: The first version's unit tests made the reader itself throw -- which
//          the production reader never did: getWorkbookCodeUnits swallows each
//          population's failure into an empty list, so a broken backend read
//          showed the quiet "No code in this file" shield. Here the real reads
//          run against a backend double that fails ONE command at a time, and
//          what the indicator would say is derived from what they return.

import { describe, it, expect, vi, beforeEach } from "vitest";

let failing: string | null = null;

/** The backend: one command fails on demand; listings are empty; the rest has nothing. */
async function backend(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  if (cmd === failing) throw new Error(`${cmd} failed`);
  if (cmd === "script_scheduler") {
    const op = (args?.request as { op?: string } | undefined)?.op;
    if (`script_scheduler:${op}` === failing) throw new Error("scheduler failed");
    return op === "list" ? [] : null;
  }
  if (cmd === "get_sheets") return { sheets: [{ index: 0, name: "Sheet1" }] };
  if (cmd === "get_all_controls" || cmd === "get_all_cell_types") return [];
  if (cmd === "read_virtual_file") throw new Error("not found"); // no library lockfile
  if (cmd.startsWith("list") || cmd.endsWith("_list")) return [];
  return null;
}

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn((cmd: string, args?: Record<string, unknown>) => backend(cmd, args)),
}));
vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => {}),
}));

import { productionCodeStatusReaders } from "../lib/codeStatusWiring";
import { deriveCodeStatus, LOADING_SNAPSHOT, type CodeStatusSnapshot } from "../lib/codeStatus";

beforeEach(() => {
  failing = null;
});

/** What the indicator would show after one full production read. */
async function indicatorAfterRead(): Promise<ReturnType<typeof deriveCodeStatus>> {
  let file: Awaited<ReturnType<typeof productionCodeStatusReaders.readFile>> | null = null;
  let inventoryError: string | null = null;
  try {
    file = await productionCodeStatusReaders.readFile();
  } catch (e) {
    inventoryError = String(e);
  }
  const units = file?.units ?? [];
  const settle = async <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);
  const snap: CodeStatusSnapshot = {
    ...LOADING_SNAPSHOT,
    phase: "ready",
    inventory: file?.inventory ?? null,
    inventoryError,
    inventoryGaps: file?.gaps ?? [],
    heldButtons: file ? file.heldButtons : null,
    commandButtons: file ? file.commandButtons : null,
    jobs: await settle(productionCodeStatusReaders.readJobs(units)),
    held: await settle(productionCodeStatusReaders.readHeld(units)),
  };
  return deriveCodeStatus(snap);
}

describe("the production reads", () => {
  it("positive control: a healthy empty workbook IS 'No code in this file'", async () => {
    const view = await indicatorAfterRead();
    expect(view.level).toBe("none");
    expect(view.ariaLabel).toBe("Code and scripts: No code in this file. Show details.");
  });

  it.each([
    ["list_object_scripts", "object scripts"],
    ["list_scripts", "module scripts"],
    ["notebook_list", "notebooks"],
  ])("a failing %s is a GAP the indicator says, never 'No code in this file'", async (cmd, gap) => {
    failing = cmd;
    const file = await productionCodeStatusReaders.readFile();
    expect(file.gaps).toContain(gap);
    const view = await indicatorAfterRead();
    expect(view.level).toBe("unknown");
    expect(view.ariaLabel).not.toMatch(/no code/i);
    expect(view.facts.find((f) => f.id === "inventory-gaps")?.detail).toContain(gap);
  });

  it("a failing walk of the sheets is said too (the button listings cannot count)", async () => {
    failing = "get_sheets";
    const file = await productionCodeStatusReaders.readFile();
    expect(file.gaps).toContain("button code");
    expect(file.heldButtons).toBeNull();
    expect(file.commandButtons).toBeNull();
    expect((await indicatorAfterRead()).level).toBe("unknown");
  });

  it("a schedule that could not be listed REJECTS readJobs -- 'Could not read the scheduled jobs', not 'none'", async () => {
    failing = "script_scheduler:list";
    await expect(productionCodeStatusReaders.readJobs([])).rejects.toThrow(/scheduled jobs/);
    const view = await indicatorAfterRead();
    expect(view.level).toBe("notice");
    expect(view.facts.map((f) => f.id)).toContain("jobs-error");
  });
});
