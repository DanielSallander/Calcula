// FILENAME: app/extensions/Distribution/components/inspector/WritebackSection.tsx
// PURPOSE: Writeback governance disclosure — the declared input regions /
//          model columns with their full policy set, plus post-publish
//          response activity. Value-level detail only when this machine holds
//          the publisher signing key; everyone else sees aggregates.

import React, { useEffect, useState } from "react";
import {
  inspectorWriteback,
  type InspectorOverview,
  type InspectorWriteback,
} from "@api/distribution";
import type { InspectorContext } from "./PackageInspectorApp";
import {
  Badge,
  OK_GREEN,
  StatusLine,
  cardHeaderStyle,
  cardStyle,
  mutedStyle,
  sectionTitleStyle,
  tableStyle,
  tdStyle,
  thStyle,
} from "./shared";

export function WritebackSection({
  ctx,
  overview,
}: {
  ctx: InspectorContext;
  overview: InspectorOverview;
}): React.ReactElement {
  const [data, setData] = useState<InspectorWriteback | null>(null);
  const [error, setError] = useState<string | null>(null);

  const declared = overview.writebackRegionCount + overview.modelWritebackCount > 0;

  useEffect(() => {
    inspectorWriteback(ctx.registryPath, ctx.packageName, ctx.version)
      .then(setData)
      .catch((err) => setError(String(err)));
  }, [ctx]);

  if (!declared) {
    return (
      <div>
        <h2 style={sectionTitleStyle}>Writeback</h2>
        <StatusLine
          empty
          emptyText="This package declares no writeback regions or model writeback columns."
        />
      </div>
    );
  }

  return (
    <div>
      <h2 style={sectionTitleStyle}>Writeback</h2>
      <StatusLine error={error} loading={!data && !error} />
      {data && (
        <>
          {data.regions.length > 0 && (
            <div style={cardStyle}>
              <div style={cardHeaderStyle}>Grid input regions ({data.regions.length})</div>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>Sheet / range</th>
                    <th style={thStyle}>Type</th>
                    <th style={thStyle}>Mode</th>
                    <th style={thStyle}>Visibility</th>
                    <th style={thStyle}>Submission</th>
                    <th style={thStyle}>Versioning</th>
                    <th style={thStyle}>Re-edit</th>
                    <th style={thStyle}>Expected</th>
                  </tr>
                </thead>
                <tbody>
                  {data.regions.map((r) => (
                    <tr key={r.id} title={r.id}>
                      <td style={tdStyle}>
                        {r.sheetName} {r.range}
                      </td>
                      <td style={tdStyle}>{r.valueType ?? "any"}</td>
                      <td style={tdStyle}>{r.mode ?? ""}</td>
                      <td style={tdStyle}>{r.visibility ?? ""}</td>
                      <td style={tdStyle}>{r.submissionPolicy ?? ""}</td>
                      <td style={tdStyle}>{r.versionBinding ?? ""}</td>
                      <td style={tdStyle}>{r.lifecycle ?? ""}</td>
                      <td style={tdStyle}>
                        {r.expectedRespondents.length > 0
                          ? r.expectedRespondents.join(", ")
                          : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data.modelWritebacks.length > 0 && (
            <div style={cardStyle}>
              <div style={cardHeaderStyle}>
                Model writeback columns ({data.modelWritebacks.length})
              </div>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>Table.Column</th>
                    <th style={thStyle}>Kind</th>
                    <th style={thStyle}>Type</th>
                    <th style={thStyle}>Keys</th>
                    <th style={thStyle}>Editors</th>
                  </tr>
                </thead>
                <tbody>
                  {data.modelWritebacks.map((m) => (
                    <tr key={m.id} title={m.id}>
                      <td style={tdStyle}>
                        {m.table}.{m.column}
                      </td>
                      <td style={tdStyle}>{m.kind || "history"}</td>
                      <td style={tdStyle}>{m.valueType ?? "any"}</td>
                      <td style={tdStyle}>{m.keyColumns.join(", ")}</td>
                      <td style={tdStyle}>
                        {m.allowedEditors.length > 0 ? m.allowedEditors.join(", ") : "anyone"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={cardStyle}>
            <div style={cardHeaderStyle}>
              Responses collected so far{" "}
              {data.isPublisher && <Badge color={OK_GREEN}>publisher view</Badge>}
            </div>
            {!data.isPublisher ? (
              <div style={{ ...mutedStyle, fontSize: 12 }}>
                Response activity — including counts — is visible only to the publisher
                (signing-key holder): the regions&apos; visibility policies promise
                subscribers see nothing of each other&apos;s contributions.
              </div>
            ) : (
              <>
                <div style={{ fontSize: 12, marginBottom: 6 }}>
                  {data.totalSubmissions} submissions · {data.reviewEventCount} review decisions
                </div>
                {data.regionStats.length > 0 && (
                  <table style={tableStyle}>
                    <thead>
                      <tr>
                        <th style={thStyle}>Region</th>
                        <th style={thStyle}>Submissions</th>
                        <th style={thStyle}>Submitters</th>
                        <th style={thStyle}>Approved</th>
                        <th style={thStyle}>Rejected</th>
                        <th style={thStyle}>Pending</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.regionStats.map((s) => (
                        <tr key={s.regionId}>
                          <td style={{ ...tdStyle, fontSize: 11 }}>{s.regionId}</td>
                          <td style={tdStyle}>{s.submissionCount}</td>
                          <td style={tdStyle}>{s.submitterCount}</td>
                          <td style={tdStyle}>{s.approved}</td>
                          <td style={tdStyle}>{s.rejected}</td>
                          <td style={tdStyle}>{s.pending}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {data.rollupPresent && (
                  <div style={{ fontSize: 12, marginTop: 6 }}>
                    Parquet rollup present at submissions/_rollup.parquet
                    {data.rollupSizeBytes !== null
                      ? ` (${data.rollupSizeBytes} bytes)`
                      : ""}{" "}
                    <span style={mutedStyle}>
                      — a publisher-refreshed derived file for database access.
                    </span>
                  </div>
                )}
              </>
            )}
            <div style={{ ...mutedStyle, fontSize: 11, marginTop: 6 }}>
              Responses arrive after publish and live outside the publisher&apos;s signature
              (a separate, append-only trust domain).
            </div>
          </div>

          {data.isPublisher && data.submissions.length > 0 && (
            <div style={cardStyle}>
              <div style={cardHeaderStyle}>Individual submissions ({data.submissions.length})</div>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>Submitter</th>
                    <th style={thStyle}>Where</th>
                    <th style={thStyle}>Value</th>
                    <th style={thStyle}>State</th>
                    <th style={thStyle}>Review</th>
                    <th style={thStyle}>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {data.submissions.map((s, i) => (
                    <tr key={i}>
                      <td style={tdStyle}>{s.submitterName}</td>
                      <td style={tdStyle}>
                        {s.modelKey
                          ? `key [${s.modelKey.join(", ")}]`
                          : `r${s.cellRow + 1} c${s.cellCol + 1}`}
                      </td>
                      <td style={tdStyle}>{s.valueDisplay}</td>
                      <td style={tdStyle}>{s.state}</td>
                      <td style={tdStyle}>
                        {s.reviewReason ?? ""}
                        {s.reviewedBy && (
                          <span style={{ ...mutedStyle, fontSize: 11 }}>
                            {s.reviewReason ? " — " : ""}
                            {s.reviewedBy}
                          </span>
                        )}
                      </td>
                      <td style={{ ...tdStyle, ...mutedStyle, fontSize: 11 }}>{s.updatedAt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
