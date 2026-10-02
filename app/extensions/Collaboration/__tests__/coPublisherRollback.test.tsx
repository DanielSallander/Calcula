//! FILENAME: app/extensions/Collaboration/__tests__/coPublisherRollback.test.tsx
// PURPOSE: A ROLLED-BACK co-publisher list is never the base of the creator's
//          next edit. Bob, removed at revision 2, puts revision 1 back with its
//          still-valid signature; the creator then adds Carol. The editor
//          builds the whole list from what the listing calls CURRENT (Rust
//          hides the rolled-back entries there and reports them apart), names
//          whom the older list re-adds in an awaited, fail-closed confirm, and
//          only on a yes sends the list WITH the acknowledgement of that exact
//          served revision -- which Rust requires before it writes on top of a
//          rolled-back list. Bob stays out.
// CONTEXT: Rust's half (the listing reports the rollback apart, a change
//          without the acknowledgement is refused, the written list) is pinned
//          by `a_rolled_back_list_is_never_the_base_of_the_creators_next_edit`
//          (app/src-tauri/src/calp_developer_anchor_tests.rs). The confirm is
//          doubled in the TAURI shape -- a Promise.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CoPublishersResponse, WorkingCopyStatus } from "@api";

const listCoPublishers = vi.fn();
const setCoPublishers = vi.fn();
const confirmAsync = vi.fn();
const promptAsync = vi.fn();

vi.mock("@api", () => ({
  listCoPublishers: (...a: unknown[]) => listCoPublishers(...a),
  setCoPublishers: (...a: unknown[]) => setCoPublishers(...a),
  myPublisherKey: vi.fn(),
  workingCopyStatus: vi.fn(async () => STATUS),
  AppEvents: { AFTER_OPEN: "after-open", PACKAGE_UPDATED: "package-updated" },
  ENVIRONMENTS_CHANGED_EVENT: "environments-changed",
  onAppEvent: () => () => undefined,
}));

vi.mock("@api/dialogs", () => ({
  confirmAsync: (...a: unknown[]) => confirmAsync(...a),
  promptAsync: (...a: unknown[]) => promptAsync(...a),
}));

import { WorkingCopySection } from "../components/WorkingCopySection";
import { planCoPublisherChange } from "../lib/coPublisherChange";

const BOB = "b0b0".repeat(16);
const CAROL = "ca40".repeat(16);
const ALICE = "a11c".repeat(16);

const STATUS = {
  registryUrl: "C:/ws",
  packageName: "sales",
  kind: "report",
  baseVersion: "1.0.0",
  checkedOutAt: "2026-09-30T00:00:00Z",
  lastPushedVersion: "",
  lastPushedAt: "",
  baseSheets: [],
  registryReachable: true,
  headVersion: "1.0.0",
  isStale: false,
  versions: [],
  holdsPublisherKey: true,
  registryError: "",
  environments: [],
  youMayPromote: true,
} as unknown as WorkingCopyStatus;

const ROLLED_BACK: CoPublishersResponse = {
  packageName: "sales",
  rootKey: ALICE,
  youAreTheRoot: true,
  youMayPublish: true,
  // Rust does not present the rolled-back list as the current one.
  coPublishers: [],
  problem: "The workspace is serving revision 1 of this list, and this computer has already seen revision 2.",
  notice: "",
  rolledBack: {
    servedRevision: 1,
    seenRevision: 2,
    servedCoPublishers: [{ key: BOB, name: "Bob", addedAt: "", isYou: false }],
  },
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  listCoPublishers.mockReset().mockResolvedValue(ROLLED_BACK);
  setCoPublishers.mockReset().mockResolvedValue({ ...ROLLED_BACK, rolledBack: null, problem: "" });
  confirmAsync.mockReset();
  promptAsync.mockReset().mockImplementation(async (message: string) =>
    /publisher key/.test(message) ? CAROL : "Carol",
  );
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function buttonNamed(text: RegExp): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((b) => text.test(b.textContent ?? ""));
  if (!found) throw new Error(`no button ${text}: ${host.textContent}`);
  return found as HTMLButtonElement;
}

async function openAndAdd(): Promise<void> {
  await act(async () => root.render(<WorkingCopySection />));
  await flush();
  await act(async () => buttonNamed(/Who can publish this/).click());
  await flush();
  await act(async () => buttonNamed(/Add a co-publisher/).click());
  await flush();
}

describe("a rolled-back co-publisher list", () => {
  it("is shown apart, naming whom it re-adds -- never as the current list", async () => {
    await act(async () => root.render(<WorkingCopySection />));
    await flush();
    await act(async () => buttonNamed(/Who can publish this/).click());
    await flush();
    const box = host.querySelector("[data-testid=co-publishers-rolled-back]");
    expect(box?.textContent).toContain("revision 1");
    expect(box?.textContent).toContain("Bob");
    expect(host.textContent).toContain("Only the original publisher can push to this application.");
  });

  // SABOTAGE: drop the `rollbackConfirmation` confirm from `applyChange`
  // (WorkingCopySection), or send the change when it resolves false.
  it("asks first, naming whom the older list re-adds, and writes nothing on a No", async () => {
    confirmAsync.mockReturnValue(Promise.resolve(false));
    await openAndAdd();
    expect(confirmAsync).toHaveBeenCalledTimes(1);
    const [message] = confirmAsync.mock.calls[0] as [string];
    expect(message).toContain("revision 1");
    expect(message).toContain("revision 2");
    expect(message).toContain("Bob");
    expect(message).toMatch(/will NOT be able to publish: Bob/);
    expect(setCoPublishers).not.toHaveBeenCalled();
  });

  // SABOTAGE: build `next` from `rolledBack.servedCoPublishers` in
  // planCoPublisherChange; or drop `acknowledgedRolledBackRevision` from the
  // setCoPublishers call.
  it("on a yes, sends Carol ONLY, acknowledging the served revision -- Bob stays out", async () => {
    confirmAsync.mockReturnValue(Promise.resolve(true));
    await openAndAdd();
    expect(setCoPublishers).toHaveBeenCalledTimes(1);
    expect(setCoPublishers.mock.calls[0][0]).toEqual({
      registryPath: "C:/ws",
      packageName: "sales",
      coPublishers: [{ key: CAROL, name: "Carol" }],
      acknowledgedRolledBackRevision: 1,
    });
  });

  it("an ordinary list is changed without the question, and acknowledges nothing", async () => {
    const current: CoPublishersResponse = {
      ...ROLLED_BACK,
      problem: "",
      rolledBack: null,
      coPublishers: [{ key: BOB, name: "Bob", addedAt: "", isYou: false }],
    };
    const plan = planCoPublisherChange(current, "sales", { add: { key: CAROL, name: "Carol" } });
    expect(plan).toEqual({ next: [{ key: BOB, name: "Bob" }, { key: CAROL, name: "Carol" }] });
    const removed = planCoPublisherChange(current, "sales", { removeKey: BOB });
    expect(removed.next).toEqual([]);
    expect(removed.acknowledgedRolledBackRevision).toBeUndefined();
  });
});
