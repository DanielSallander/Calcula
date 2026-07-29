// FILENAME: app/extensions/Distribution/components/inspector/ArtifactsSection.tsx
// PURPOSE: The "everything else" guarantee — every signed artifact in the
//          version, its checksum, an on-demand raw view (pretty JSON), and a
//          full per-artifact integrity audit.

import React, { useRef, useState } from "react";
import {
  inspectorArtifact,
  inspectorVerifyArtifacts,
  type InspectorArtifact,
  type InspectorOverview,
  type InspectorVerifyReport,
} from "@api/distribution";
import type { InspectorContext } from "./PackageInspectorApp";
import {
  Badge,
  ERR_RED,
  OK_GREEN,
  StatusLine,
  buttonStyle,
  cardHeaderStyle,
  cardStyle,
  formatBytes,
  mutedStyle,
  preStyle,
  sectionTitleStyle,
  tableStyle,
  tdStyle,
  thStyle,
} from "./shared";

export function ArtifactsSection({
  ctx,
  overview,
}: {
  ctx: InspectorContext;
  overview: InspectorOverview;
}): React.ReactElement {
  const [report, setReport] = useState<InspectorVerifyReport | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [viewing, setViewing] = useState<InspectorArtifact | null>(null);
  const [viewingPath, setViewingPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Staleness token: a late response (or late error) for a previously clicked
  // artifact must neither render under the new header nor close the new view.
  const viewSeq = useRef(0);

  const verifyAll = async () => {
    setVerifying(true);
    setError(null);
    try {
      setReport(
        await inspectorVerifyArtifacts(ctx.registryPath, ctx.packageName, ctx.version),
      );
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setVerifying(false);
    }
  };

  const view = async (path: string) => {
    const seq = ++viewSeq.current;
    setViewingPath(path);
    setViewing(null);
    setError(null);
    try {
      const artifact = await inspectorArtifact(
        ctx.registryPath,
        ctx.packageName,
        ctx.version,
        path,
      );
      if (viewSeq.current !== seq) return;
      setViewing(artifact);
    } catch (err: unknown) {
      if (viewSeq.current !== seq) return;
      setError(String(err));
      setViewingPath(null);
    }
  };

  const statusFor = (path: string): string | null => {
    if (!report) return null;
    return report.artifacts.find((a) => a.path === path)?.status ?? null;
  };

  return (
    <div>
      <h2 style={sectionTitleStyle}>Artifacts &amp; Integrity</h2>

      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <div style={{ ...cardHeaderStyle, marginBottom: 0 }}>
            Signed artifacts ({overview.artifacts.length})
          </div>
          <span style={{ flex: 1 }} />
          <button style={buttonStyle} disabled={verifying} onClick={() => void verifyAll()}>
            {verifying ? "Hashing…" : "Verify all checksums"}
          </button>
        </div>

        {report && (
          <div style={{ fontSize: 12, marginBottom: 8 }}>
            {report.allOk ? (
              <Badge color={OK_GREEN}>all artifacts match the signed manifest</Badge>
            ) : (
              <Badge color={ERR_RED}>integrity problems found</Badge>
            )}
            {report.unlisted.length > 0 && (
              <span style={{ color: ERR_RED }}>
                {" "}
                Unlisted files present: {report.unlisted.join(", ")}
              </span>
            )}
          </div>
        )}
        <StatusLine error={error} />

        <div style={{ overflow: "auto", maxHeight: 320 }}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Artifact</th>
                <th style={thStyle}>SHA-256</th>
                {report && <th style={thStyle}>Status</th>}
              </tr>
            </thead>
            <tbody>
              {overview.artifacts.map((a) => {
                const status = statusFor(a.path);
                return (
                  <tr key={a.path}>
                    <td style={tdStyle}>
                      <a
                        style={{ color: "#0f6cbd", cursor: "pointer", textDecoration: "underline" }}
                        onClick={() => void view(a.path)}
                      >
                        {a.path}
                      </a>
                    </td>
                    <td
                      style={{
                        ...tdStyle,
                        ...mutedStyle,
                        fontFamily: "Consolas, monospace",
                        fontSize: 10,
                      }}
                    >
                      {a.sha256.slice(0, 16)}…
                    </td>
                    {report && (
                      <td style={tdStyle}>
                        {status === "ok" ? (
                          <span style={{ color: OK_GREEN }}>ok</span>
                        ) : status ? (
                          <span style={{ color: ERR_RED }}>{status}</span>
                        ) : (
                          ""
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ ...mutedStyle, fontSize: 11, marginTop: 6 }}>
          Only artifacts listed in the signed manifest are readable; each view re-hashes
          the bytes against the published checksum.
        </div>
      </div>

      {viewingPath && (
        <div style={cardStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <div style={{ ...cardHeaderStyle, marginBottom: 0 }}>{viewingPath}</div>
            <span style={{ flex: 1 }} />
            <button
              style={buttonStyle}
              onClick={() => {
                viewSeq.current++;
                setViewing(null);
                setViewingPath(null);
              }}
            >
              Close
            </button>
          </div>
          {!viewing || viewing.path !== viewingPath ? (
            <StatusLine loading />
          ) : (
            <>
              <div style={{ fontSize: 12, marginBottom: 6 }}>
                {formatBytes(viewing.sizeBytes)} · {viewing.contentKind}{" "}
                {viewing.verified ? (
                  <Badge color={OK_GREEN}>checksum verified</Badge>
                ) : (
                  <Badge color={ERR_RED}>CHECKSUM MISMATCH</Badge>
                )}
                {viewing.truncated && <span style={mutedStyle}> (view truncated)</span>}
              </div>
              {viewing.text !== null ? (
                <pre style={{ ...preStyle, maxHeight: 520 }}>{viewing.text}</pre>
              ) : (
                <div style={{ ...mutedStyle, fontSize: 12 }}>
                  Binary artifact ({formatBytes(viewing.sizeBytes)}) — Arrow IPC data
                  snapshots are summarized under Data Model.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
