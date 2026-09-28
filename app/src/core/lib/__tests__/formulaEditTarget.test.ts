//! FILENAME: app/src/core/lib/__tests__/formulaEditTarget.test.ts
// PURPOSE: Tests for the external formula edit target seam -- the pick slot,
//          and (2026-09-27) the store, the two-view session predicates, the
//          explicit parked state, the selected-cell slot, the formula-bar read
//          path and the Name Box resolver slot that the same Core module owns.

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  registerExternalFormulaTarget,
  getExternalFormulaTarget,
  subscribeExternalEdit,
  getExternalEditVersion,
  notifyExternalEditChanged,
  getExternalEditSession,
  isExternalEditLive,
  isExternalSessionParked,
  getParkedViewSheetIndex,
  isCrossSheetPointMode,
  getCrossSheetPointModeKey,
  setExternalSessionParked,
  publishExternalCellTarget,
  getExternalCellTarget,
  resolveFormulaBarSource,
  getExternalNameBoxAddress,
  registerExternalAddressResolver,
  resolveExternalAddress,
  isFormulaBarElement,
  __resetExternalEditForTests,
  type ExternalAddressResolution,
  type ExternalFormulaTarget,
} from "../formulaEditTarget";
import { createFakeExternalEdit } from "./helpers/fakeExternalEdit";

// ============================================================================
// Helpers
// ============================================================================

const cleanups: (() => void)[] = [];

function makeTarget(expecting = true): ExternalFormulaTarget {
  return {
    isExpectingReference: () => expecting,
    insertReference: vi.fn(),
  };
}

afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups.length = 0;
});

// ============================================================================
// Tests
// ============================================================================

describe("registerExternalFormulaTarget", () => {
  it("defaults to no target registered", () => {
    expect(getExternalFormulaTarget()).toBeNull();
  });

  it("exposes the registered target and unregisters via the cleanup", () => {
    const target = makeTarget();
    const cleanup = registerExternalFormulaTarget(target);
    cleanups.push(cleanup);

    expect(getExternalFormulaTarget()).toBe(target);

    cleanup();
    expect(getExternalFormulaTarget()).toBeNull();
  });

  it("replaces an earlier registration (single slot, last-writer-wins)", () => {
    const first = makeTarget();
    const second = makeTarget();
    cleanups.push(registerExternalFormulaTarget(first));
    cleanups.push(registerExternalFormulaTarget(second));

    expect(getExternalFormulaTarget()).toBe(second);
  });

  it("identity-checks the cleanup: a stale cleanup cannot tear down a newer registration", () => {
    const first = makeTarget();
    const second = makeTarget();
    const staleCleanup = registerExternalFormulaTarget(first);
    cleanups.push(registerExternalFormulaTarget(second));

    staleCleanup();
    expect(getExternalFormulaTarget()).toBe(second);
  });

  it("cleanup is idempotent", () => {
    const target = makeTarget();
    const cleanup = registerExternalFormulaTarget(target);

    cleanup();
    cleanup();
    expect(getExternalFormulaTarget()).toBeNull();
  });
});

// ============================================================================
// The external-edit store, the session predicates, the cell and resolver slots
// ============================================================================

describe("the external-edit store", () => {
  afterEach(() => __resetExternalEditForTests());

  it("notifies on register, on unregister and on an explicit notify", () => {
    const heard = vi.fn();
    const off = subscribeExternalEdit(heard);
    const before = getExternalEditVersion();
    const fake = createFakeExternalEdit({ hostSheetIndex: 2 });
    const unregister = fake.register();
    expect(heard).toHaveBeenCalledTimes(1);
    unregister();
    expect(heard).toHaveBeenCalledTimes(2);
    notifyExternalEditChanged();
    expect(heard).toHaveBeenCalledTimes(3);
    expect(getExternalEditVersion()).toBe(before + 3);
    off();
  });

  it("a CHANGED cell publish notifies; an identical republish does not bump the version", () => {
    const fake = createFakeExternalEdit({ hostSheetIndex: 0, address: "Float1!A1", text: "=1" });
    fake.publishCell();
    const after = getExternalEditVersion();
    // The same data in a NEW object (handlers are always replaced): no notify.
    fake.publishCell();
    expect(getExternalEditVersion()).toBe(after);
    // A different content is a visible change...
    fake.publishCell({ content: "=2" });
    expect(getExternalEditVersion()).toBe(after + 1);
    // ...and so is a different address.
    fake.publishCell({ content: "=2", address: "Float1!A2" });
    expect(getExternalEditVersion()).toBe(after + 2);
  });
});

describe("the session predicates", () => {
  afterEach(() => __resetExternalEditForTests());

  it("a session-less (pick-only: the chart text editor) target is NOT a live external edit", () => {
    registerExternalFormulaTarget(makeTarget(true));
    expect(isExternalEditLive()).toBe(false);
    expect(getExternalEditSession()).toBeNull();
    expect(getCrossSheetPointModeKey()).toBeNull();
  });

  it("a registered session is live, and the session IS the pick slot's", () => {
    const fake = createFakeExternalEdit({ hostSheetIndex: 2 });
    fake.register();
    expect(isExternalEditLive()).toBe(true);
    expect(getExternalEditSession()).toBe(fake.session);
    expect(getExternalFormulaTarget()?.session).toBe(fake.session);
  });

  it("isCrossSheetPointMode: expecting + session, parked + NOT expecting; never expecting WITHOUT a session", () => {
    const expecting = createFakeExternalEdit({ hostSheetIndex: 2, text: "=" });
    const off = expecting.register();
    expect(isCrossSheetPointMode()).toBe(true);
    expect(getCrossSheetPointModeKey()).toBe("2:0:1");
    off();

    const plain = createFakeExternalEdit({ hostSheetIndex: 2, text: "=A1" });
    plain.register();
    expect(isCrossSheetPointMode()).toBe(false);
    setExternalSessionParked(0);
    expect(isCrossSheetPointMode()).toBe(true);
    expect(getCrossSheetPointModeKey()).toBe("2:1:0");
    __resetExternalEditForTests();

    // The chart text editor expects a reference but has no session: a tab
    // click is NOT point mode for it (it must not be dragged across sheets).
    registerExternalFormulaTarget(makeTarget(true));
    expect(isCrossSheetPointMode()).toBe(false);
  });

  it("setExternalSessionParked: a flip calls onParkedChanged once; the same value does not", () => {
    const fake = createFakeExternalEdit({ hostSheetIndex: 2, text: "=" });
    fake.register();
    setExternalSessionParked(0);
    expect(isExternalSessionParked()).toBe(true);
    expect(getParkedViewSheetIndex()).toBe(0);
    expect(fake.session.parkedFlips).toEqual([true]);
    const v = getExternalEditVersion();
    setExternalSessionParked(0);
    expect(fake.session.parkedFlips).toEqual([true]);
    expect(getExternalEditVersion()).toBe(v);
    // Another foreign sheet: the viewed index changes (a notify), no flip.
    setExternalSessionParked(1);
    expect(getParkedViewSheetIndex()).toBe(1);
    expect(getExternalEditVersion()).toBe(v + 1);
    expect(fake.session.parkedFlips).toEqual([true]);
    // Back on the host: un-parked, one flip.
    setExternalSessionParked(2);
    expect(isExternalSessionParked()).toBe(false);
    expect(getParkedViewSheetIndex()).toBeNull();
    expect(fake.session.parkedFlips).toEqual([true, false]);
  });

  it("parking without a live session parks nothing", () => {
    setExternalSessionParked(0);
    expect(isExternalSessionParked()).toBe(false);
    expect(getParkedViewSheetIndex()).toBeNull();
  });

  it("unregistering clears parked WITHOUT calling onParkedChanged (the session is gone)", () => {
    const fake = createFakeExternalEdit({ hostSheetIndex: 2, text: "=" });
    const off = fake.register();
    setExternalSessionParked(0);
    off();
    expect(isExternalSessionParked()).toBe(false);
    expect(fake.session.parkedFlips).toEqual([true]);
    // A NEW session registers un-parked, though nothing ever un-parked the old one.
    const next = createFakeExternalEdit({ hostSheetIndex: 3, text: "=" });
    next.register();
    expect(isExternalSessionParked()).toBe(false);
    expect(getParkedViewSheetIndex()).toBeNull();
  });
});

describe("the cell slot", () => {
  afterEach(() => __resetExternalEditForTests());

  it("last writer wins, and a STALE owner's withdraw cannot remove a newer publisher", () => {
    const a = createFakeExternalEdit({ hostSheetIndex: 0, address: "A!A1" });
    const b = createFakeExternalEdit({ hostSheetIndex: 0, address: "B!A1" });
    publishExternalCellTarget("A", a.cell());
    publishExternalCellTarget("B", b.cell());
    expect(getExternalCellTarget()?.address).toBe("B!A1");
    publishExternalCellTarget("A", null);
    expect(getExternalCellTarget()?.address).toBe("B!A1");
    publishExternalCellTarget("B", null);
    // No fallback to an older publication: a withdrawn WRITE target is gone.
    expect(getExternalCellTarget()).toBeNull();
  });
});

describe("resolveFormulaBarSource", () => {
  afterEach(() => __resetExternalEditForTests());

  it("session > cell > none, and the Name Box address follows the same order", () => {
    expect(resolveFormulaBarSource().kind).toBe("none");
    expect(getExternalNameBoxAddress()).toBeNull();

    const cellOwner = createFakeExternalEdit({ hostSheetIndex: 0, address: "Float1!B3" });
    cellOwner.publishCell();
    expect(resolveFormulaBarSource().kind).toBe("cell");
    expect(getExternalNameBoxAddress()).toBe("Float1!B3");

    const editOwner = createFakeExternalEdit({ hostSheetIndex: 0, address: "Float1!A1", text: "=" });
    editOwner.register();
    const source = resolveFormulaBarSource();
    expect(source.kind).toBe("session");
    expect(source.kind === "session" ? source.session : null).toBe(editOwner.session);
    expect(getExternalNameBoxAddress()).toBe("Float1!A1");
  });

  it("the cell's beginEdit registers the session in the pick slot (one session, two views)", () => {
    const fake = createFakeExternalEdit({ hostSheetIndex: 0, text: "=1" });
    fake.publishCell();
    const source = resolveFormulaBarSource();
    expect(source.kind).toBe("cell");
    const session = source.kind === "cell" ? source.cell.beginEdit() : null;
    expect(session).toBe(fake.session);
    expect(getExternalFormulaTarget()?.session).toBe(session);
    expect(resolveFormulaBarSource().kind).toBe("session");
  });
});

describe("the Name Box resolver slot", () => {
  afterEach(() => __resetExternalEditForTests());

  const resolution: ExternalAddressResolution = { hostSheetIndex: 1, go: async () => null };

  it("answers through the registered resolver, and a stale cleanup cannot remove a newer one", () => {
    expect(resolveExternalAddress("Float1!B2")).toBeNull();
    const first = registerExternalAddressResolver(() => resolution);
    const second = registerExternalAddressResolver((text) => (text === "Float1!B2" ? resolution : null));
    first();
    expect(resolveExternalAddress("Float1!B2")).toBe(resolution);
    expect(resolveExternalAddress("B2")).toBeNull();
    second();
    expect(resolveExternalAddress("Float1!B2")).toBeNull();
  });

  it("a resolver that throws is a decline, not a crash of the Name Box", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    registerExternalAddressResolver(() => {
      throw new Error("boom");
    });
    expect(resolveExternalAddress("Float1!B2")).toBeNull();
    err.mockRestore();
  });
});

describe("isFormulaBarElement", () => {
  it("recognises the bar by its attribute and nothing else", () => {
    const bar = document.createElement("input");
    bar.setAttribute("data-formula-bar", "true");
    expect(isFormulaBarElement(bar)).toBe(true);
    expect(isFormulaBarElement(document.createElement("input"))).toBe(false);
    expect(isFormulaBarElement(null)).toBe(false);
    expect(isFormulaBarElement({})).toBe(false);
  });
});
