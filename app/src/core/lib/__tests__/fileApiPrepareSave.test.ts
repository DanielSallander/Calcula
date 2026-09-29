//! FILENAME: app/src/core/lib/__tests__/fileApiPrepareSave.test.ts
// PURPOSE: A save is TWO halves (E8): `prepareSave` runs every step that can
//          still refuse -- the destination (the Save As picker), the lossy-save
//          consent, the Before-Save guards -- and writes and broadcasts
//          NOTHING; `writePreparedSave` writes and refuses nothing.
// CONTEXT: The close prompt's Save must learn that a save will not happen
//          BEFORE it tears the workbook down (BEFORE_CLOSE unmounts every
//          script). With one `saveFile`, a cancelled picker or a declined
//          lossy warning was learnt after the teardown, and the window stayed
//          open over torn-down scripts.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const tracedInvoke = vi.fn();
const dialogSave = vi.fn();
const confirmAsync = vi.fn();
vi.mock("../../../utils/bridge", () => ({ tracedInvoke: (...a: unknown[]) => tracedInvoke(...a) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: (...a: unknown[]) => dialogSave(...a) }));
vi.mock("../dialogs", () => ({ confirmAsync: (...a: unknown[]) => confirmAsync(...a) }));

import { prepareSave, writePreparedSave, saveFile } from "../file-api";
import { AppEvents, onAppEvent } from "../events";
import { registerLifecycleCancelReporter, registerLifecycleGuard, resetLifecycleGuards } from "../lifecycleGuards";

let currentPath: string | null = "C:/Books/Budget.cala";
let lossReport: string[] = [];
const emitted: string[] = [];
const offs: (() => void)[] = [];

beforeEach(() => {
  currentPath = "C:/Books/Budget.cala";
  lossReport = [];
  emitted.length = 0;
  tracedInvoke.mockReset().mockImplementation(async (cmd: string) => {
    if (cmd === "get_current_file_path") return currentPath;
    if (cmd === "xlsx_save_loss_report") return lossReport;
    return undefined;
  });
  dialogSave.mockReset().mockResolvedValue("C:/Books/Picked.cala");
  confirmAsync.mockReset().mockResolvedValue(true);
  resetLifecycleGuards();
  registerLifecycleCancelReporter(() => {});
  for (const ev of [AppEvents.BEFORE_SAVE, AppEvents.AFTER_SAVE]) {
    offs.push(onAppEvent(ev, () => emitted.push(ev)));
  }
});

afterEach(() => {
  while (offs.length > 0) offs.pop()!();
  resetLifecycleGuards();
});

const wrote = (): boolean => tracedInvoke.mock.calls.some((c) => c[0] === "save_file");

describe("prepareSave -- every refusal, nothing written (E8)", () => {
  it("a titled workbook: its own path, kind 'save', and nothing written or broadcast", async () => {
    await expect(prepareSave()).resolves.toEqual({ path: "C:/Books/Budget.cala", kind: "save", password: undefined });
    expect(wrote()).toBe(false);
    expect(emitted).toEqual([]);
    expect(dialogSave).not.toHaveBeenCalled();
  });

  it("an untitled workbook: the picker's path, kind 'saveAs'", async () => {
    currentPath = null;
    await expect(prepareSave()).resolves.toEqual({ path: "C:/Books/Picked.cala", kind: "saveAs", password: undefined });
    expect(wrote()).toBe(false);
  });

  it("the picker cancelled -> null, nothing written", async () => {
    currentPath = null;
    dialogSave.mockResolvedValueOnce(null);
    await expect(prepareSave()).resolves.toBeNull();
    expect(wrote()).toBe(false);
    expect(emitted).toEqual([]);
  });

  it("the lossy-save warning declined -> null, nothing written", async () => {
    currentPath = "C:/Books/Report.xlsx";
    lossReport = ["Pivot tables"];
    confirmAsync.mockResolvedValueOnce(false);
    await expect(prepareSave()).resolves.toBeNull();
    expect(confirmAsync).toHaveBeenCalledTimes(1);
    expect(wrote()).toBe(false);
  });

  it("a Before-Save guard refuses -> null, asked with the destination", async () => {
    const guard = vi.fn(async () => ({ by: "Totals", reason: "Fill in the total first" }));
    registerLifecycleGuard(guard);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(prepareSave()).resolves.toBeNull();
    expect(guard).toHaveBeenCalledWith("save", { path: "C:/Books/Budget.cala", kind: "save" });
    expect(wrote()).toBe(false);
  });

  it("saveAs: true asks the picker even for a titled workbook", async () => {
    await expect(prepareSave({ saveAs: true, password: "pw" })).resolves.toEqual({
      path: "C:/Books/Picked.cala",
      kind: "saveAs",
      password: "pw",
    });
  });
});

describe("writePreparedSave -- the write, refusing nothing", () => {
  it("broadcasts BEFORE_SAVE, writes, broadcasts AFTER_SAVE -- and asks no guard", async () => {
    const guard = vi.fn(async () => ({ by: "Late", reason: "too late" }));
    registerLifecycleGuard(guard);
    await expect(writePreparedSave({ path: "C:/Books/Budget.cala", kind: "save" })).resolves.toBe("C:/Books/Budget.cala");
    expect(tracedInvoke).toHaveBeenCalledWith("save_file", { path: "C:/Books/Budget.cala", password: undefined });
    expect(emitted).toEqual([AppEvents.BEFORE_SAVE, AppEvents.AFTER_SAVE]);
    expect(guard).not.toHaveBeenCalled();
  });

  it("saveFile is the two halves back to back", async () => {
    await expect(saveFile()).resolves.toBe("C:/Books/Budget.cala");
    expect(wrote()).toBe(true);
  });
});
