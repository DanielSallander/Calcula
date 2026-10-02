//! FILENAME: app/extensions/ScriptableObjects/components/CarriedApprovalsSection.tsx
// PURPOSE: "Code in This File" lists the approvals this workbook CARRIES that
//          count for nothing on this computer (M6): made on another computer,
//          made before approvals were tied to a computer, changed after they
//          were made, or unreadable because this computer's approvals key is.
// CONTEXT: Approvals are kept in the workbook but sealed to the computer that
//          made them (app/src-tauri/src/consent_seal.rs), and the Rust listing
//          (read through @api/distributedConsent's loadConsentReport) reports
//          every record it ignored, with the reason. Without this list a user
//          who approved an application at the
//          office and opens the file at home would only see the approval screen
//          come back, with nothing saying why. It names the application and the
//          reason -- NEVER a key id: which computer's key sealed a record is
//          not the user's business to compare, and a key id on screen is one
//          more thing to copy into a crafted file.

import React from "react";
import type { ConsentIgnoredReason, ConsentReport } from "@api/distributedConsent";

const sectionStyle: React.CSSProperties = {
  margin: "8px 4px",
  padding: "6px 8px",
  border: "1px solid #e0d2b0",
  borderRadius: 4,
  background: "#fffcf4",
};

const headerStyle: React.CSSProperties = { fontWeight: 600, fontSize: 11, marginBottom: 4 };
const introStyle: React.CSSProperties = { fontSize: 11, color: "#555", lineHeight: 1.4, marginBottom: 6 };
const rowStyle: React.CSSProperties = { fontSize: 11, padding: "3px 0", borderTop: "1px solid #f0e6cc" };

/** Why a carried approval does not count here, in words. Exported for the unit tier. */
export function describeIgnoredReason(reason: ConsentIgnoredReason): string {
  switch (reason) {
    case "otherComputer":
      return "approved on another computer";
    case "unsealed":
      return "approved before approvals were tied to a computer, or not by Calcula";
    case "altered":
      return "changed after it was approved";
    case "keyUnavailable":
      return "this computer's approvals key cannot be read, so no approval counts here until it is repaired";
    default:
      // A reason a newer Rust reports and this build does not know: shown as
      // Rust spelled it rather than dropped, so the row still says SOMETHING.
      return `does not count here (${String(reason)})`;
  }
}

/**
 * The approval key namespaces other surfaces record under, and what each one
 * approves. The bare name is an application's object scripts, macros and
 * button actions.
 */
const KEY_NAMESPACES: ReadonlyArray<readonly [string, string]> = [
  ["custom-functions:", "custom functions"],
  ["lib:", "script library"],
  ["chart-marks:", "chart marks"],
  ["chart-transforms:", "chart transforms"],
  ["writeback-validator:", "writeback check"],
  // plan_M8 S3: the Calcula commands an application's button cells may run.
  ["button-commands:", "button commands"],
];

/** An approval key as the user reads it: "Sales", or "Sales (custom functions)". */
export function describeApprovalKey(key: string): string {
  for (const [prefix, what] of KEY_NAMESPACES) {
    if (key.startsWith(prefix) && key.length > prefix.length) {
      return `${key.slice(prefix.length)} (${what})`;
    }
  }
  return key;
}

export function CarriedApprovalsSection({
  report,
  error,
}: {
  report: ConsentReport | null;
  error: string | null;
}): React.ReactElement | null {
  if (error) {
    return (
      <div style={sectionStyle} data-testid="carried-approvals-section">
        <div style={{ ...introStyle, color: "#B00020", marginBottom: 0 }}>
          Could not read this workbook&apos;s approvals: {error}
        </div>
      </div>
    );
  }
  const ignored = report?.ignored ?? [];
  if (ignored.length === 0) return null;
  // One row per (application, reason): several computers' records for one
  // application say one thing to the reader.
  const seen = new Set<string>();
  const rows: Array<{ packageName: string; reason: ConsentIgnoredReason }> = [];
  for (const entry of ignored) {
    const key = JSON.stringify([entry.packageName, entry.reason]);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ packageName: entry.packageName, reason: entry.reason });
  }
  return (
    <div style={sectionStyle} data-testid="carried-approvals-section">
      <div style={headerStyle}>Approvals this workbook carried from elsewhere ({rows.length})</div>
      <div style={introStyle}>
        These approvals are stored in this workbook but count for nothing on this computer: an
        approval counts only on the computer that made it. The code they covered asks again here.
      </div>
      {rows.map((row) => (
        <div
          key={`${row.packageName}\u0000${row.reason}`}
          style={rowStyle}
          data-carried-approval={row.packageName}
          data-carried-approval-reason={row.reason}
        >
          <strong>{describeApprovalKey(row.packageName)}</strong> &mdash; {describeIgnoredReason(row.reason)}
        </div>
      ))}
    </div>
  );
}
