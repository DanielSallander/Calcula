//! FILENAME: app/extensions/BusinessIntelligence/lib/kpiStatus.ts
// PURPOSE: Host-side KPI status computation + colour. The engine carries KPI
//          definitions but does not compute status (v1); the host derives the
//          status level from a base-measure value vs the target across the
//          author's status bands, and renders an indicator.
// CONTEXT: Pure + unit-tested. Used by the BI pane (and, later, pivot cells).

import type { BiStatusBand } from "@api/backend";

export type KpiStatusLevel = "OffTrack" | "AtRisk" | "OnTrack";

/**
 * Compute a KPI's status for a base value against a resolved target.
 *
 * `target` is the goal already resolved to a number (a constant, or the row's
 * value of the target measure). Bands map the base/target *ratio*: the status is
 * the highest band whose `threshold <= ratio`, defaulting to the lowest band (the
 * floor tier) when the ratio is below all thresholds. Returns `null` when status
 * can't be determined (no bands, or a missing/zero/non-finite target/base).
 */
export function computeKpiStatus(
  base: number,
  target: number | null | undefined,
  statusBands: BiStatusBand[],
): KpiStatusLevel | null {
  if (!statusBands.length) return null;
  if (target == null || !Number.isFinite(target) || target === 0) return null;
  if (!Number.isFinite(base)) return null;

  const ratio = base / target;
  const sorted = [...statusBands].sort((a, b) => a.threshold - b.threshold);
  let status = sorted[0].status;
  for (const band of sorted) {
    if (ratio >= band.threshold) status = band.status;
  }
  return status as KpiStatusLevel;
}

/** A colour for a KPI status level (traffic-light convention). */
export function kpiStatusColor(status: KpiStatusLevel): string {
  switch (status) {
    case "OnTrack":
      return "#2E7D32"; // green
    case "AtRisk":
      return "#ED6C02"; // amber
    case "OffTrack":
    default:
      return "#C62828"; // red
  }
}
