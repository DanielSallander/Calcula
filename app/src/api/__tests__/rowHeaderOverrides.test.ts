//! FILENAME: app/src/api/__tests__/rowHeaderOverrides.test.ts
// PURPOSE: Unit tests for the structural bricks (granular bricks phase 3):
//          row-header override providers, row-gutter widgets + click routing,
//          and the multi-provider generalization of column header overrides.

import { describe, it, expect, vi } from "vitest";
import {
  registerRowHeaderOverrideProvider,
  hasRowHeaderOverrides,
  getRowHeaderOverride,
  registerRowGutterWidget,
  hasRowGutterWidgets,
  getRowGutterWidget,
  checkRowGutterClick,
} from "../rowHeaderOverrides";
import {
  registerColumnHeaderOverrideProvider,
  setColumnHeaderOverrideProvider,
  getColumnHeaderOverride,
  registerColumnHeaderClickInterceptor,
  checkColumnHeaderClickInterceptor,
} from "../columnHeaderOverrides";

describe("row header overrides", () => {
  it("first non-null override wins by priority", () => {
    expect(hasRowHeaderOverrides()).toBe(false);
    const c1 = registerRowHeaderOverrideProvider(
      (row) => (row === 1 ? { text: "low" } : null),
      10
    );
    const c2 = registerRowHeaderOverrideProvider(
      (row) => (row <= 1 ? { text: "high" } : null),
      1
    );
    try {
      expect(hasRowHeaderOverrides()).toBe(true);
      expect(getRowHeaderOverride(1)?.text).toBe("high");
      expect(getRowHeaderOverride(0)?.text).toBe("high");
      expect(getRowHeaderOverride(2)).toBeNull();
    } finally {
      c1();
      c2();
    }
    expect(hasRowHeaderOverrides()).toBe(false);
  });

  it("contains provider errors", () => {
    const c1 = registerRowHeaderOverrideProvider(() => {
      throw new Error("boom");
    }, 0);
    const c2 = registerRowHeaderOverrideProvider(() => ({ text: "ok" }), 1);
    try {
      expect(getRowHeaderOverride(0)?.text).toBe("ok");
    } finally {
      c1();
      c2();
    }
  });
});

describe("row gutter widgets", () => {
  it("first widget wins and clicks route to its registration", async () => {
    const onClick = vi.fn(async () => true);
    const cleanup = registerRowGutterWidget({
      id: "test",
      getWidget: (row) => (row === 3 ? { glyph: "dot" } : null),
      onClick,
    });
    try {
      expect(hasRowGutterWidgets()).toBe(true);
      expect(getRowGutterWidget(3)?.widget.glyph).toBe("dot");
      expect(getRowGutterWidget(4)).toBeNull();
      expect(await checkRowGutterClick(3)).toBe(true);
      expect(onClick).toHaveBeenCalledWith(3);
      expect(await checkRowGutterClick(4)).toBe(false);
    } finally {
      cleanup();
    }
    expect(hasRowGutterWidgets()).toBe(false);
  });

  it("widgets without onClick do not claim clicks", async () => {
    const cleanup = registerRowGutterWidget({
      id: "passive",
      getWidget: () => ({ glyph: "flag" }),
    });
    try {
      expect(await checkRowGutterClick(0)).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("column header overrides (multi-provider)", () => {
  it("multiple providers coexist; first non-null by priority wins", () => {
    const c1 = registerColumnHeaderOverrideProvider(
      (col) => (col === 0 ? { text: "table" } : null),
      5
    );
    const c2 = setColumnHeaderOverrideProvider((col) =>
      col <= 1 ? { text: "filter" } : null
    );
    try {
      // priority 5 (table) loses to default 0 (filter) on col 0
      expect(getColumnHeaderOverride(0, 0)?.text).toBe("filter");
      expect(getColumnHeaderOverride(1, 0)?.text).toBe("filter");
      expect(getColumnHeaderOverride(2, 0)).toBeNull();
    } finally {
      c1();
      c2();
    }
  });

  it("multiple click interceptors: first non-null result wins", () => {
    const c1 = registerColumnHeaderClickInterceptor(() => null);
    const c2 = registerColumnHeaderClickInterceptor((col) =>
      col === 2 ? { handled: true } : null
    );
    try {
      expect(checkColumnHeaderClickInterceptor(2, 0, 0, 0, 100, 24)?.handled).toBe(true);
      expect(checkColumnHeaderClickInterceptor(1, 0, 0, 0, 100, 24)).toBeNull();
    } finally {
      c1();
      c2();
    }
  });
});
