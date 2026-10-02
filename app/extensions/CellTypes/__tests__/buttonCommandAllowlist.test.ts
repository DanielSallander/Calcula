//! FILENAME: app/extensions/CellTypes/__tests__/buttonCommandAllowlist.test.ts
// PURPOSE: plan_M8 S2 -- the PAGE's half of an application's button command.
//          A button cell that came with an application may run a Calcula
//          command only when TWO independent yeses agree: Rust's (the command
//          is on DISTRIBUTABLE_BUTTON_COMMANDS, approved under
//          `button-commands:<application>`, the private-sheet rule -- the door
//          answers `command` WITH the application only then) and the page's,
//          which only the page can give: the command's LIVE registration opts
//          in (`distributableTrigger: true`) and nothing has been registered
//          over it. Then `authorize_button_command` asks Rust again from its
//          own store and writes the run row, and only after it resolves does
//          the command run.
// CONTEXT: The registry lets a later registration SHADOW an id
//          (shell/registries/ExtensionRegistry.ts registerCommand), and
//          `window.__CALCULA_EXTENSION_REGISTRY__` hands `registerCommand` to
//          any main-realm code, so the flag is read off the LIVE object at the
//          click -- never remembered -- and an id that is shadowed at all is
//          refused: a shadow that sets the flag itself would pass the flag
//          read. The registry here is a double with the shell's stacking
//          (the last registration is live; anything under it is shadowed),
//          behind the REAL @api facade.
//
//          THE PAGE NEVER CLASSIFIES A BUTTON BY ITS CACHED PARAMS (plan drift
//          from S2 C4): whether a click is the user's own command or an
//          application's is the DOOR's answer (`application`), read from
//          Rust's store. A stamp the page cannot read is refused by the door
//          (`stampUnreadable`) before any command answer exists.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CommandDefinition, ExtensionRegistryService } from "@api/extensions";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const h = vi.hoisted(() => ({
  /** Every backend call the click made, in order. */
  calls: [] as { cmd: string; args: unknown }[],
  /** The door's answer for this click. */
  door: null as unknown,
  /** How `authorize_button_command` answers (default: Rust says yes). */
  authorize: (() => Promise.resolve()) as () => Promise<void>,
  toasts: [] as { message: string; variant?: string }[],
  context: { marker: "the shared builder's context", selection: null } as Record<string, unknown>,
  /** The order things happened in, for the before/after assertions. */
  events: [] as string[],
}));

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  invokeBackend: async (cmd: string, args?: unknown) => {
    h.calls.push({ cmd, args });
    if (cmd === "run_control_action") return h.door;
    if (cmd === "authorize_button_command") {
      h.events.push("authorize:asked");
      await h.authorize();
      h.events.push("authorize:resolved");
      return undefined;
    }
    return undefined;
  },
}));
// The clicked button cell sits on the TRUE sheet index 3.
vi.mock("../../../src/api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/api/grid")>()),
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: 3 } }),
}));
vi.mock("@api/commandDispatch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/commandDispatch")>()),
  buildCommandContext: () => h.context,
}));
vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/notifications")>()),
  showToast: (message: string, options?: { variant?: string }) => {
    h.toasts.push({ message, variant: options?.variant });
  },
}));
vi.mock("@api/designMode", () => ({ getDesignMode: () => false }));
vi.mock("@api/gridDispatch", () => ({ dispatchGridAction: vi.fn() }));

import { registerExtensionRegistryService } from "@api/extensions";
import { buttonCellType } from "../types/button";
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


// ---------------------------------------------------------------------------
// The registry: the shell's stacking, behind the real facade.
// ---------------------------------------------------------------------------

const stacks = new Map<string, CommandDefinition[]>();

function register(command: CommandDefinition): void {
  const stack = stacks.get(command.id) ?? [];
  stack.push(command);
  stacks.set(command.id, stack);
}

registerExtensionRegistryService({
  registerCommand: register,
  getCommand: (id: string) => stacks.get(id)?.[stacks.get(id)!.length - 1],
  isCommandShadowed: (id: string) => (stacks.get(id)?.length ?? 0) > 1,
  getAllCommands: () => [...stacks.values()].map((s) => s[s.length - 1]),
} as unknown as ExtensionRegistryService);

function command(id: string, over: Partial<CommandDefinition> = {}): CommandDefinition & { execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(async () => {
    h.events.push(`execute:${id}`);
  });
  return { id, name: `Command ${id}`, execute, ...over } as CommandDefinition & { execute: ReturnType<typeof vi.fn> };
}

const APP = "Quarterly Reports";
const STAMP = { workspace: "ws-scope", application: APP, version: "1.0.0" };

/** Click the button cell at C3 (row 2, col 2); the door answers `command`. */
async function click(commandId: string, application: string | null, params: Record<string, unknown> = {}): Promise<void> {
  h.door = { kind: "command", commandId, application };
  const answer = await buttonCellType.onClick?.({
    row: 2,
    col: 2,
    typeId: "calcula.button",
    params,
    event: { clientX: 0, clientY: 0 } as never,
  } as never);
  await releaseOnTheButton(answer, 2, 2);
}

const sent = (): string[] => h.calls.map((c) => c.cmd);
const refusals = (): Array<Record<string, unknown>> =>
  h.calls.filter((c) => c.cmd === "audit_button_refusal").map((c) => c.args as Record<string, unknown>);

beforeEach(() => {
  stacks.clear();
  h.calls.length = 0;
  h.toasts.length = 0;
  h.events.length = 0;
  h.authorize = () => Promise.resolve();
});

describe("an application's button command: the LIVE registration must opt in", () => {
  // SABOTAGE (1): read the flag from what the page REMEMBERED about the id (a
  // Map filled the first time an id is judged) instead of the live object -> the
  // second click reads A's flag and is refused as shadowed, not "not allowed".
  it("is refused 'commandNotAllowed' when the live registration lacks the flag, even though an earlier one had it", async () => {
    const a = command("reader.refresh", { distributableTrigger: true });
    register(a);
    await click("reader.refresh", APP, { fromApplication: STAMP });
    expect(a.execute, "precondition: the flagged command ran").toHaveBeenCalledTimes(1);

    // Another registration of the same id, WITHOUT the flag, lands over it.
    const b = command("reader.refresh");
    register(b);
    h.calls.length = 0;
    h.toasts.length = 0;
    await click("reader.refresh", APP, { fromApplication: STAMP });

    expect(a.execute, "the shadowed registration ran").toHaveBeenCalledTimes(1);
    expect(b.execute, "an unflagged command ran from an application's button").not.toHaveBeenCalled();
    expect(sent(), "nothing may be authorized for a command the page refused").not.toContain("authorize_button_command");
    expect(refusals()).toEqual([
      { kind: "cell", sheetIndex: 3, row: 2, col: 2, refused: 'the command "reader.refresh"', reason: "commandNotAllowed" },
    ]);
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0].variant).toBe("error");
    expect(h.toasts[0].message).toContain(`came with the application '${APP}'`);
    expect(h.toasts[0].message).toContain("not on Calcula's list of commands a button from an application may run");
  });

  it("a command no registration opts in to is refused before anything is asked of Rust", async () => {
    const plain = command("cellTypes.clear");
    register(plain);
    await click("cellTypes.clear", APP, { fromApplication: STAMP });
    expect(plain.execute).not.toHaveBeenCalled();
    expect(sent()).not.toContain("authorize_button_command");
    expect(refusals().map((r) => r.reason)).toEqual(["commandNotAllowed"]);
  });

  it("a command nobody registered is refused 'commandUnregistered', said and recorded", async () => {
    await click("nowhere.command", APP, { fromApplication: STAMP });
    expect(sent()).not.toContain("authorize_button_command");
    expect(refusals().map((r) => r.reason)).toEqual(["commandUnregistered"]);
    expect(h.toasts[0].message).toContain('"nowhere.command"');
    expect(h.toasts[0].message).toContain("not registered");
  });
});

describe("a SHADOWED id is refused, flag or not", () => {
  // SABOTAGE (8): drop the shadow check -> the flagged shadow is authorized and
  // runs.
  it("a flagged registration over an unflagged one is refused 'commandShadowed' and authorize is never asked", async () => {
    const original = command("reader.refresh");
    const shadow = command("reader.refresh", { distributableTrigger: true });
    register(original);
    register(shadow);
    await click("reader.refresh", APP, { fromApplication: STAMP });
    expect(shadow.execute, "a shadowing registration ran from an application's button").not.toHaveBeenCalled();
    expect(original.execute).not.toHaveBeenCalled();
    expect(sent()).not.toContain("authorize_button_command");
    expect(refusals().map((r) => r.reason)).toEqual(["commandShadowed"]);
    expect(h.toasts[0].message).toContain("another registration has replaced");
  });
});

describe("Rust's second question comes first, and its answer is final", () => {
  // SABOTAGE (2): call execute before awaiting authorize_button_command -> the
  // order assertion goes red.
  it("runs exactly once, only after authorize_button_command has resolved, with the shared context", async () => {
    const flagged = command("reader.refresh", { distributableTrigger: true });
    register(flagged);
    const gate = deferred();
    h.authorize = () => gate.promise;

    const clicked = click("reader.refresh", APP, { fromApplication: STAMP });
    // Let the click reach the authorize call and wait there.
    for (let i = 0; i < 20 && !h.events.includes("authorize:asked"); i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.events, "the click never asked authorize_button_command").toContain("authorize:asked");
    expect(flagged.execute, "the command ran before Rust answered the second question").not.toHaveBeenCalled();

    gate.resolve();
    await clicked;
    expect(flagged.execute).toHaveBeenCalledTimes(1);
    expect(flagged.execute.mock.calls[0][0], "the command did not get the shared CommandContext").toBe(h.context);
    expect(h.events).toEqual(["authorize:asked", "authorize:resolved", "execute:reader.refresh"]);
    const asked = h.calls.find((c) => c.cmd === "authorize_button_command")?.args;
    expect(asked, "the request names the button and the command, and nothing else").toEqual({
      request: { sheetIndex: 3, row: 2, col: 2, commandId: "reader.refresh" },
    });
    expect(refusals(), "a run is not a refusal").toEqual([]);
    expect(h.toasts).toEqual([]);
  });

  // SABOTAGE (3): ignore the rejection (carry on to execute) -> the command
  // runs, red.
  it("a refusal by Rust: nothing runs, Rust's words are said, and the page records nothing of its own", async () => {
    const flagged = command("reader.refresh", { distributableTrigger: true });
    register(flagged);
    const rust =
      "APPLICATION_COMMAND_NOT_APPROVED: the button cell at Sheet4!C3 came with the application 'Quarterly Reports' " +
      "and asks to run the command \"reader.refresh\", which you have not approved for it.";
    h.authorize = () => Promise.reject(rust);
    await click("reader.refresh", APP, { fromApplication: STAMP });
    expect(flagged.execute, "a command Rust refused ran").not.toHaveBeenCalled();
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0].variant).toBe("error");
    expect(h.toasts[0].message).toContain(rust);
    expect(sent(), "Rust already recorded its refusal; the page must not write a second row").not.toContain(
      "audit_button_refusal",
    );
  });
});

describe("isEnabled is asked of every button's command", () => {
  // SABOTAGE (4): drop the isEnabled check -> both disabled commands run.
  it("the user's own command is not run when it is disabled", async () => {
    const own = command("format.bold", { isEnabled: () => false });
    register(own);
    await click("format.bold", null);
    expect(own.execute, "a disabled command ran from the user's own button").not.toHaveBeenCalled();
    expect(h.toasts.map((t) => t.message)).toEqual(['Button command "format.bold" is not available right now, so it did not run.']);
    expect(sent()).not.toContain("authorize_button_command");
    expect(sent()).not.toContain("audit_button_refusal");
  });

  it("an application's flagged command is not run when it is disabled, and the refusal is recorded", async () => {
    const flagged = command("reader.refresh", { distributableTrigger: true, isEnabled: () => false });
    register(flagged);
    await click("reader.refresh", APP, { fromApplication: STAMP });
    expect(flagged.execute, "a disabled command ran from an application's button").not.toHaveBeenCalled();
    expect(sent(), "a disabled command must not be authorized (a run row for a command that did not run)").not.toContain(
      "authorize_button_command",
    );
    expect(refusals().map((r) => r.reason)).toEqual(["commandDisabled"]);
    expect(h.toasts[0].message).toContain("not available right now");
  });

  it("isEnabled is asked with the context the command runs with (control)", async () => {
    const seen: unknown[] = [];
    const own = command("format.bold", {
      isEnabled: (ctx) => {
        seen.push(ctx);
        return true;
      },
    });
    register(own);
    await click("format.bold", null);
    expect(own.execute).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([h.context]);
  });
});

describe("the user's own command", () => {
  // SABOTAGE (5): authorize every command, the user's own included -> red.
  it("never asks authorize_button_command -- its command runs without asking", async () => {
    const own = command("format.bold");
    const ownFlagged = command("reader.refresh", { distributableTrigger: true });
    register(own);
    register(ownFlagged);
    await click("format.bold", null);
    await click("reader.refresh", null);
    expect(own.execute).toHaveBeenCalledTimes(1);
    expect(ownFlagged.execute).toHaveBeenCalledTimes(1);
    expect(sent()).not.toContain("authorize_button_command");
    expect(sent()).not.toContain("audit_button_refusal");
  });

  it("a shadowed id still runs for the user's own button: the shadow rule is about an application's buttons (control)", async () => {
    register(command("format.bold"));
    const live = command("format.bold");
    register(live);
    await click("format.bold", null);
    expect(live.execute).toHaveBeenCalledTimes(1);
  });
});

describe("whose button it is, is the DOOR's answer", () => {
  // SABOTAGE (9, re-specified): classify the click by the cached params'
  // stamp (`cellButtonApplication(params) !== null`) instead of the door's
  // `application` -> the first case runs the command as the user's own.
  it("an application's answer is never run as the user's own, whatever the cached params say", async () => {
    const flagged = command("reader.refresh", { distributableTrigger: true });
    register(flagged);
    h.authorize = () => Promise.reject("APPLICATION_COMMAND_NOT_APPROVED: not approved");
    // The page's cached params carry no stamp; Rust's store does.
    await click("reader.refresh", APP, { action: { kind: "command", commandId: "reader.refresh" } });
    expect(sent(), "an application's command was not put to Rust's second question").toContain("authorize_button_command");
    expect(flagged.execute, "an application's command ran as the user's own").not.toHaveBeenCalled();
  });

  it("the user's own answer runs as the user's own even when the cached params carry an unreadable stamp", async () => {
    // The door read Rust's store and found no stamp; the page has no say.
    const own = command("format.bold");
    register(own);
    await click("format.bold", null, { fromApplication: {}, action: { kind: "command", commandId: "format.bold" } });
    expect(own.execute).toHaveBeenCalledTimes(1);
    expect(sent()).not.toContain("authorize_button_command");
  });
});
