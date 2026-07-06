//! FILENAME: app/src/api/__tests__/distributionBricks.test.ts
// PURPOSE: Unit tests for the distribution-extensibility bricks' frontend
//          registries: package kinds (brick 2), writeback validators (brick 3),
//          and distributable-object providers (brick 4).

import { describe, it, expect, vi } from "vitest";
import {
  registerPackageKind,
  listPackageKinds,
  getPackageKind,
} from "../packageKinds";
import {
  registerWritebackValidator,
  listWritebackValidators,
  runWritebackValidator,
} from "../writebackValidators";
import {
  registerDistributableObjectProvider,
  collectDistributableObjects,
  materializePulledObjects,
  distributableObjectKinds,
} from "../distributableObjects";

// ---------------------------------------------------------------------------
// Brick 2 — package kinds
// ---------------------------------------------------------------------------

describe("package kinds", () => {
  it("ships the three built-ins first", () => {
    expect(listPackageKinds().slice(0, 3).map((k) => k.id)).toEqual([
      "report",
      "template",
      "dataset",
    ]);
  });

  it("registers a custom kind and lists it after built-ins", () => {
    const cleanup = registerPackageKind({ id: "Budget-Model", label: "Budget Model" });
    try {
      // id is normalized to lowercase.
      expect(getPackageKind("budget-model")?.label).toBe("Budget Model");
      expect(listPackageKinds().some((k) => k.id === "budget-model")).toBe(true);
    } finally {
      cleanup();
    }
    expect(getPackageKind("budget-model")).toBeNull();
  });

  it("restores a built-in after overriding it", () => {
    const cleanup = registerPackageKind({ id: "report", label: "Custom Report" });
    expect(getPackageKind("report")?.label).toBe("Custom Report");
    cleanup();
    expect(getPackageKind("report")?.label).toBe("Report");
  });

  it("a stale cleanup does not clobber a later same-id registration (custom id)", () => {
    const cleanupA = registerPackageKind({ id: "shared", label: "A" });
    const cleanupB = registerPackageKind({ id: "shared", label: "B" }); // B is live
    // A deactivates out of nesting order — must NOT remove B's live entry.
    cleanupA();
    expect(getPackageKind("shared")?.label).toBe("B");
    cleanupB();
    expect(getPackageKind("shared")).toBeNull();
  });

  it("a stale cleanup does not revert a later override of a built-in", () => {
    const cleanupA = registerPackageKind({ id: "report", label: "Report A" });
    const cleanupB = registerPackageKind({ id: "report", label: "Report B" }); // B is live
    cleanupA(); // stale — must not restore the built-in under B
    expect(getPackageKind("report")?.label).toBe("Report B");
    cleanupB(); // now restore the built-in
    expect(getPackageKind("report")?.label).toBe("Report");
  });
});

// ---------------------------------------------------------------------------
// Brick 3 — writeback validators
// ---------------------------------------------------------------------------

describe("writeback validators", () => {
  it("runs a registered validator and returns its verdict", () => {
    const cleanup = registerWritebackValidator("positive", "Positive number", (v) =>
      Number(v) > 0 ? null : "must be positive"
    );
    try {
      expect(listWritebackValidators().some((v) => v.name === "positive")).toBe(true);
      expect(runWritebackValidator("positive", "5", { regionId: "r" })).toBeNull();
      expect(runWritebackValidator("positive", "-1", { regionId: "r" })).toBe("must be positive");
    } finally {
      cleanup();
    }
  });

  it("skips unknown/unregistered validators (never a hard failure)", () => {
    expect(runWritebackValidator("nope", "x", { regionId: "r" })).toBeNull();
    expect(runWritebackValidator(undefined, "x", { regionId: "r" })).toBeNull();
  });

  it("contains a throwing validator (returns null)", () => {
    const cleanup = registerWritebackValidator("boom", "Boom", () => {
      throw new Error("bad");
    });
    try {
      expect(runWritebackValidator("boom", "x", { regionId: "r" })).toBeNull();
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Brick 4 — distributable-object providers
// ---------------------------------------------------------------------------

describe("distributable-object providers", () => {
  it("collects objects from all providers, stamping the provider kind", async () => {
    const c1 = registerDistributableObjectProvider({
      kind: "acme.widget",
      collect: () => [{ kind: "ignored", id: "w1", payload: { a: 1 } }],
      materialize: () => {},
    });
    try {
      expect(distributableObjectKinds()).toContain("acme.widget");
      const collected = await collectDistributableObjects();
      const mine = collected.filter((o) => o.kind === "acme.widget");
      expect(mine).toHaveLength(1);
      // kind is forced to the provider's kind even if collect() returned another.
      expect(mine[0].kind).toBe("acme.widget");
      expect(mine[0].payload).toEqual({ a: 1 });
    } finally {
      c1();
    }
  });

  it("dispatches pulled objects to the matching provider by kind", async () => {
    const materialize = vi.fn();
    const cleanup = registerDistributableObjectProvider({
      kind: "acme.pivot",
      collect: () => [],
      materialize,
    });
    try {
      await materializePulledObjects([
        { kind: "acme.pivot", id: "p1", name: "P1", sheetIndex: 2, payload: { rows: [] } },
        { kind: "unknown.kind", id: "u1", name: "U1", payload: {} }, // no provider -> ignored
      ]);
      expect(materialize).toHaveBeenCalledTimes(1);
      expect(materialize).toHaveBeenCalledWith([
        expect.objectContaining({ kind: "acme.pivot", id: "p1", sheetIndex: 2 }),
      ]);
    } finally {
      cleanup();
    }
  });

  it("a collect() that throws is skipped, not fatal", async () => {
    const good = registerDistributableObjectProvider({
      kind: "acme.good",
      collect: () => [{ kind: "acme.good", id: "g", payload: {} }],
      materialize: () => {},
    });
    const bad = registerDistributableObjectProvider({
      kind: "acme.bad",
      collect: () => {
        throw new Error("collect failed");
      },
      materialize: () => {},
    });
    try {
      const collected = await collectDistributableObjects();
      expect(collected.some((o) => o.kind === "acme.good")).toBe(true);
      expect(collected.some((o) => o.kind === "acme.bad")).toBe(false);
    } finally {
      good();
      bad();
    }
  });
});
