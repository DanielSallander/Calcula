//! FILENAME: app/extensions/Charts/components/__tests__/ChartDesignQueryBuild.test.tsx
// PURPOSE: The design-query chart's build body (WP-C S9b), one instance behind
//          Fields AND Design: the Design tab commits its draft on Apply and
//          when focus LEAVES the editor (not when it moves inside it); a
//          refusal is shown and the draft is kept; the draft survives a switch
//          to Fields and back; the connection select commits the stored query
//          against the new connection.
// CONTEXT: The Monaco editor is replaced by a textarea (jsdom cannot host
//          Monaco); the ONE write (`commitDesignQuery`) is doubled so the test
//          is about what the body hands it, which designQueryCommit.test.ts
//          pins from the other side.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

const commitDesignQuery = vi.fn();
vi.mock("../../lib/designQueryCommit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/designQueryCommit")>()),
  commitDesignQuery: (...a: unknown[]) => commitDesignQuery(...a),
}));
vi.mock("../DesignQueryEditor", () => ({
  DesignQueryEditor: ({ value, onChange }: { value: string; onChange(v: string): void }) => (
    <textarea data-testid="dsl" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));
const invoke = vi.fn();
vi.mock("../../lib/chartsBackend", () => ({ chartsBackend: { invoke: (...a: unknown[]) => invoke(...a) } }));

import { ChartDesignQueryBuild } from "../pane/ChartDesignQueryBuild";
import type { ChartDefinition, ChartSpec } from "../../types";
import type { ObjectPaneTabContext } from "@api/objectPane";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MODEL = {
  tables: [{ name: "Geo", columns: [{ name: "Region", dataType: "string", isNumeric: false }] }],
  measures: [{ name: "Revenue", table: "Sales", sourceColumn: "amount", aggregation: "sum" }],
  connectionId: "conn-a",
};

let stored = "ROWS: Geo.Region\nVALUES: [Revenue]";
let connection = "conn-a";
function chart(): ChartDefinition {
  return {
    chartId: "c1",
    name: "Chart 1",
    sheetIndex: 0,
    x: 0,
    y: 0,
    width: 300,
    height: 200,
    spec: { mark: "bar", data: { type: "designQuery", dslText: stored, connectionId: connection } } as unknown as ChartSpec,
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function ctx(activeTabId: string, readOnly = false): ObjectPaneTabContext {
  return {
    region: { id: "chart-c1", type: "chart", startRow: 0, startCol: 0, endRow: 0, endCol: 0, data: { chartId: "c1" } },
    readOnly,
    readOnlyReason: readOnly ? "This page is subscribed." : null,
    activeTabId,
  };
}

async function show(activeTabId: string): Promise<void> {
  if (!host) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => {
    root!.render(<ChartDesignQueryBuild ctx={ctx(activeTabId)} chartId="c1" getChart={() => chart()} />);
  });
}

function q<T extends Element = HTMLElement>(sel: string): T | null {
  return host!.querySelector(sel) as T | null;
}

async function type(text: string): Promise<void> {
  const ta = q<HTMLTextAreaElement>("[data-testid='dsl']")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(ta, text);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  stored = "ROWS: Geo.Region\nVALUES: [Revenue]";
  connection = "conn-a";
  commitDesignQuery.mockReset();
  commitDesignQuery.mockResolvedValue({ status: "written" });
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "bi_get_connections") return [{ id: "conn-a", name: "Sales model" }, { id: "conn-b", name: "Other" }];
    if (cmd === "get_connection_bi_model") return MODEL;
    throw new Error(cmd);
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe("ChartDesignQueryBuild", () => {
  it("Apply commits the DRAFT against the chart's connection", async () => {
    await show("design");
    await type("ROWS: Geo.Region\nVALUES: [Revenue] [% of Row]");
    await act(async () => q<HTMLButtonElement>("[data-testid='chart-design-apply']")!.click());
    expect(commitDesignQuery).toHaveBeenCalledWith("c1", {
      dslText: "ROWS: Geo.Region\nVALUES: [Revenue] [% of Row]",
      connectionId: "conn-a",
    });
  });

  it("focus LEAVING the editor commits; a move INSIDE it does not", async () => {
    await show("design");
    await type("VALUES: [Revenue]");
    const box = q("[data-testid='chart-design-editor']")!;
    const ta = q<HTMLTextAreaElement>("[data-testid='dsl']")!;
    // Inside: the related target is in the editor box.
    await act(async () => {
      ta.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: box }));
    });
    expect(commitDesignQuery).not.toHaveBeenCalled();
    // Outside: the Apply button (or anything else in the pane).
    const outside = q<HTMLButtonElement>("[data-testid='chart-design-revert']")!;
    await act(async () => {
      ta.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: outside }));
    });
    expect(commitDesignQuery).toHaveBeenCalledTimes(1);
  });

  it("an unchanged draft commits nothing on blur", async () => {
    await show("design");
    const ta = q<HTMLTextAreaElement>("[data-testid='dsl']")!;
    await act(async () => {
      ta.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body }));
    });
    expect(commitDesignQuery).not.toHaveBeenCalled();
  });

  it("a refusal is shown and the draft is KEPT", async () => {
    commitDesignQuery.mockResolvedValue({ status: "refused", error: "Line 1: Unknown field: Geo.Nope" });
    await show("design");
    await type("ROWS: Geo.Nope");
    await act(async () => q<HTMLButtonElement>("[data-testid='chart-design-apply']")!.click());
    expect(q("[data-testid='chart-pane-error']")!.textContent).toBe("Line 1: Unknown field: Geo.Nope");
    expect(q<HTMLTextAreaElement>("[data-testid='dsl']")!.value).toBe("ROWS: Geo.Nope");
  });

  it("the draft survives a switch to Fields and back (one instance across the tabs)", async () => {
    await show("design");
    await type("VALUES: [Revenue]");
    await show("fields");
    expect(q("[data-testid='chart-fields-tab']")).toBeTruthy();
    await show("design");
    expect(q<HTMLTextAreaElement>("[data-testid='dsl']")!.value).toBe("VALUES: [Revenue]");
  });

  it("the connection select commits the STORED query against the new connection", async () => {
    await show("fields");
    const select = q<HTMLSelectElement>("[data-testid='chart-pane-connection']")!;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["conn-a", "conn-b"]);
    await act(async () => {
      select.value = "conn-b";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(commitDesignQuery).toHaveBeenCalledWith("c1", { dslText: stored, connectionId: "conn-b" });
  });
});
