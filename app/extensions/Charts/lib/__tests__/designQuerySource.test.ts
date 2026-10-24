//! FILENAME: app/extensions/Charts/lib/__tests__/designQuerySource.test.ts
// PURPOSE: The design-query source a Charts door writes over a chart's current
//          `data` (lib/designQuerySource.ts): the application connection's
//          stable key (`packageDataSourceId`) is KEPT while the connection is
//          unchanged, CLEARED -- with an explicit `undefined`, which the store's
//          deep merge needs -- when it changes, and never invented where there
//          was none (Rust stamps it at save, from the live connection).
// CONTEXT: Review findings no-writer-of-package-key (the dialog's full replace
//          stripped a Rust-stamped key) and stale-package-key-reverts-repoint
//          (the object pane's deep merge kept a stale one, which the remap
//          prefers).

import { describe, it, expect } from "vitest";
import { designQuerySourceFor } from "../designQuerySource";
import type { DesignQueryDataSource } from "../../types";

const DSL = "ROWS: Geo.Region\nVALUES: [Revenue]";
const KEYED: DesignQueryDataSource = { type: "designQuery", dslText: DSL, connectionId: "conn-1", packageDataSourceId: "ds-A" };

describe("designQuerySourceFor", () => {
  it("a new chart, or a range chart turned into a design query, gets no key at all", () => {
    expect(designQuerySourceFor(DSL, "conn-1", null)).toStrictEqual({ type: "designQuery", dslText: DSL, connectionId: "conn-1" });
    expect(designQuerySourceFor(DSL, "conn-1", undefined)).toStrictEqual({ type: "designQuery", dslText: DSL, connectionId: "conn-1" });
    const range = { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 4, endCol: 1 };
    expect(designQuerySourceFor(DSL, "conn-1", range)).toStrictEqual({ type: "designQuery", dslText: DSL, connectionId: "conn-1" });
    expect(designQuerySourceFor(DSL, "conn-1", "Sheet1!A1:B5")).toStrictEqual({ type: "designQuery", dslText: DSL, connectionId: "conn-1" });
  });

  it("a design-query chart on a local connection (no key) gets none", () => {
    const local: DesignQueryDataSource = { type: "designQuery", dslText: DSL, connectionId: "conn-1" };
    expect(designQuerySourceFor("VALUES: [Revenue]", "conn-2", local)).toStrictEqual({
      type: "designQuery",
      dslText: "VALUES: [Revenue]",
      connectionId: "conn-2",
    });
  });

  it("KEEPS the key while the connection is unchanged (a new query on the same connection)", () => {
    expect(designQuerySourceFor("VALUES: [Revenue]", "conn-1", KEYED)).toStrictEqual({
      type: "designQuery",
      dslText: "VALUES: [Revenue]",
      connectionId: "conn-1",
      packageDataSourceId: "ds-A",
    });
  });

  it("CLEARS the key when the connection changes -- an explicit undefined, so a deep merge drops it too", () => {
    const next = designQuerySourceFor(DSL, "conn-local", KEYED);
    expect(Object.prototype.hasOwnProperty.call(next, "packageDataSourceId")).toBe(true);
    expect(next.packageDataSourceId).toBeUndefined();
    // What is saved carries no key.
    expect(JSON.parse(JSON.stringify(next))).toStrictEqual({ type: "designQuery", dslText: DSL, connectionId: "conn-local" });
    // A deep merge of the patch over the stored source drops it (the store's
    // rule: a patch key's value replaces the stored one, undefined included).
    const merged = { ...KEYED, ...next };
    expect(merged.packageDataSourceId).toBeUndefined();
  });

  it("clears a malformed key (empty or not a string) even on the same connection", () => {
    const empty = designQuerySourceFor(DSL, "conn-1", { ...KEYED, packageDataSourceId: "" });
    expect(empty.packageDataSourceId).toBeUndefined();
    const notAString = designQuerySourceFor(DSL, "conn-1", { ...KEYED, packageDataSourceId: 7 as unknown as string });
    expect(notAString.packageDataSourceId).toBeUndefined();
  });
});
