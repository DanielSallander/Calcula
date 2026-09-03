//! FILENAME: app/src/api/scriptHost/__tests__/formLiveWatchDisposal.test.ts
// PURPOSE: The Controls-pane half of a form's live watch must not outlive the
//          form. installFormLiveWatch reaches `onControlValueChange` through a
//          DYNAMIC import, so the cleanup can run before the import settles.
// CONTEXT: A form the user (or the ack deadline) closes in the same turn it
//          opened ran the cleanup FIRST, against a still-empty `unsubControls`,
//          and the import's `.then` then installed a live listener with nobody
//          left to remove it. It kept firing for the rest of the session,
//          re-seeding a session that was gone and spending an audited
//          `form.readControl` per committed control change on a form nobody
//          could see. The ordering is driven here on purpose: no public entry
//          point can put a cleanup between the import and its `.then`.

import { describe, it, expect, vi, beforeEach } from "vitest";

// The Controls-pane facade, as the watch reaches it: one spy for the
// subscription and one for the unsubscribe it hands back.
const controls = vi.hoisted(() => {
  const off = vi.fn();
  const onControlValueChange = vi.fn(() => off);
  return { off, onControlValueChange };
});

// The mount path touches the backend for grants and snapshot seeds; none of it
// is under test here (the same doubles formSubmitVerdict.test.ts installs).
vi.mock("../../backend", () => ({
  invokeBackend: vi.fn().mockResolvedValue(null),
  getWorkbookProperties: vi.fn().mockRejectedValue(new Error("no backend in test")),
  emitTauriEvent: vi.fn().mockResolvedValue(undefined),
  listenTauriEvent: vi.fn().mockResolvedValue(() => undefined),
}));
vi.mock("../capabilities", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  restoreAndSyncGrants: vi.fn().mockResolvedValue(undefined),
  revokeBackendCapabilities: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../mountGate", () => ({
  assertMountAllowed: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../controlValues", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  onControlValueChange: controls.onControlValueChange,
}));

import { installFormLiveWatch } from "../host";

type WatchWorker = Parameters<typeof installFormLiveWatch>[0];
type WatchBindings = Parameters<typeof installFormLiveWatch>[2];

/** Enough of a mounted worker for the watch: an id, a tier and an origin. */
function fakeWorker(): WatchWorker {
  return {
    definition: { id: "script-1", name: "Order entry" },
    handle: { tier: "unlocked", origin: { kind: "local" } },
  } as unknown as WatchWorker;
}

/** Bindings with a Controls-pane widget and no cells (the control half only). */
function boundToControl(): WatchBindings {
  return {
    seeds: {},
    cells: [],
    controls: [{ decl: { name: "region", widgetType: "dropdown" }, controlName: "Region" }],
    pinnedSheet: null,
    writeOnChange: [],
  } as unknown as WatchBindings;
}

describe("installFormLiveWatch — the Controls-pane subscription is disposed", () => {
  beforeEach(() => {
    controls.off.mockClear();
    controls.onControlValueChange.mockClear();
    controls.onControlValueChange.mockImplementation(() => controls.off);
  });

  it("a form closed BEFORE the import settles leaves no listener behind", async () => {
    const cleanup = installFormLiveWatch(fakeWorker(), "form-1", boundToControl());
    // The whole defect in one line: the form closes in the same turn it opened,
    // so this runs while `import("../controlValues")` is still in flight.
    cleanup();
    // The import still settles and still subscribes — there is no way to cancel
    // it — so the fix is that what it subscribed is torn down at once.
    await vi.waitFor(() => expect(controls.onControlValueChange).toHaveBeenCalledTimes(1));
    expect(controls.off).toHaveBeenCalledTimes(1);
  });

  it("a form that stays open keeps its subscription until IT closes", async () => {
    const cleanup = installFormLiveWatch(fakeWorker(), "form-2", boundToControl());
    await vi.waitFor(() => expect(controls.onControlValueChange).toHaveBeenCalledTimes(1));
    // Still open: the watch is exactly what the form needs it to be.
    expect(controls.off).not.toHaveBeenCalled();
    cleanup();
    expect(controls.off).toHaveBeenCalledTimes(1);
  });

  it("a form with no control-bound widget never subscribes at all", async () => {
    const bound = boundToControl();
    (bound as unknown as { controls: unknown[] }).controls = [];
    const cleanup = installFormLiveWatch(fakeWorker(), "form-3", bound);
    await Promise.resolve();
    await Promise.resolve();
    expect(controls.onControlValueChange).not.toHaveBeenCalled();
    cleanup();
    expect(controls.off).not.toHaveBeenCalled();
  });
});
