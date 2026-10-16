//! FILENAME: app/src/api/__tests__/pageFilters.test.ts
// PURPOSE: The page-filter seam (@api/pageFilters, CONTRACT-CANVAS §4.8):
//          a publisher REPLACES its list; readers get one page of one model;
//          the change event names exactly the (page, model) pairs that moved
//          and stays SILENT when a republish changed nothing.
// CONTEXT: The Slicer store announces once per item refresh -- N times per
//          re-read -- and the publisher republishes on every one. If the seam
//          announced each of those, every design-query chart on the page would
//          re-query its model N times on a plain sheet switch. The silence is
//          the property worth pinning; the routing (page AND connection) is
//          the other: a slicer on Sheet 1 must never re-run a chart on Sheet 2.

import { describe, it, expect, afterEach } from "vitest";
import {
  getPageFilters,
  listPageFilterPages,
  onPageFiltersChange,
  publishPageFilters,
  type PageFilterInput,
  type PageFiltersChange,
} from "../pageFilters";

const PUBLISHERS = ["slicer", "timeline"];
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  for (const p of PUBLISHERS) publishPageFilters(p, []);
});

function listen(): PageFiltersChange[] {
  const seen: PageFiltersChange[] = [];
  cleanups.push(onPageFiltersChange((c) => seen.push(c)));
  return seen;
}

function filter(over: Partial<PageFilterInput> = {}): PageFilterInput {
  return {
    sourceId: "s-1",
    sourceName: "Slicer_Region",
    sheetIndex: 1,
    connectionId: "conn-a",
    field: "Geo.Region",
    includedItems: ["East"],
    ...over,
  };
}

describe("@api/pageFilters", () => {
  it("returns a page's filters for one model connection only", () => {
    publishPageFilters("slicer", [
      filter(),
      filter({ sourceId: "s-2", connectionId: "conn-b", field: "Geo.Region" }),
      filter({ sourceId: "s-3", sheetIndex: 2 }),
    ]);

    const page1a = getPageFilters(1, "conn-a");
    expect(page1a.map((f) => f.sourceId)).toEqual(["s-1"]);
    expect(page1a[0]).toMatchObject({ publisher: "slicer", field: "Geo.Region", includedItems: ["East"], filterLevel: 1 });
    expect(getPageFilters(1).map((f) => f.sourceId)).toEqual(["s-1", "s-2"]);
    expect(getPageFilters(2, "conn-a").map((f) => f.sourceId)).toEqual(["s-3"]);
    expect(getPageFilters(3, "conn-a")).toEqual([]);
  });

  it("names exactly the (page, model) pairs whose filters changed", () => {
    publishPageFilters("slicer", [filter(), filter({ sourceId: "s-3", sheetIndex: 2 })]);
    const seen = listen();

    publishPageFilters("slicer", [filter({ includedItems: ["West"] }), filter({ sourceId: "s-3", sheetIndex: 2 })]);

    expect(seen).toEqual([{ pages: [{ sheetIndex: 1, connectionId: "conn-a" }] }]);
  });

  it("is silent when a republish changed nothing, whatever the order of filters or items", () => {
    publishPageFilters("slicer", [
      filter({ includedItems: ["East", "West"] }),
      filter({ sourceId: "s-2", field: "Time.Year", includedItems: ["2024"] }),
    ]);
    const seen = listen();

    publishPageFilters("slicer", [
      filter({ sourceId: "s-2", field: "Time.Year", includedItems: ["2024"] }),
      filter({ includedItems: ["West", "East"] }),
    ]);

    expect(seen).toEqual([]);
  });

  it("announces a CLEAR (the publisher withdrew its filter) for the page it left", () => {
    publishPageFilters("slicer", [filter()]);
    const seen = listen();

    publishPageFilters("slicer", []);

    expect(seen).toEqual([{ pages: [{ sheetIndex: 1, connectionId: "conn-a" }] }]);
    expect(getPageFilters(1, "conn-a")).toEqual([]);
  });

  it("keeps each publisher's filters: one publisher's republish never drops another's", () => {
    publishPageFilters("slicer", [filter()]);
    publishPageFilters("timeline", [filter({ sourceId: "t-1", field: "Time.Date", includedItems: ["2024-01-01"] })]);

    publishPageFilters("slicer", []);

    expect(getPageFilters(1, "conn-a").map((f) => `${f.publisher}:${f.sourceId}`)).toEqual(["timeline:t-1"]);
  });

  it("an EMPTY kept list is a filter (nothing passes), not the absence of one", () => {
    const seen = listen();
    publishPageFilters("slicer", [filter({ includedItems: [] })]);

    expect(getPageFilters(1, "conn-a")).toHaveLength(1);
    expect(getPageFilters(1, "conn-a")[0].includedItems).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  it("holds a copy: a publisher mutating its array afterwards changes nothing", () => {
    const items = ["East"];
    publishPageFilters("slicer", [filter({ includedItems: items })]);
    items.push("West");

    expect(getPageFilters(1, "conn-a")[0].includedItems).toEqual(["East"]);
  });

  it("drops a filter with no page, no model or no field rather than holding a filter nothing can match", () => {
    publishPageFilters("slicer", [
      filter({ sheetIndex: -1 }),
      filter({ sourceId: "s-2", connectionId: "" }),
      filter({ sourceId: "s-3", field: "" }),
    ]);

    expect(getPageFilters(1)).toEqual([]);
  });

  it("a throwing listener does not keep the next one stale; unsubscribe stops delivery", () => {
    cleanups.push(onPageFiltersChange(() => {
      throw new Error("boom");
    }));
    const seen: PageFiltersChange[] = [];
    const off = onPageFiltersChange((c) => seen.push(c));

    publishPageFilters("slicer", [filter()]);
    off();
    publishPageFilters("slicer", []);

    expect(seen).toHaveLength(1);
  });

  it("lists every (page, model) holding a filter, once each, page then connection", () => {
    expect(listPageFilterPages()).toEqual([]);
    publishPageFilters("slicer", [
      filter({ sheetIndex: 4, connectionId: "conn-b" }),
      filter({ sourceId: "s-2", sheetIndex: 1, connectionId: "conn-b" }),
      filter({ sourceId: "s-3", sheetIndex: 1, connectionId: "conn-a", field: "Geo.Country" }),
    ]);
    publishPageFilters("timeline", [filter({ sourceId: "t-1", sheetIndex: 1, connectionId: "conn-a" })]);
    expect(listPageFilterPages()).toEqual([
      { sheetIndex: 1, connectionId: "conn-a" },
      { sheetIndex: 1, connectionId: "conn-b" },
      { sheetIndex: 4, connectionId: "conn-b" },
    ]);
    publishPageFilters("slicer", []);
    expect(listPageFilterPages()).toEqual([{ sheetIndex: 1, connectionId: "conn-a" }]);
  });
});
