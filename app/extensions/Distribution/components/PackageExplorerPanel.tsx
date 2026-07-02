// FILENAME: app/extensions/Distribution/components/PackageExplorerPanel.tsx
// PURPOSE: Package Explorer — transparency pane for .calp connections.
// Subscriber view: which sheets/objects in this workbook are connected to each
// subscribed package (from the pull-time provenance ledger), with presence
// checks and click-to-navigate. Author view: a dry-run publish preview showing
// exactly what a publish would ship and what would stay behind.

import React, { useCallback, useEffect, useState } from "react";
import type { PanelSectionProps } from "@api/uiTypes";
import {
  getSubscriptions,
  getPackageObjects,
  publishPreview,
  setActiveSheetApi,
  onAppEvent,
  AppEvents,
} from "@api";
import type {
  PackageObjectsResponse,
  PublishReport,
  PublishPreviewResponse,
} from "@api";

const KIND_LABELS: Record<string, string> = {
  table: "Tables",
  pivot: "Pivots",
  chart: "Charts",
  namedRange: "Named ranges",
  objectScript: "Object scripts",
  moduleScript: "Module scripts",
  notebook: "Notebooks",
  dataSource: "Data sources",
  controlSheet: "Controls (per sheet)",
};

const KIND_ORDER = [
  "table",
  "pivot",
  "chart",
  "namedRange",
  "objectScript",
  "moduleScript",
  "notebook",
  "dataSource",
  "controlSheet",
];

const sectionStyle: React.CSSProperties = {
  padding: "8px",
  fontSize: "12px",
  overflowY: "auto",
};
const pkgHeaderStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: "13px",
  margin: "6px 0 2px 0",
};
const groupLabelStyle: React.CSSProperties = {
  fontWeight: 600,
  opacity: 0.75,
  margin: "6px 0 2px 0",
};
const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
  padding: "1px 0 1px 8px",
};
const mutedStyle: React.CSSProperties = { opacity: 0.65 };

// ============================================================================
// Subscriber view: Connected Objects
// ============================================================================

export function ConnectedObjectsSection(_props: PanelSectionProps): React.ReactElement {
  const [packages, setPackages] = useState<PackageObjectsResponse[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const subs = await getSubscriptions();
      // Per-package isolation: one failed resolution (e.g. a subscription
      // detached mid-flight) must not blank the healthy packages.
      const settled = await Promise.allSettled(
        subs.subscriptions.map((s) => getPackageObjects(s.packageName)),
      );
      setPackages(
        settled
          .filter(
            (r): r is PromiseFulfilledResult<PackageObjectsResponse> =>
              r.status === "fulfilled",
          )
          .map((r) => r.value),
      );
      const failed = settled.find((r) => r.status === "rejected");
      setError(failed ? String((failed as PromiseRejectedResult).reason) : null);
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const offs = [
      onAppEvent(AppEvents.SHEET_CHANGED, () => void refresh()),
      onAppEvent("calp:scripts-pulled", () => void refresh()),
    ];
    return () => offs.forEach((off) => off());
  }, [refresh]);

  if (error && packages.length === 0) {
    return <div style={{ ...sectionStyle, color: "#c0392b" }}>{error}</div>;
  }
  if (loaded && packages.length === 0) {
    return (
      <div style={{ ...sectionStyle, ...mutedStyle }}>
        No package subscriptions in this workbook. Subscribe to a .calp package
        via External Data &gt; Distribution to see its connected objects here.
      </div>
    );
  }

  return (
    <div style={sectionStyle}>
      {error && (
        <div style={{ color: "#c0392b", marginBottom: "6px" }}>{error}</div>
      )}
      {packages.map((pkg) => (
        <div key={pkg.packageName} style={{ marginBottom: "10px" }}>
          <div style={pkgHeaderStyle}>
            {pkg.packageName}{" "}
            <span style={{ ...mutedStyle, fontWeight: 400 }}>v{pkg.resolvedVersion}</span>
          </div>

          <div style={groupLabelStyle}>Sheets</div>
          {pkg.sheets.map((s, i) => (
            <div key={`${s.localName}-${i}`} style={rowStyle}>
              <span>{s.localSheetIndex !== null ? "●" : "○"}</span>
              {s.localSheetIndex !== null ? (
                <a
                  style={{ cursor: "pointer", textDecoration: "underline" }}
                  onClick={() => void setActiveSheetApi(s.localSheetIndex as number)}
                >
                  {s.localName}
                </a>
              ) : (
                <span style={mutedStyle}>{s.localName} (removed)</span>
              )}
            </div>
          ))}

          {KIND_ORDER.map((kind) => {
            const items = pkg.objects.filter((o) => o.kind === kind);
            if (items.length === 0) return null;
            return (
              <div key={kind}>
                <div style={groupLabelStyle}>{KIND_LABELS[kind] ?? kind}</div>
                {items.map((o) => (
                  <div key={`${o.kind}-${o.id}`} style={rowStyle} title={o.id}>
                    <span>{o.present ? "●" : "○"}</span>
                    <span style={o.present ? undefined : mutedStyle}>
                      {o.name || o.id}
                      {o.sheetName ? (
                        <span style={mutedStyle}> — {o.sheetName}</span>
                      ) : null}
                      {!o.present ? <span style={mutedStyle}> (removed)</span> : null}
                    </span>
                  </div>
                ))}
              </div>
            );
          })}

          {pkg.objects.length === 0 && (
            <div style={{ ...rowStyle, ...mutedStyle }}>
              No object ledger recorded (subscribed before object tracking —
              refresh the subscription to populate it).
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// Shared publish-report rendering (also used by PublishDialog)
// ============================================================================

export function PublishReportView({ report }: { report: PublishReport }): React.ReactElement {
  return (
    <div>
      <div style={{ ...groupLabelStyle, color: "#1e7e34" }}>Will publish</div>
      {report.included.length === 0 && (
        <div style={{ ...rowStyle, ...mutedStyle }}>Nothing detected.</div>
      )}
      {report.included.map((item) => (
        <div key={`inc-${item.category}`} style={rowStyle} title={item.detail}>
          <span style={{ color: "#1e7e34" }}>{"✓"}</span>
          <span>
            {item.count} {item.category}
            <span style={mutedStyle}> — {item.detail}</span>
          </span>
        </div>
      ))}

      <div style={{ ...groupLabelStyle, color: "#b8860b" }}>Stays behind</div>
      {report.excluded.length === 0 ? (
        <div style={{ ...rowStyle, ...mutedStyle }}>
          Nothing in this workbook is left out.
        </div>
      ) : (
        report.excluded.map((item) => (
          <div key={`exc-${item.category}`} style={rowStyle} title={item.detail}>
            <span style={{ color: "#b8860b" }}>{"⚠"}</span>
            <span>
              {item.count} {item.category}
              <span style={mutedStyle}> — {item.detail}</span>
            </span>
          </div>
        ))
      )}

      <div style={{ ...rowStyle, ...mutedStyle, marginTop: "6px" }}>
        By policy, credentials, the audit log, subscriber-local files and pivot
        output cells never leave this machine (pivots are recalculated by
        subscribers).
      </div>
    </div>
  );
}

// ============================================================================
// Author view: Publish Preview
// ============================================================================

export function PublishPreviewSection(_props: PanelSectionProps): React.ReactElement {
  const [preview, setPreview] = useState<PublishPreviewResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runPreview = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // No sheet filter: preview publishing the whole workbook.
      setPreview(await publishPreview());
    } catch (err: unknown) {
      setError(String(err));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div style={sectionStyle}>
      <div style={{ ...mutedStyle, marginBottom: "6px" }}>
        Dry-run of publishing every sheet: exactly what a .calp package would
        carry, and what would stay behind. Nothing is written.
      </div>
      <button onClick={() => void runPreview()} disabled={busy}>
        {busy ? "Analyzing…" : "Preview publish"}
      </button>
      {error && <div style={{ color: "#c0392b", marginTop: "6px" }}>{error}</div>}
      {preview && (
        <div style={{ marginTop: "8px" }}>
          <div style={mutedStyle}>
            Sheets: {preview.sheetNames.join(", ") || "(none)"}
          </div>
          <PublishReportView report={preview.report} />
        </div>
      )}
    </div>
  );
}
