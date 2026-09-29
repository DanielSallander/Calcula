// FILENAME: app/extensions/CommandLine/__tests__/gatewayRefusedUndo.test.ts
// PURPOSE: `undo` / `redo` typed at the command line while a command refusal
//          holds (a slicer click or ribbon filter change still landing) fail
//          WITH THE REFUSAL'S SENTENCE, which the prompt prints in red -- never
//          a bare "Undo failed", and without running the command.
// CONTEXT: Found live 2026-09-29 (e2e fixall-calp X10, run 4). The gateway's
//          undo goes through CommandRegistry.execute, which now refuses a
//          refused command itself (toast, returns nothing; the W15 fix). The
//          gateway read "nothing" as a failure and printed "Undo failed",
//          while the sentence went to a toast the command line does not show.

import { describe, expect, it, afterEach } from "vitest";
import { createLiveAppGateway } from "../cli/appGateway";
import { CommandRegistry, CoreCommands } from "@api/commands";
import { addCommandRefusal } from "@api/commandRefusals";

const SENTENCE = "A slicer or filter change is still being applied. Undo or redo once it has finished.";
const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function registerUndoRedo(): { calls: string[] } {
  const calls: string[] = [];
  CommandRegistry.register(CoreCommands.UNDO, async () => {
    calls.push("undo");
    return { success: true, message: "Undone." };
  });
  CommandRegistry.register(CoreCommands.REDO, async () => {
    calls.push("redo");
    return { success: true, message: "Redone." };
  });
  cleanups.push(() => {
    CommandRegistry.unregister(CoreCommands.UNDO);
    CommandRegistry.unregister(CoreCommands.REDO);
  });
  return { calls };
}

describe("the command line's undo / redo under a command refusal", () => {
  it("fails with the refusal's sentence and runs nothing", async () => {
    const { calls } = registerUndoRedo();
    cleanups.push(addCommandRefusal({ commandIds: [CoreCommands.UNDO, CoreCommands.REDO], refuse: () => SENTENCE }));
    const gateway = createLiveAppGateway();
    await expect(gateway.undo()).rejects.toThrow(SENTENCE);
    await expect(gateway.redo()).rejects.toThrow(SENTENCE);
    expect(calls, "a refused undo/redo reached the command").toEqual([]);
  });

  it("positive control: with no refusal the command runs and its result comes back", async () => {
    const { calls } = registerUndoRedo();
    cleanups.push(addCommandRefusal({ commandIds: [CoreCommands.UNDO, CoreCommands.REDO], refuse: () => null }));
    const gateway = createLiveAppGateway();
    await expect(gateway.undo()).resolves.toMatchObject({ success: true });
    expect(calls).toEqual(["undo"]);
  });
});
