//! FILENAME: app/src/shell/registries/__tests__/commandShadowing.test.ts
// PURPOSE: plan_M8 S2 (ii-b) -- the registry can say whether an id is
//          SHADOWED: a later registerCommand overwrote an earlier registration
//          that is still standing under it, or the live registration is not
//          the FIRST one made under the id (the original was taken back and a
//          copy registered), or it carries the flag without having been
//          registered with it (a flagged command is frozen as it is
//          registered, so it cannot be edited in place). A button cell that came with an
//          application refuses such an id even when the live registration
//          carries `distributableTrigger: true`, because the registry hands
//          `registerCommand` to any main-realm code
//          (`window.__CALCULA_EXTENSION_REGISTRY__`, shell/bootstrap.ts) and a
//          shadow that sets the flag itself would pass the live-flag read.
// CONTEXT: The shell answers it (`ExtensionRegistry.isShadowed`), bootstrap
//          wires it into the @api service (`isCommandShadowed`), and the @api
//          facade FAILS CLOSED -- no service, or one that cannot answer, says
//          "shadowed", so the application's command is refused rather than run
//          on an answer nobody gave.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ExtensionRegistry } from "../ExtensionRegistry";
import type { Command } from "../types";
import { judgeApplicationCommand } from "../../../api/heldButtonCode";

function makeCommand(id: string, over: Partial<Command> = {}): Command {
  return { id, name: `Command ${id}`, execute: vi.fn(), ...over };
}

beforeEach(() => {
  ExtensionRegistry.clear();
});

describe("ExtensionRegistry.isShadowed", () => {
  // SABOTAGE: make isShadowed answer `false` always -> red.
  it("is false for one registration, true once another lands over it, and false again when it is taken back", () => {
    const first = makeCommand("reader.refresh");
    const second = makeCommand("reader.refresh", { distributableTrigger: true });
    expect(ExtensionRegistry.isShadowed("reader.refresh"), "nothing registered").toBe(false);
    ExtensionRegistry.registerCommand(first);
    expect(ExtensionRegistry.isShadowed("reader.refresh"), "one registration shadows nothing").toBe(false);
    ExtensionRegistry.registerCommand(second);
    expect(ExtensionRegistry.getCommand("reader.refresh")).toBe(second);
    expect(ExtensionRegistry.isShadowed("reader.refresh"), "a registration over another is a shadow").toBe(true);
    ExtensionRegistry.unregisterCommand(second);
    expect(ExtensionRegistry.getCommand("reader.refresh")).toBe(first);
    expect(ExtensionRegistry.isShadowed("reader.refresh"), "the shadow was taken back").toBe(false);
  });

  it("the same object registered twice is no shadow (registerCommand ignores it)", () => {
    const only = makeCommand("format.bold");
    ExtensionRegistry.registerCommand(only);
    ExtensionRegistry.registerCommand(only);
    expect(ExtensionRegistry.isShadowed("format.bold")).toBe(false);
  });

  it("the same object registered again after it was taken back is still the original: no shadow", () => {
    const only = makeCommand("format.bold", { distributableTrigger: true });
    ExtensionRegistry.registerCommand(only);
    ExtensionRegistry.unregisterCommand(only);
    ExtensionRegistry.registerCommand(only);
    expect(ExtensionRegistry.isShadowed("format.bold")).toBe(false);
  });
});

// THE ATTACKER THE CHECK NAMES. `window.__CALCULA_EXTENSION_REGISTRY__` hands
// getCommand, unregisterCommand and registerCommand to any main-realm code, and
// command objects were mutable: the stack alone could be emptied again, or the
// live object's `execute` swapped. Each shape below must read SHADOWED, and the
// page's own judgement (`judgeApplicationCommand`) must then refuse.
describe("a command cannot be made to read as the original by taking it back or editing it", () => {
  // SABOTAGE: drop the first-registration check from isShadowed -> red.
  it("taken back, then a copy with another execute registered under its id: SHADOWED", () => {
    const original = makeCommand("reader.refresh", { distributableTrigger: true });
    ExtensionRegistry.registerCommand(original);
    const live = ExtensionRegistry.getCommand("reader.refresh")!;
    ExtensionRegistry.unregisterCommand(live);
    const evil = vi.fn();
    ExtensionRegistry.registerCommand({ ...live, execute: evil });
    expect(ExtensionRegistry.getCommand("reader.refresh")?.execute).toBe(evil);
    expect(ExtensionRegistry.isShadowed("reader.refresh"), "a copy registered after the original was taken back").toBe(true);
    expect(judgeApplicationCommand(ExtensionRegistry.getCommand("reader.refresh"), ExtensionRegistry.isShadowed("reader.refresh"))).toBe(
      "commandShadowed",
    );
  });

  // SABOTAGE: same as above (the first-registration check) -> red.
  it("the original taken back from UNDER a registration laid over it: still SHADOWED", () => {
    const under = makeCommand("format.bold", { distributableTrigger: true });
    const over = makeCommand("format.bold", { distributableTrigger: true });
    ExtensionRegistry.registerCommand(under);
    ExtensionRegistry.registerCommand(over);
    ExtensionRegistry.unregisterCommand(under);
    expect(ExtensionRegistry.getCommand("format.bold")).toBe(over);
    expect(ExtensionRegistry.isShadowed("format.bold"), "the stack is empty, but the live one is not the original").toBe(true);
  });

  // SABOTAGE: drop the Object.freeze in registerCommand -> red.
  it("a FLAGGED command cannot be edited in place: its execute stays the one registered", () => {
    const execute = vi.fn();
    const original = makeCommand("reader.refresh", { distributableTrigger: true, execute });
    ExtensionRegistry.registerCommand(original);
    const live = ExtensionRegistry.getCommand("reader.refresh")! as { execute: unknown };
    const evil = vi.fn();
    expect(() => {
      live.execute = evil;
    }, "assigning execute on a registered, flagged command").toThrow(TypeError);
    expect(ExtensionRegistry.getCommand("reader.refresh")?.execute).toBe(execute);
    expect(ExtensionRegistry.isShadowed("reader.refresh")).toBe(false);
  });

  // SABOTAGE: drop the unfrozen-flag check from isShadowed -> red.
  it("a command registered WITHOUT the flag that has it set in place afterwards: SHADOWED", () => {
    const plain = makeCommand("reader.refresh");
    ExtensionRegistry.registerCommand(plain);
    (ExtensionRegistry.getCommand("reader.refresh") as { distributableTrigger?: boolean }).distributableTrigger = true;
    expect(ExtensionRegistry.isShadowed("reader.refresh"), "a flag nobody registered").toBe(true);
    expect(judgeApplicationCommand(ExtensionRegistry.getCommand("reader.refresh"), ExtensionRegistry.isShadowed("reader.refresh"))).toBe(
      "commandShadowed",
    );
  });
});

describe("the @api facade asks the shell, and fails closed", () => {
  it("bootstrap wires isCommandShadowed to the shell registry's answer", () => {
    const bootstrap = readFileSync(join(__dirname, "..", "..", "bootstrap.ts"), "utf8");
    expect(bootstrap).toContain("isCommandShadowed: (commandId) => ExtensionRegistryImpl.isShadowed(commandId),");
  });

  it("with no service, or one that cannot answer, an id counts as shadowed", async () => {
    vi.resetModules();
    const api = await import("../../../api/extensions");
    expect(api.ExtensionRegistry.isCommandShadowed("reader.refresh"), "no service registered").toBe(true);
    api.registerExtensionRegistryService({ getCommand: () => undefined } as never);
    expect(api.ExtensionRegistry.isCommandShadowed("reader.refresh"), "a service without the query").toBe(true);
    api.registerExtensionRegistryService({ isCommandShadowed: () => false } as never);
    expect(api.ExtensionRegistry.isCommandShadowed("reader.refresh"), "the service's own answer (control)").toBe(false);
  });
});
