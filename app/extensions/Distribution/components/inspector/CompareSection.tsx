// FILENAME: app/extensions/Distribution/components/inspector/CompareSection.tsx
// PURPOSE: Compare any two published versions of the inspected application.
// CONTEXT: The Inspector could already show what a version CONTAINS. What it
// could not answer was the question people actually ask about a version list —
// "what changed?" — because nothing in the codebase compared two versions at
// all. The workspace has kept every version since the beginning; this is the
// first view that reads more than one of them at a time.

import React, { useEffect, useMemo, useState } from "react";
import type { CellDiff, VersionDiff } from "@api";
import { diffSheetCells, diffVersions } from "@api";
import type { InspectorContext } from "./ApplicationInspectorApp";
import type { InspectorOverview } from "@api/distribution";
import { VersionDiffView } from "../VersionDiffView";

export function CompareSection({
  ctx,
  overview,
}: {
  ctx: InspectorContext;
  overview: InspectorOverview;
}) {
  // Newest first: the interesting comparison is almost always against the
  // current version, and it should be the one within reach.
  const versions = useMemo(
    () => [...overview.package.versions].reverse().map((v) => v.version),
    [overview.package.versions],
  );

  // Default to "the version being inspected, against the one before it" — the
  // question a version list provokes.
  const inspectedIndex = Math.max(0, versions.indexOf(overview.resolvedVersion));
  const [toVersion, setToVersion] = useState(versions[inspectedIndex] ?? "");
  const [fromVersion, setFromVersion] = useState(
    versions[inspectedIndex + 1] ?? versions[inspectedIndex] ?? "",
  );

  const [diff, setDiff] = useState<VersionDiff | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drilled, setDrilled] = useState<
    Record<string, { rows: CellDiff[]; total: number; truncated: boolean }>
  >({});

  const sameVersion = fromVersion === toVersion;

  useEffect(() => {
    if (!fromVersion || !toVersion || sameVersion) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    setBusy(true);
    setError(null);
    setDrilled({});
    diffVersions({
      registryPath: ctx.registryPath,
      packageName: ctx.packageName,
      fromVersion: `=${fromVersion}`,
      toVersion: `=${toVersion}`,
    })
      .then((d) => {
        if (!cancelled) setDiff(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ctx.registryPath, ctx.packageName, fromVersion, toVersion, sameVersion]);

  const handleDrillDown = async (sheetId: string) => {
    try {
      const full = await diffSheetCells({
        registryPath: ctx.registryPath,
        packageName: ctx.packageName,
        fromVersion: `=${fromVersion}`,
        toVersion: `=${toVersion}`,
        sheetId,
      });
      setDrilled((prev) => ({
        ...prev,
        [sheetId]: {
          rows: full.changes,
          total: full.totalChanges,
          truncated: full.truncated,
        },
      }));
    } catch (e: unknown) {
      setError(String(e));
    }
  };

  if (versions.length < 2) {
    return (
      <div style={{ color: "var(--text-secondary)" }}>
        This application has only one published version, so there is nothing to
        compare it against yet.
      </div>
    );
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "center",
          marginBottom: 12,
          flexWrap: "wrap",
        }}
      >
        <label>
          From{" "}
          <select value={fromVersion} onChange={(e) => setFromVersion(e.target.value)}>
            {versions.map((v) => (
              <option key={v} value={v}>
                v{v}
              </option>
            ))}
          </select>
        </label>
        <span>→</span>
        <label>
          To{" "}
          <select value={toVersion} onChange={(e) => setToVersion(e.target.value)}>
            {versions.map((v) => (
              <option key={v} value={v}>
                v{v}
              </option>
            ))}
          </select>
        </label>
        {busy && <span style={{ color: "var(--text-secondary)" }}>Comparing…</span>}
      </div>

      {sameVersion && (
        <div style={{ color: "var(--text-secondary)" }}>
          Pick two different versions to compare.
        </div>
      )}

      {error && (
        <div style={{ color: "var(--text-error, #d33)", marginBottom: 8 }}>{error}</div>
      )}

      {diff && (
        <VersionDiffView diff={diff} onDrillDown={handleDrillDown} drilledCells={drilled} />
      )}
    </div>
  );
}
