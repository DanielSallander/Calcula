import { describe, it, expect } from "vitest";
import { computeKpiStatus, kpiStatusColor } from "../kpiStatus";

const bands = [
  { threshold: 0, status: "OffTrack" },
  { threshold: 0.9, status: "AtRisk" },
  { threshold: 1.0, status: "OnTrack" },
];

describe("computeKpiStatus", () => {
  it("classifies by the base/target ratio across bands", () => {
    expect(computeKpiStatus(120, 100, bands)).toBe("OnTrack"); // ratio 1.2
    expect(computeKpiStatus(95, 100, bands)).toBe("AtRisk"); // ratio 0.95
    expect(computeKpiStatus(50, 100, bands)).toBe("OffTrack"); // ratio 0.5
    expect(computeKpiStatus(100, 100, bands)).toBe("OnTrack"); // ratio 1.0 (>= threshold)
  });

  it("defaults to the lowest band when the ratio is below all thresholds", () => {
    const b = [
      { threshold: 0.5, status: "AtRisk" },
      { threshold: 1.0, status: "OnTrack" },
    ];
    expect(computeKpiStatus(10, 100, b)).toBe("AtRisk"); // ratio 0.1 -> floor band
  });

  it("returns null when the status cannot be determined", () => {
    expect(computeKpiStatus(50, 100, [])).toBeNull(); // no bands
    expect(computeKpiStatus(50, 0, bands)).toBeNull(); // zero target
    expect(computeKpiStatus(50, null, bands)).toBeNull(); // no target
    expect(computeKpiStatus(NaN, 100, bands)).toBeNull(); // non-finite base
  });

  it("kpiStatusColor maps levels to distinct colours", () => {
    expect(kpiStatusColor("OnTrack")).not.toBe(kpiStatusColor("OffTrack"));
    expect(kpiStatusColor("AtRisk")).not.toBe(kpiStatusColor("OnTrack"));
  });
});
