//! FILENAME: app/extensions/Sparklines/__tests__/designTabSelectionOwner.test.ts
// PURPOSE: The contextual Sparkline design tab stands aside while a selection
//          owner (a floating grid's selected cell) holds the selection, and
//          comes back when the claim ends -- with Core's selection never moving
//          in between.
// CONTEXT: W22 (wave C). The tab followed Core's ACTIVE cell only, so it stayed
//          up for a sparkline cell HIDDEN under a floating grid whose own cell
//          held the selection (wave B's R3 even had to make its Group button
//          refuse). The claim is announced the way a floating grid really
//          announces it: its OBJECT selection changing
//          (@api/objectSelection notifyObjectSelectionChanged), heard by
//          @api/selectionOwner onSelectionOwnershipChanged. The extension is
//          ACTIVATED for real, so the subscription is part of what is tested.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
  /** Core's grid state, as @api/grid's snapshot reads it (null: no grid mounted). */
  snapshot: null as { selection: { startRow: number; startCol: number; endRow: number; endCol: number; type: string } } | null,
}));

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  listenForEvent: vi.fn(async () => () => {}),
  listenTauriEvent: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async () => null),
}));
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => h.snapshot,
}));
vi.mock("@api/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/ui")>()),
  registerPanel: (...a: unknown[]) => h.registerPanel(...a),
  unregisterPanel: (...a: unknown[]) => h.unregisterPanel(...a),
}));

import { registerExtensionRegistryService, type ExtensionRegistryService } from "@api/extensions";
import type { Selection } from "@api";
import { registerSelectionOwner } from "@api/selectionOwner";
import { notifyObjectSelectionChanged } from "@api/objectSelection";
import { SPARKLINE_DESIGN_TAB_ID } from "../manifest";
import { createSparklineGroup, resetSparklineStore } from "../store";
import extension from "../index";
import { ensureDesignTabRegistered } from "../handlers/selectionHandler";

// Core's selection, delivered the way the shell delivers it.
const selectionListeners = new Set<(sel: Selection | null) => void>();
registerExtensionRegistryService({
  registerAddIn: () => {},
  unregisterAddIn: () => {},
  registerCommand: () => {},
  getCommand: () => undefined,
  getAllCommands: () => [],
  registerRibbonTab: () => {},
  unregisterRibbonTab: () => {},
  registerRibbonGroup: () => {},
  getRibbonTabs: () => [],
  getRibbonGroupsForTab: () => [],
  notifySelectionChange: (sel: Selection | null) => selectionListeners.forEach((l) => l(sel)),
  onSelectionChange: (cb: (sel: Selection | null) => void) => {
    selectionListeners.add(cb);
    return () => selectionListeners.delete(cb);
  },
  onCellChange: () => () => {},
  onRegistryChange: () => () => {},
} as ExtensionRegistryService);

/** Core's selection moves -- and its own ownership prompt settles, so each
 *  step below is heard for the event it is (not a later one's). */
async function moveCoreSelectionTo(row: number, col: number): Promise<void> {
  const sel = { startRow: row, startCol: col, endRow: row, endCol: col, type: "cells" } as Selection;
  selectionListeners.forEach((l) => l(sel));
  await settle();
}

/** Is the design tab registered right now, per the calls made? */
function tabIsShown(): boolean {
  const events = [
    ...h.registerPanel.mock.calls
      .map((c, i) => ({ id: (c[0] as { id: string }).id, n: h.registerPanel.mock.invocationCallOrder[i], on: true })),
    ...h.unregisterPanel.mock.calls
      .map((c, i) => ({ id: c[0] as string, n: h.unregisterPanel.mock.invocationCallOrder[i], on: false })),
  ]
    .filter((e) => e.id === SPARKLINE_DESIGN_TAB_ID)
    .sort((a, b) => a.n - b.n);
  return events.length > 0 ? events[events.length - 1].on : false;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await Promise.resolve();
}

/** Every door of the context inert; the backend answers nothing. */
function inertContext(): never {
  const inert = (): unknown =>
    new Proxy(() => () => {}, {
      get: (_t, prop) => (prop === "then" ? undefined : inert()),
      apply: () => () => {},
    });
  return new Proxy(inert() as Record<string, unknown>, {
    get: (t, prop) =>
      prop === "invokeBackend" ? vi.fn(async () => null) : (t as Record<string | symbol, unknown>)[prop as string],
  }) as never;
}

let owns = false;
let releaseOwner: () => void = () => {};

async function ownerClaims(claim: boolean): Promise<void> {
  owns = claim;
  notifyObjectSelectionChanged();
  await settle();
}

beforeEach(() => {
  h.registerPanel.mockClear();
  h.unregisterPanel.mockClear();
  h.snapshot = null;
  owns = false;
  releaseOwner = registerSelectionOwner({
    id: "test-floating-grid",
    label: "a floating grid's cells",
    ownsSelection: () => owns,
  });
  extension.activate(inertContext());
  resetSparklineStore();
  // A sparkline in B2 (row 1, col 1) drawn from C2:F2.
  createSparklineGroup(
    { startRow: 1, startCol: 1, endRow: 1, endCol: 1 },
    { startRow: 1, startCol: 2, endRow: 1, endCol: 5 },
    "line",
  );
});

afterEach(() => {
  extension.deactivate?.();
  releaseOwner();
});

describe("the Sparkline design tab stands aside while a selection owner holds the selection", () => {
  it("hides when the claim starts and returns when it ends, Core's selection unmoved", async () => {
    await moveCoreSelectionTo(1, 1);
    expect(tabIsShown(), "positive control: the active cell holds a sparkline").toBe(true);

    await ownerClaims(true);
    expect(tabIsShown(), "the tab stayed up for a sparkline cell hidden under the owner").toBe(false);

    await ownerClaims(false);
    expect(tabIsShown(), "the tab did not come back when the claim ended").toBe(true);
  });

  it("stays hidden while claimed, even if Core's selection moves onto the sparkline meanwhile", async () => {
    await moveCoreSelectionTo(5, 5);
    await ownerClaims(true);
    await moveCoreSelectionTo(1, 1);
    expect(tabIsShown()).toBe(false);
  });

  it("positive control: a claim while the active cell holds no sparkline changes nothing", async () => {
    await moveCoreSelectionTo(5, 5);
    await ownerClaims(true);
    await ownerClaims(false);
    expect(tabIsShown()).toBe(false);
  });

  // Wave C review of W22: ensureDesignTabRegistered (Insert > Sparklines'
  // create) CLEARS the handler's last-checked cell, and the re-derive after a
  // claim asked only that cache -- so a tab a create had shown stayed hidden
  // after the claim ended, until the user moved the cursor.
  it("the tab a CREATE showed comes back when the claim ends, Core's selection unmoved", async () => {
    resetSparklineStore();
    await moveCoreSelectionTo(1, 1);
    expect(tabIsShown(), "positive control: B2 holds no sparkline yet").toBe(false);
    createSparklineGroup(
      { startRow: 1, startCol: 1, endRow: 1, endCol: 1 },
      { startRow: 1, startCol: 2, endRow: 1, endCol: 5 },
      "line",
    );
    ensureDesignTabRegistered();
    await settle();
    expect(tabIsShown(), "positive control: the create shows the tab").toBe(true);

    await ownerClaims(true);
    expect(tabIsShown()).toBe(false);
    await ownerClaims(false);
    expect(tabIsShown(), "the tab a create showed did not come back when the claim ended").toBe(true);
  });

  it("the tab comes back when the claim ends although the handler never heard Core's selection (grid state)", async () => {
    // Core's active cell is B2 -- it holds the sparkline -- but it was set before
    // this extension listened, so only the grid's own state knows it.
    h.snapshot = { selection: { startRow: 1, startCol: 1, endRow: 1, endCol: 1, type: "cells" } };
    ensureDesignTabRegistered();
    await settle();
    expect(tabIsShown(), "positive control").toBe(true);

    await ownerClaims(true);
    expect(tabIsShown()).toBe(false);
    await ownerClaims(false);
    expect(tabIsShown(), "the tab did not come back for Core's active cell from the grid state").toBe(true);
  });

  it("positive control: the grid state's active cell holding NO sparkline keeps the tab hidden after the claim", async () => {
    h.snapshot = { selection: { startRow: 5, startCol: 5, endRow: 5, endCol: 5, type: "cells" } };
    ensureDesignTabRegistered();
    await settle();
    await ownerClaims(true);
    await ownerClaims(false);
    expect(tabIsShown()).toBe(false);
  });
});
