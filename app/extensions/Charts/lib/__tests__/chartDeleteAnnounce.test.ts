//! FILENAME: app/extensions/Charts/lib/__tests__/chartDeleteAnnounce.test.ts
// PURPOSE: Wave-B B7 -- `chart:deleted` is announced only for a delete the
//          backend accepted. It used to fire the moment the delete was asked
//          for, so a REFUSED delete (a sheet protecting its objects) told every
//          listener a chart was gone that the store then put back.

import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { announceWhenDeleteLands } from "../chartDeleteAnnounce";

describe("announceWhenDeleteLands", () => {
  it("announces once when the delete landed", async () => {
    const announce = vi.fn();
    await expect(announceWhenDeleteLands(Promise.resolve(null), announce)).resolves.toBeNull();
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it("announces nothing when the backend refused, and passes the reason on", async () => {
    const announce = vi.fn();
    const reason = "Cannot delete objects on a protected sheet.";
    await expect(announceWhenDeleteLands(Promise.resolve(reason), announce)).resolves.toBe(reason);
    expect(announce).not.toHaveBeenCalled();
  });

  it("does not announce before the backend answered", () => {
    const announce = vi.fn();
    void announceWhenDeleteLands(new Promise<string | null>(() => {}), announce);
    expect(announce).not.toHaveBeenCalled();
  });
});

describe("the chart delete emits CHART_DELETED only through the landed promise", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "../../index.ts"), "utf8").replace(/\r\n/g, "\n");
  const start = src.indexOf("function performChartDeleteLanded(");
  const body = src.slice(start, src.indexOf("\n}\n", start));

  it("never emits chart:deleted synchronously beside the request", () => {
    expect(start, "performChartDeleteLanded not found").toBeGreaterThan(-1);
    const wrapper = body.indexOf("announceWhenDeleteLands(");
    expect(wrapper, "the delete no longer waits for the backend before announcing").toBeGreaterThan(-1);
    // The one emit is the wrapper's callback: it sits between the wrapper and
    // the next statement, never as a statement of its own.
    const emits = [...body.matchAll(/emitAppEvent\(ChartEvents\.CHART_DELETED/g)].map((m) => m.index ?? -1);
    const next = body.indexOf("removeChartFromCache(", wrapper);
    expect(emits, "CHART_DELETED must be emitted exactly once").toHaveLength(1);
    expect(emits[0] > wrapper && emits[0] < next, "CHART_DELETED is emitted outside the landed callback").toBe(true);
  });
});
