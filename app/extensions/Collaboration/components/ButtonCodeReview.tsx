//! FILENAME: app/extensions/Collaboration/components/ButtonCodeReview.tsx
// PURPOSE: The push dialog's review of the buttons' CODE (BUG-0257): what the
//          push restores, what refuses it, and what the author must read and
//          tick before it goes out under their key.
// CONTEXT: A working copy HOLDS its application's button code (it runs there
//          only after the application's approval, through the Rust button door
//          or the macro-link route -- phase 4 of BUG-0257), and the push puts it
//          back only when the signed base carries those exact bytes. Everything else is code the signed base does not have -- the
//          author's own new code, or bytes a crafted file brought in -- and the
//          two cannot be told apart, so each piece is SHOWN here and must be
//          acknowledged by hash. The backend refuses a push whose request does
//          not list every one (`CALP_PUSH_BUTTON_CODE_UNREVIEWED`).

import React, { useState } from "react";
import type { ButtonCodeItem, ButtonCodeRelease } from "@api/collaboration";

const boxStyle: React.CSSProperties = {
  fontSize: "12px",
  margin: "8px 0",
  padding: "6px 8px",
  border: "1px solid var(--border-default)",
  borderRadius: 4,
};

const codeStyle: React.CSSProperties = {
  margin: "4px 0",
  padding: "4px 6px",
  fontFamily: "Consolas, 'Cascadia Mono', monospace",
  fontSize: 11,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  maxHeight: 160,
  overflow: "auto",
  border: "1px solid var(--border-default)",
  borderRadius: 3,
  background: "var(--panel-bg)",
};

function slotLabel(item: ButtonCodeItem): string {
  if (item.slot === "action") return "button cell action";
  return item.slot === "macroRef" ? "macro link" : "inline code";
}

/**
 * A button CELL's action (BUG-0260) in words: the code of a cell action is its
 * canonical JSON, e.g. {"kind":"script","scriptId":"macro-report"}.
 */
export function describeCellAction(code: string): string {
  try {
    const action = JSON.parse(code) as Record<string, unknown>;
    if (action.kind === "script" && typeof action.scriptId === "string") {
      const fn =
        typeof action.functionName === "string" && action.functionName
          ? ` and calls ${action.functionName}()`
          : "";
      return `Runs the macro ${action.scriptId}${fn}`;
    }
    if (action.kind === "command" && typeof action.commandId === "string") {
      return `Runs the command ${action.commandId}`;
    }
  } catch {
    // Not JSON: shown as it is below.
  }
  return code;
}

function CodeText({ item }: { item: ButtonCodeItem }): React.ReactElement {
  if (item.slot === "action") {
    return <div style={{ margin: "2px 0" }}>{describeCellAction(item.code)}</div>;
  }
  return item.slot === "macroRef" ? (
    <div style={{ margin: "2px 0" }}>
      Runs the macro <code>{item.code}</code>
    </div>
  ) : (
    <pre style={codeStyle}>{item.code}</pre>
  );
}

/** How many unreviewed pieces the author has not ticked. Pure; for readiness. */
export function unacknowledgedButtonCode(
  release: ButtonCodeRelease | null | undefined,
  acknowledged: ReadonlySet<string>,
): number {
  return (release?.unreviewed ?? []).filter((item) => !acknowledged.has(item.hash)).length;
}

export interface ButtonCodeReviewProps {
  release: ButtonCodeRelease | null | undefined;
  acknowledged: ReadonlySet<string>;
  onAcknowledge: (hash: string, acknowledged: boolean) => void;
}

export function ButtonCodeReview({
  release,
  acknowledged,
  onAcknowledge,
}: ButtonCodeReviewProps): React.ReactElement | null {
  const [showRestored, setShowRestored] = useState(false);
  if (!release) return null;
  const { restored, refused, unreviewed } = release;
  const withheld = release.withheld ?? [];
  if (restored.length === 0 && refused.length === 0 && unreviewed.length === 0 && withheld.length === 0) {
    return null;
  }

  return (
    <div data-testid="push-button-code" style={boxStyle}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Button code in this push</div>

      {refused.length > 0 && (
        <div data-testid="push-button-code-refused" style={{ color: "#c5221f", marginBottom: 6 }}>
          <div style={{ fontWeight: 600 }}>
            This push will be refused: {refused.length} button code slot(s) came with an
            application but cannot be proved to be its code.
          </div>
          {refused.map((item) => (
            <div key={`${item.cell}:${item.slot}`} style={{ marginTop: 4 }}>
              <div>
                {item.cell} ({slotLabel(item)}) -- {item.reason}
              </div>
              <CodeText item={item} />
            </div>
          ))}
          <div style={{ marginTop: 4 }}>
            Open the application for editing again to take its current button code, or replace the
            code on those buttons with your own in the Properties pane (a button cell: Insert &gt;
            Cell Type &gt; Button).
          </div>
        </div>
      )}

      {unreviewed.length > 0 && (
        <div data-testid="push-button-code-unreviewed" style={{ marginBottom: 6 }}>
          <div>
            The application&apos;s signed version does not have this code. It will be published
            under YOUR key; subscribers approve button code before it runs, but read it first and
            tick each one.
          </div>
          {unreviewed.map((item) => (
            <div key={`${item.cell}:${item.slot}:${item.hash}`} style={{ marginTop: 6 }}>
              <div style={{ fontWeight: 600 }}>
                {item.cell} ({slotLabel(item)})
              </div>
              <div style={{ color: "var(--text-secondary)" }}>{item.reason}</div>
              <CodeText item={item} />
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="checkbox"
                  data-button-code-ack={item.hash}
                  checked={acknowledged.has(item.hash)}
                  onChange={(e) => onAcknowledge(item.hash, e.target.checked)}
                />
                I have read this code, and it may be published under my key
              </label>
            </div>
          ))}
        </div>
      )}

      {withheld.length > 0 && (
        <div data-testid="push-button-code-withheld" style={{ marginBottom: 6 }}>
          <div>
            {withheld.length} button code slot(s) came with an application and are LEFT OUT of this
            push: it is not a push of that application from its working copy, so those buttons go
            out without that code. It stays held in this workbook.
          </div>
          {withheld.map((item) => (
            <div key={`${item.cell}:${item.slot}:${item.hash}`} style={{ marginTop: 4 }}>
              <div>
                {item.cell} ({slotLabel(item)}), from &apos;{item.application || "an application"}&apos;
              </div>
              <CodeText item={item} />
            </div>
          ))}
        </div>
      )}

      {restored.length > 0 && (
        <div data-testid="push-button-code-restored">
          <button
            type="button"
            onClick={() => setShowRestored((s) => !s)}
            style={{ border: "none", background: "none", padding: 0, cursor: "pointer", fontSize: 12 }}
            aria-expanded={showRestored}
          >
            {showRestored ? "▾" : "▸"} {restored.length} button code slot(s) of the application are
            published unchanged (they match its signed version)
          </button>
          {showRestored &&
            restored.map((item) => (
              <div key={`${item.cell}:${item.slot}`} style={{ marginTop: 4 }}>
                <div>
                  {item.cell} ({slotLabel(item)}), from &apos;{item.application}&apos;
                </div>
                <CodeText item={item} />
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
