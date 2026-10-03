//! FILENAME: app/src/api/__tests__/objectScriptsChanged.test.ts
// PURPOSE: Saving or deleting an object script announces it -- AFTER the
//          backend write resolves, and never for a write that failed.
// CONTEXT: The status bar's code-and-scripts indicator re-reads the backend on
//          this event. Registering a script in the manager (onScriptChange)
//          happens BEFORE a fire-and-forget save, so a re-read triggered by that
//          alone could see the old state; and the standalone editor saves from
//          its own window, which an in-window app event never leaves. A Tauri
//          event emitted from the write door itself has neither problem.

import { describe, it, expect, vi, beforeEach } from "vitest";

const order: string[] = [];
let failNext = false;

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async (cmd: string) => {
    // Resolve on a later turn, as IPC does: an announcement made before the
    // write settles would land ahead of "write:" in `order`.
    await new Promise((r) => setTimeout(r, 0));
    if (failNext) {
      failNext = false;
      order.push(`failed:${cmd}`);
      throw new Error("backend refused");
    }
    order.push(`write:${cmd}`);
    return null;
  }),
}));

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  emitTauriEvent: vi.fn(async (event: string, detail: unknown) => {
    order.push(`event:${event}:${JSON.stringify(detail)}`);
  }),
}));

import {
  OBJECT_SCRIPTS_CHANGED_EVENT,
  deleteObjectScript,
  deleteObjectScriptsForInstance,
  saveObjectScript,
} from "../objectScriptBackend";

const SCRIPT = {
  id: "os1",
  name: "Refresh",
  objectType: "workbook" as const,
  instanceId: null,
  source: "export default {};",
  accessLevel: "restricted" as const,
};

beforeEach(() => {
  order.length = 0;
  failNext = false;
});

describe("object-script writes announce themselves", () => {
  it("a save is announced AFTER the backend write resolves", async () => {
    await saveObjectScript(SCRIPT);
    expect(order).toEqual([
      "write:save_object_script",
      `event:${OBJECT_SCRIPTS_CHANGED_EVENT}:${JSON.stringify({ id: "os1", change: "saved" })}`,
    ]);
  });

  it("a delete and an instance delete are announced too", async () => {
    await deleteObjectScript("os1");
    await deleteObjectScriptsForInstance("btn-1");
    expect(order).toEqual([
      "write:delete_object_script",
      `event:${OBJECT_SCRIPTS_CHANGED_EVENT}:${JSON.stringify({ id: "os1", change: "deleted" })}`,
      "write:delete_object_scripts_for_instance",
      `event:${OBJECT_SCRIPTS_CHANGED_EVENT}:${JSON.stringify({ id: "btn-1", change: "deletedForInstance" })}`,
    ]);
  });

  it("a write that FAILED announces nothing, and still rejects", async () => {
    failNext = true;
    await expect(saveObjectScript(SCRIPT)).rejects.toThrow("backend refused");
    expect(order).toEqual(["failed:save_object_script"]);
  });
});
