//! FILENAME: app/extensions/ScriptableObjects/__tests__/cellBehaviorAttachSelectionOwner.test.ts
// PURPOSE: The "Attach Cell Behavior to Selection" command (the palette's and a
//          button's door to the attach flow) binds a behavior to Core's
//          SELECTION, so it refuses with ONE toast and attaches nothing while a
//          selection owner holds the selection; it attaches when nothing does.
// CONTEXT: D4 review (wave B; BUG-0185 class). With a floating grid's cell
//          selected on a worksheet, Core's selection stays on a range HIDDEN
//          under the floating grid, and this command bound a behavior (and its
//          scaffolded script) to that range. The grid right-click "Attach
//          Behavior..." item acts on the right-clicked cell and stays allowed,
//          as every context menu does. TEST owner (@api/selectionOwner); the
//          real registration, with the binding store and the script machinery
//          doubled.

/* eslint-disable @typescript-eslint/naming-convention --
 * The module doubles below stand in for the @api namespace objects
 * (ExtensionRegistry, ObjectScriptManager). */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  commands: new Map<string, { execute: (ctx: unknown) => Promise<void> | void }>(),
  attached: [] as { startRow: number; startCol: number; endRow: number; endCol: number }[],
}));

vi.mock("@api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@api")>();
  return {
    ...real,
    ExtensionRegistry: {
      ...real.ExtensionRegistry,
      registerCommand: (command: { id: string; execute: (ctx: unknown) => Promise<void> | void }) =>
        void h.commands.set(command.id, command),
      // The commands are an add-in's contributions (W21: they go with it).
      registerAddIn: (manifest: { commands?: { id: string; execute: (ctx: unknown) => Promise<void> | void }[] }) =>
        manifest.commands?.forEach((command) => h.commands.set(command.id, command)),
      unregisterAddIn: vi.fn(),
    },
    ObjectScriptManager: { registerScript: vi.fn(), mountScript: vi.fn(async () => undefined) },
    registerRowGutterWidget: vi.fn(() => () => {}),
    registerGridLayer: vi.fn(() => () => {}),
  };
});
vi.mock("@api/cellBehaviors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/cellBehaviors")>()),
  refreshCellBehaviors: vi.fn(async () => undefined),
  activeBehaviorSheet: () => 0,
  attachCellBehavior: vi.fn(async (options: { startRow: number; startCol: number; endRow: number; endCol: number }) => {
    h.attached.push(options);
  }),
}));
vi.mock("@api/objectScriptBackend", () => ({ saveObjectScript: vi.fn(async () => undefined) }));

import { registerCellBehaviorUx } from "../lib/cellBehaviorUx";
import { registerSelectionOwner } from "@api/selectionOwner";
import { registerToastSink, type ToastPayload } from "@api/notifications";

const toasts: ToastPayload[] = [];
let owns = false;
let release: () => void = () => {};
let teardown: () => void = () => {};

function refusals(): ToastPayload[] {
  return toasts.filter((t) => t.message.includes("the selection belongs to"));
}

/** Every door of the context inert. */
function inertContext(): never {
  const inert = (): unknown =>
    new Proxy(() => () => {}, {
      get: (_t, prop) => (prop === "then" ? undefined : inert()),
      apply: () => () => {},
    });
  return inert() as never;
}

async function attachToSelection(): Promise<void> {
  const command = h.commands.get("cellBehaviors.attachToSelection");
  if (!command) throw new Error("the attach command was not registered");
  // Core's selection: B3:C4 -- hidden under the owner's object in the refusal case.
  await command.execute({ selection: { startRow: 2, startCol: 1, endRow: 3, endCol: 2, type: "cells" } });
}

beforeEach(() => {
  h.commands.clear();
  h.attached.length = 0;
  toasts.length = 0;
  registerToastSink((t) => toasts.push(t));
  owns = false;
  release = registerSelectionOwner({ id: "test-owner", label: "the test object's cells", ownsSelection: () => owns });
  teardown = registerCellBehaviorUx(inertContext());
});

afterEach(() => {
  teardown();
  release();
});

describe("Attach Cell Behavior to Selection while a selection owner holds the selection", () => {
  it("attaches nothing to Core's hidden selection; one toast", async () => {
    owns = true;
    await attachToSelection();
    expect(h.attached, "a behavior was bound to Core's HIDDEN selection").toEqual([]);
    expect(refusals().length).toBe(1);
  });
});

describe("positive control: nothing owns the selection", () => {
  it("binds the behavior to the selected range, no refusal", async () => {
    await attachToSelection();
    expect(h.attached).toEqual([expect.objectContaining({ startRow: 2, startCol: 1, endRow: 3, endCol: 2 })]);
    expect(refusals()).toEqual([]);
  });
});
