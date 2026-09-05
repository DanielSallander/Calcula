// FILENAME: app/extensions/Distribution/components/inspector/CompareSection.tsx
// PURPOSE: Compare any two published versions of the inspected application.
// CONTEXT: The Inspector could already show what a version CONTAINS. What it
// could not answer was the question people actually ask about a version list —
// "what changed?" — because nothing in the codebase compared two versions at
// all. The workspace has kept every version since the beginning; this is the
// first view that reads more than one of them at a time.

import React, { useEffect, useMemo, useState } from "react";
import { listEnvironments, type EnvironmentPointer } from "@api/distribution";
import { versionLabel } from "../../lib/environments";
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

  /**
   * The pipeline, for labelling and for the default From.
   *
   * "What changed since the last release" is the comparison an inspector is
   * opened for far more often than "what changed between two adjacent
   * versions", and only the pipeline knows which version that was. Best-effort:
   * an application without environments, or a log that does not verify, simply
   * leaves the labels bare rather than failing a comparison that does not
   * depend on it.
   */
  const [envs, setEnvs] = useState<EnvironmentPointer[]>([]);
  useEffect(() => {
    let cancelled = false;
    listEnvironments({ registryPath: ctx.registryPath, packageName: ctx.packageName })
      .then((r) => {
        if (cancelled) return;
        setEnvs(r.environments);
        // Default From to what the LAST environment is running — the version
        // the audience actually has — when it is one of the versions listed.
        const last = r.environments[r.environments.length - 1]?.version;
        if (last && last !== overview.resolvedVersion && versions.includes(last)) {
          setFromVersion(last);
        }
      })
      .catch(() => {
        if (!cancelled) setEnvs([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.registryPath, ctx.packageName]);

  const head = versions[0] ?? "";

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
                {versionLabel(v, envs, head)}
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
                {versionLabel(v, envs, head)}
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
