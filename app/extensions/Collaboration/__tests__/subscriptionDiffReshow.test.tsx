//! FILENAME: app/extensions/Collaboration/__tests__/subscriptionDiffReshow.test.tsx
// PURPOSE: The subscriber's diff (View changes / Reset to published) compares
//          AGAIN on every show and on "Compare again", never hangs on
//          "Comparing...", and names its sheets by stable id (review round 8,
//          REFUSAL-UX F3; ids in round 9).
// CONTEXT: The diff's refusal tells the user to "try again", and the only way
//          to without closing was to show the dialog again from the tab menu.
//          That bumped `__openCount`: the reset effect put the dialog back to
//          "Comparing against the published version..." with "Reset to
//          published..." disabled, but the comparison's own effect keyed only
//          on the application, so it never ran again -- the dialog hung until
//          it was closed. The same happened for View changes followed by Reset
//          on the same tab. A slow comparison could also land under a later
//          show.
//
//          MOUNTED, with only the Tauri boundary (@api/collaboration) doubled.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { VersionDiff } from "@api";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const REFUSAL =
  "WORKBOOK_CHANGED_WHILE_SAVING: the workbook changed while it was being compared -- a sheet was " +
  "added, deleted or moved during each of 3 attempts to read it. Nothing was written; try again.";
const PLAIN =
  "The workbook changed while it was being compared -- a sheet was added, deleted or moved during " +
  "each of 3 attempts to read it. Nothing was written; try again.";

const EMPTY_DIFF: VersionDiff = {
  packageName: "sales",
  fromVersion: "1.0.0",
  toVersion: "working copy",
  artifacts: { added: [], removed: [], changed: [], spuriousHashChanges: 0, unchangedCount: 0 },
  sheets: [],
  objects: [],
  manifestChanges: [],
  totals: {
    objectsAdded: 0,
    objectsRemoved: 0,
    objectsModified: 0,
    sheetsChanged: 0,
    cellsChanged: 0,
    cellsChangedExact: true,
  },
};

const h = vi.hoisted(() => ({
  diffs: [] as Record<string, unknown>[],
  /** One per coming comparison: a string REJECTS with it, a promise settles when the test says. */
  answers: [] as unknown[],
  /** The provenance rows the dialog reads. */
  rows: [] as Record<string, unknown>[],
}));

vi.mock("@api/collaboration", () => ({
  diffWorkingCopy: vi.fn(async (params: Record<string, unknown>) => {
    h.diffs.push(params);
    const answer = h.answers.shift();
    if (typeof answer === "string") throw answer;
    const settled = await (answer as Promise<unknown> | undefined);
    if (typeof settled === "string") throw settled;
    return { packageName: "sales", baseVersion: "1.0.0", diff: settled ?? EMPTY_DIFF, code: null };
  }),
  resetSubscription: vi.fn(),
  getSheetProvenance: vi.fn(async () => h.rows),
}));
vi.mock("../lib/refreshAftermath", () => ({ announceSubscribedContentReplaced: vi.fn(async () => undefined) }));

import { SubscriptionDiffDialog } from "../components/SubscriptionDiffDialog";

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  for (let i = 0; i < 14; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const screenText = (): string => container.textContent ?? "";
const buttonNamed = (name: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
const compareAgain = (): HTMLElement | null =>
  container.querySelector<HTMLElement>('[data-testid="subscription-diff-retry"]');

async function show(mode: "view" | "reset", openCount: number): Promise<void> {
  await act(async () => {
    root.render(
      <SubscriptionDiffDialog
        isOpen
        onClose={vi.fn()}
        data={{
          registryUrl: "\\\\server\\apps",
          packageName: "sales",
          resolvedVersion: "1.0.0",
          mode,
          __openCount: openCount,
        }}
      />,
    );
  });
  await flush();
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  h.diffs.length = 0;
  h.answers.length = 0;
  h.rows = [
    {
      role: "subscribed",
      packageName: "sales",
      registryUrl: "\\\\server\\apps",
      upstreamRemoved: false,
      sheetIndex: 1,
      sheetId: "local-sheet-1",
      packageSheetId: "pub-sheet-1",
    },
  ];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("showing the diff again compares again", () => {
  // SABOTAGE: drop `openCount` from the comparison effect's dependencies --
  // the re-show then hangs on "Comparing..." with Reset disabled.
  it("after a refusal, the same tab's Reset compares again: a second comparison, its result, Reset enabled", async () => {
    h.answers.push(REFUSAL, EMPTY_DIFF);
    await show("reset", 1);
    expect(h.diffs).toHaveLength(1);
    expect(screenText()).toContain(PLAIN);

    await show("reset", 2);
    expect(h.diffs, "the re-show never compared again").toHaveLength(2);
    expect(screenText()).toContain("No differences between");
    expect(screenText(), "the dialog hung on Comparing...").not.toContain("Comparing against the published version");
    expect(buttonNamed("Reset to published…")?.disabled, "Reset stayed disabled").toBe(false);
  });

  it("View changes, then Reset on the same application: the reset compares again instead of hanging", async () => {
    h.answers.push(EMPTY_DIFF, EMPTY_DIFF);
    await show("view", 1);
    expect(h.diffs).toHaveLength(1);
    await show("reset", 2);
    expect(h.diffs).toHaveLength(2);
    expect(screenText()).not.toContain("Comparing against the published version");
    expect(buttonNamed("Reset to published…")?.disabled).toBe(false);
  });
});

describe("Compare again", () => {
  // SABOTAGE: make the button's click not bump `attempt`.
  it("sits beside a refusal and compares exactly once more", async () => {
    h.answers.push(REFUSAL, EMPTY_DIFF);
    await show("view", 1);
    expect(compareAgain(), "a refusal that says 'try again' offered nothing to try again with").toBeTruthy();
    await act(async () => {
      compareAgain()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(h.diffs).toHaveLength(2);
    expect(screenText()).toContain("No differences between");
    expect(compareAgain()).toBeNull();
  });

  // SABOTAGE: drop the `if (!cancelled)` from the comparison's catch -- the
  // replaced run's late failure lands over the newer answer.
  it("a comparison a newer one replaced keeps its late answer to itself", async () => {
    let failLate: (reason: string) => void = () => {};
    const late = new Promise<VersionDiff>((_resolve, reject) => {
      failLate = reject;
    });
    late.catch(() => undefined);
    h.answers.push(late, EMPTY_DIFF);
    await show("view", 1);
    await show("view", 2);
    expect(screenText()).toContain("No differences between");
    await act(async () => {
      failLate("CALP_VERSION_UNREADABLE: the late answer of a replaced comparison");
    });
    await flush();
    expect(screenText(), "a replaced comparison's answer landed").not.toContain("late answer");
    expect(screenText()).toContain("No differences between");
  });
});

describe("the comparison names its sheets by stable id", () => {
  // SABOTAGE: send `sheetIndices` only from SubscriptionDiffDialog.
  it("sends this workbook's LOCAL ids (sheetIds) beside the positions, and the publisher's as the scope", async () => {
    h.answers.push(EMPTY_DIFF);
    await show("view", 1);
    expect(h.diffs[0].sheetIds).toEqual(["local-sheet-1"]);
    expect(h.diffs[0].sheetIndices).toEqual([1]);
    expect(h.diffs[0].scopeSheetIds).toEqual(["pub-sheet-1"]);
  });

  it("a row with no id sends positions only", async () => {
    h.rows = [{ ...h.rows[0], sheetId: "" }];
    h.answers.push(EMPTY_DIFF);
    await show("view", 1);
    expect(h.diffs[0].sheetIndices).toEqual([1]);
    expect("sheetIds" in h.diffs[0]).toBe(false);
  });
});
