//! FILENAME: app/extensions/Insights/components/OverlayStyleSection.tsx
// PURPOSE: The publisher's control over how the overlay looks — one colour
//          and one dash per polarity, a line width — saved into the workbook.
// CONTEXT: docs/design/insight-overlays.md §4.10 (D-IO-11). The style is a
//          DOCUMENT setting: it rides in the Insights extension-data blob,
//          so it is published with the application and every subscriber
//          sees the publisher's colours. Edits are a local DRAFT until
//          "Apply", which saves once, undoably — a colour picker fires on
//          every drag step, and an undo stack of forty half-colours is not
//          what anyone wants to step back through. "Reset" saves null, which
//          means "the defaults", rather than saving a copy of them: a later
//          change to the defaults then reaches this document too.

import React, { useCallback, useEffect, useState } from "react";
import type { ChartCuePolarity } from "@api/chartCues";
import {
  DASH_PRESETS,
  DEFAULT_OVERLAY_STYLE,
  POLARITIES,
  isOverlayColor,
  normalizeOverlayStyle,
  onOverlayStyleChanged,
  type OverlayStyle,
} from "@api/insightStyle";
import { documentOverlayStyle, saveOverlayStyle } from "../lib/overlay";

const POLARITY_LABEL: Record<ChartCuePolarity, string> = {
  good: "Good",
  bad: "Bad",
  attention: "Attention",
  neutral: "Neutral",
};

type DashName = keyof typeof DASH_PRESETS;

function dashNameOf(dash: readonly number[]): DashName | "custom" {
  for (const [name, pattern] of Object.entries(DASH_PRESETS) as Array<[DashName, number[]]>) {
    if (pattern.length === dash.length && pattern.every((v, i) => v === dash[i])) return name;
  }
  return "custom";
}

/** A colour the `<input type="color">` can show: six-digit hex, else black. */
function hexFor(color: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : /^#[0-9a-f]{3}$/i.test(color) ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`.toLowerCase() : "#000000";
}

const sectionStyle: React.CSSProperties = {
  borderTop: "1px solid #E4E4E4",
  paddingTop: 8,
  marginTop: 4,
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const rowStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, fontSize: 11 };
const labelStyle: React.CSSProperties = { width: 64, color: "#444" };
const smallButtonStyle: React.CSSProperties = {
  padding: "3px 8px",
  fontSize: 11,
  border: "1px solid #D5D5D5",
  borderRadius: 4,
  background: "#FFF",
  cursor: "pointer",
};

export function OverlayStyleSection(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<OverlayStyle>(() => documentOverlayStyle() ?? DEFAULT_OVERLAY_STYLE);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Follow the document (open, undo, reset) while nothing is being edited.
  useEffect(() => {
    return onOverlayStyleChanged(() => {
      if (!dirty) setDraft(documentOverlayStyle() ?? DEFAULT_OVERLAY_STYLE);
    });
  }, [dirty]);

  const setPolarity = useCallback((p: ChartCuePolarity, patch: Partial<{ color: string; dash: number[] }>) => {
    setDraft((d) => ({ ...d, polarity: { ...d.polarity, [p]: { ...d.polarity[p], ...patch } } }));
    setDirty(true);
  }, []);

  const onApply = useCallback(() => {
    setSaving(true);
    void saveOverlayStyle(normalizeOverlayStyle(draft)).finally(() => {
      setSaving(false);
      setDirty(false);
    });
  }, [draft]);

  const onReset = useCallback(() => {
    setSaving(true);
    void saveOverlayStyle(null).finally(() => {
      setSaving(false);
      setDirty(false);
      setDraft(DEFAULT_OVERLAY_STYLE);
    });
  }, []);

  return (
    <div style={sectionStyle} data-testid="insights-overlay-style">
      <button
        type="button"
        style={smallButtonStyle}
        aria-expanded={open}
        data-testid="insights-overlay-style-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Hide overlay style" : "Overlay style…"}
      </button>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }} data-testid="insights-overlay-style-form">
          <div style={{ fontSize: 11, color: "#6A6A6A" }}>
            Saved in this workbook and published with it: subscribers see these colours.
          </div>
          {POLARITIES.map((p) => (
            <div key={p} style={rowStyle}>
              <span style={labelStyle}>{POLARITY_LABEL[p]}</span>
              <input
                type="color"
                aria-label={`${POLARITY_LABEL[p]} colour`}
                data-testid={`insights-overlay-style-color-${p}`}
                value={hexFor(draft.polarity[p].color)}
                onChange={(e) => {
                  if (isOverlayColor(e.target.value)) setPolarity(p, { color: e.target.value });
                }}
              />
              <select
                aria-label={`${POLARITY_LABEL[p]} dash`}
                data-testid={`insights-overlay-style-dash-${p}`}
                value={dashNameOf(draft.polarity[p].dash)}
                onChange={(e) => {
                  const name = e.target.value as DashName | "custom";
                  if (name !== "custom") setPolarity(p, { dash: [...DASH_PRESETS[name]] });
                }}
              >
                <option value="solid">solid</option>
                <option value="dashed">dashed</option>
                <option value="dotted">dotted</option>
                {dashNameOf(draft.polarity[p].dash) === "custom" && <option value="custom">custom</option>}
              </select>
            </div>
          ))}
          <div style={rowStyle}>
            <span style={labelStyle}>Line width</span>
            <input
              type="number"
              min={0.5}
              max={8}
              step={0.5}
              aria-label="Line width"
              data-testid="insights-overlay-style-linewidth"
              value={draft.lineWidth}
              style={{ width: 56 }}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v)) {
                  setDraft((d) => ({ ...d, lineWidth: v }));
                  setDirty(true);
                }
              }}
            />
          </div>
          <div style={{ ...rowStyle, gap: 8 }}>
            <button type="button" style={{ ...smallButtonStyle, opacity: dirty && !saving ? 1 : 0.5 }} disabled={!dirty || saving} data-testid="insights-overlay-style-apply" onClick={onApply}>
              {saving ? "Saving…" : "Apply"}
            </button>
            <button type="button" style={smallButtonStyle} disabled={saving} data-testid="insights-overlay-style-reset" onClick={onReset}>
              Reset to defaults
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
