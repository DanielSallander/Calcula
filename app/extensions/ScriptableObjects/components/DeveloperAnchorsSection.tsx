//! FILENAME: app/extensions/ScriptableObjects/components/DeveloperAnchorsSection.tsx
// PURPOSE: "Code in This File" -> "Applications you develop": who this COMPUTER
//          remembers as the creator of each application it has opened for
//          editing, pushed to or published (the developer anchor), with a way to
//          forget one.
// CONTEXT: A workspace proves an application's creator by its first version's
//          signature but finds that version through an unsigned listing, so
//          anyone who can write to the workspace folder can plant a first
//          version of their own. This computer's memory of the creator is what
//          refuses that -- a checkout, merge or push naming a different creator
//          is refused, naming both keys. It is machine state, not workbook
//          state, so it sits beside the trusted-publisher pins (a separate store
//          answering a separate question) and says so.
//
//          Forget is a deliberate hole and is gated the way every such gesture
//          is here: `await confirmAsync(...)`, anything but an explicit yes does
//          nothing, and the backend audits every forget.
//
//          The workspace is shown in the user's own spelling (`scopeLabel`) and
//          is also what Forget sends back; the normalized scope id is key
//          material and never reaches this view.

import React, { useState } from "react";
import {
  forgetDeveloperAnchor,
  type DeveloperAnchorInfo,
  type DeveloperAnchoredBy,
  type TrustedPublisherReport,
} from "@api/collaboration";
import { confirmAsync } from "@api/dialogs";

const sectionStyle: React.CSSProperties = {
  margin: "14px 4px 10px",
  border: "1px solid #DDD",
  borderRadius: 4,
  backgroundColor: "#FAFAFA",
};

const headerStyle: React.CSSProperties = {
  padding: "5px 8px",
  borderBottom: "1px solid #E6E6E6",
  fontWeight: 600,
  fontSize: 11.5,
  color: "#444",
};

const noteStyle: React.CSSProperties = {
  padding: "6px 8px 0",
  fontSize: 10,
  color: "#7A7A7A",
  lineHeight: 1.4,
};

const emptyStyle: React.CSSProperties = {
  padding: "8px",
  fontSize: 10.5,
  color: "#6B7A90",
  lineHeight: 1.4,
};

const linkBtnStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#2A6FB0",
  cursor: "pointer",
  fontSize: 10,
  padding: 0,
  textDecoration: "underline",
};

/** How each anchor was recorded. One row per Rust `AnchoredBy` wire value. */
export const ANCHOR_SOURCE: Record<DeveloperAnchoredBy, string> = {
  checkout: "opened for editing",
  publish: "published or pushed",
  publisherList: "changed who may publish it",
};

/** The question asked before forgetting one remembered creator. */
export function forgetRememberedCreatorQuestion(anchor: DeveloperAnchorInfo): string {
  return (
    `Forget that '${anchor.application}' in ${anchor.scopeLabel} was created by ` +
    `${anchor.rootName || "an unnamed publisher"} (key ${anchor.rootFingerprint})?\n\n` +
    "The next checkout or push of it from this computer remembers whatever creator the " +
    "workspace then names. Anyone who can write to the workspace folder can plant a first " +
    "version of their own, so do this only after the application's creator has confirmed " +
    "which key is theirs.\n\nForget the remembered creator?"
  );
}

export function DeveloperAnchorsSection({
  report,
  onChanged,
}: {
  report: TrustedPublisherReport | null;
  onChanged: () => void;
}): React.ReactElement {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!report) {
    return (
      <div style={sectionStyle}>
        <div style={headerStyle}>Applications you develop</div>
        <div style={emptyStyle}>Reading what this computer remembers...</div>
      </div>
    );
  }

  const anchors = report.developerAnchors ?? [];
  const storeError = report.developerAnchorsError ?? "";

  const forget = async (anchor: DeveloperAnchorInfo) => {
    let proceed = false;
    try {
      // AWAITED: the Tauri confirm is a Promise, and `!promise` is always false.
      proceed = await confirmAsync(forgetRememberedCreatorQuestion(anchor), {
        title: "Forget the remembered creator",
        kind: "warning",
      });
    } catch {
      // A dialog that cannot be shown is a refusal, never consent.
      proceed = false;
    }
    if (proceed !== true) return;
    setBusy(`${anchor.scopeLabel}|${anchor.application}`);
    setError(null);
    try {
      await forgetDeveloperAnchor(anchor.scopeLabel, anchor.application);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={sectionStyle} data-testid="developer-anchors">
      <div style={headerStyle}>
        Applications you develop: this computer remembers who created them ({anchors.length})
      </div>

      <div style={noteStyle}>
        NOT part of this workbook. When this computer opens an application for editing, pushes to
        it or publishes it, it remembers the key that created it. A workspace that later names a
        different creator is refused, naming both keys -- a first version planted by someone who
        can write to the workspace folder is proved by its own signature, and only this memory
        can tell it apart.
      </div>

      {storeError !== "" && (
        <div style={{ ...emptyStyle, color: "#B00020" }} data-testid="developer-anchors-error">
          What this computer remembers could not be read: {storeError}. This is NOT the same as
          &ldquo;nothing remembered&rdquo; -- every checkout, merge and push refuses until it is
          repaired.
        </div>
      )}

      {storeError === "" && anchors.length === 0 && (
        <div style={emptyStyle}>
          Nothing remembered yet. Opening an application for editing, or publishing one, records
          who created it.
        </div>
      )}

      {error && <div style={{ ...emptyStyle, color: "#B00020" }}>{error}</div>}

      {anchors.map((a) => {
        const key = `${a.scopeLabel}|${a.application}`;
        return (
          <div
            key={key}
            data-testid="developer-anchor-row"
            style={{ padding: "5px 8px", borderTop: "1px solid #EEE", fontSize: 11, color: "#444" }}
          >
            <div style={{ fontWeight: 600 }}>
              {a.application}{" "}
              <span style={{ fontWeight: 400, color: "#666" }}>from {a.scopeLabel}</span>
            </div>
            <div style={{ marginLeft: 8, marginTop: 2, lineHeight: 1.4 }}>
              created by {a.rootName || "an unnamed publisher"}{" "}
              <span style={{ fontFamily: "Consolas, monospace", fontSize: 10 }}>
                {a.rootFingerprint}
              </span>{" "}
              (first version v{a.rootVersion}) · remembered {a.anchoredAt.slice(0, 10)} when{" "}
              {ANCHOR_SOURCE[a.anchoredBy] ?? "an unknown step"}
              {a.publishersRevision > 0 ? ` · co-publisher list revision ${a.publishersRevision}` : ""}
            </div>
            <div style={{ marginLeft: 8, marginTop: 2 }}>
              <button
                style={linkBtnStyle}
                data-testid="developer-anchor-forget"
                disabled={busy !== null}
                onClick={() => void forget(a)}
              >
                {busy === key ? "Forgetting..." : "Forget..."}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
