// FILENAME: app/extensions/ModelEditor/components/diagram/__tests__/nodeGeometry.test.ts
// PURPOSE: Node sizing for the relationship diagram — nodes must widen so long
//          column / header names are shown in full (the reported clipping bug),
//          clamped to a sane range, and label truncation must be consistent with
//          the width estimate.

import { describe, expect, it } from "vitest";
import type { ModelColumnInfo, ModelTableInfo } from "@api";
import {
  columnLabel,
  fitLabel,
  getNodeWidth,
  headerLabel,
  MAX_NODE_WIDTH,
  MIN_NODE_WIDTH,
} from "../nodeGeometry";

function col(name: string, dataType = "Int32"): ModelColumnInfo {
  return {
    name,
    dataType,
    displayName: null,
    description: null,
    isHidden: false,
    isCalculated: false,
    formula: null,
    lookupResolution: null,
    sortByColumn: null,
    formatString: null,
  };
}

function table(name: string, cols: ModelColumnInfo[]): ModelTableInfo {
  return {
    name,
    displayName: null,
    description: null,
    isHidden: false,
    storageMode: "InMemory",
    bound: true,
    columns: cols,
    refreshStrategies: [],
    incrementalRefresh: null,
  };
}

describe("getNodeWidth", () => {
  it("uses the minimum width for short names", () => {
    const t = table("Sales", [col("id"), col("qty")]);
    expect(getNodeWidth(t)).toBe(MIN_NODE_WIDTH);
  });

  it("widens to fit a long column name", () => {
    const short = table("BI.fact", [col("purchaseorderid")]);
    const long = table("BI.fact", [col("purchaseorderdetailidentifierlong")]);
    expect(getNodeWidth(long)).toBeGreaterThan(getNodeWidth(short));
  });

  it("widens to fit a long table (header) name", () => {
    const t = table("BI.fact_purchasing_order_detail_extended_name", [col("id")]);
    expect(getNodeWidth(t)).toBeGreaterThan(MIN_NODE_WIDTH);
  });

  it("never exceeds the maximum width", () => {
    const t = table("x".repeat(500), [col("y".repeat(500))]);
    expect(getNodeWidth(t)).toBeLessThanOrEqual(MAX_NODE_WIDTH);
    expect(getNodeWidth(t)).toBe(MAX_NODE_WIDTH);
  });
});

describe("labels", () => {
  it("shows a column name in full once the node is sized to fit it", () => {
    const name = "purchaseorderdetailid";
    const t = table("BI.fact", [col(name)]);
    // getNodeWidth sized the node to fit → the label is NOT truncated.
    expect(columnLabel(col(name), getNodeWidth(t))).toBe(name);
  });

  it("shows the header name in full once the node is sized to fit it", () => {
    const t = table("BI.fact_purchasing", [col("id")]);
    expect(headerLabel(t, getNodeWidth(t))).toBe("BI.fact_purchasing");
  });

  it("truncates with an ellipsis when the available width is too small", () => {
    const out = fitLabel("verylongcolumnname", 11, 30);
    expect(out.endsWith("..")).toBe(true);
    expect(out.length).toBeLessThan("verylongcolumnname".length);
  });
});
