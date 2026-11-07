//! FILENAME: app/extensions/ConditionalFormatting/components/DataBarRuleOptions.tsx
// PURPOSE: New Rule's "Format all cells based on their values" page for a DATA
//          BAR: Excel's Show Bar Only, Bar Appearance (fill and border), Bar
//          Direction, and its "Negative Value and Axis Settings" dialog.
// CONTEXT: BUG-0728 -- the painter honoured every one of these options and no
//          dialog could set them. The controls edit a `DataBarUi`
//          (lib/dataBarOptions.ts), which is what OK turns into the rule; the
//          sub-dialog edits a COPY and writes it back only on its OK, as
//          Excel's does. Colour is DATA here (the bar's look); the chrome paints
//          with the dialog theme's tokens.

import React, { useState } from "react";
import type { DataBarAxisPosition, DataBarDirection } from "@api";
import { useNativeColorPick } from "@api/layout";
import { DIALOG_THEME as DT } from "../../_shared/lib/dialogTheme";
import type { DataBarUi } from "../lib/dataBarOptions";

const rowStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const labelStyle: React.CSSProperties = { fontSize: 13 };
const groupLabelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: DT.textSecondary, margin: 0 };
const selectStyle: React.CSSProperties = {
  padding: "4px 8px",
  border: `1px solid ${DT.inputBorder}`,
  borderRadius: 3,
  fontSize: 13,
  color: DT.inputText,
  backgroundColor: DT.inputBg,
};
const colorInputStyle: React.CSSProperties = {
  width: 40,
  height: 22,
  padding: 0,
  border: `1px solid ${DT.inputBorder}`,
  borderRadius: 3,
  backgroundColor: DT.inputBg,
  cursor: "pointer",
};
const buttonStyle: React.CSSProperties = {
  padding: "4px 12px",
  border: `1px solid ${DT.buttonBorder}`,
  borderRadius: 3,
  fontSize: 13,
  cursor: "pointer",
  backgroundColor: DT.buttonBg,
  color: DT.buttonText,
  alignSelf: "flex-start",
};
const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  backgroundColor: DT.primaryBg,
  color: DT.primaryText,
  borderColor: DT.primaryBg,
};
/** Over New Rule (z-index 9500), as Excel's sub-dialog sits over its parent. */
const panelStyle: React.CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: DT.overlay,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 9600,
};
const panelBoxStyle: React.CSSProperties = {
  backgroundColor: DT.bg,
  color: DT.text,
  border: `1px solid ${DT.border}`,
  borderRadius: 4,
  boxShadow: DT.shadow,
  padding: 14,
  width: 420,
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const BAR_DIRECTIONS: { value: DataBarDirection; label: string }[] = [
  { value: "context", label: "Context" },
  { value: "leftToRight", label: "Left-to-Right" },
  { value: "rightToLeft", label: "Right-to-Left" },
];

const AXIS_POSITIONS: { value: DataBarAxisPosition; label: string }[] = [
  { value: "automatic", label: "Automatic (display at variable position based on negative values)" },
  { value: "cellMidpoint", label: "Cell midpoint" },
  { value: "none", label: "None (show negative value bars in same direction as positive)" },
];

/** One colour of the bar, through the OS picker: a pick commits once. */
function ColorInput(props: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
  disabled?: boolean;
  testId: string;
}): React.ReactElement {
  const pick = useNativeColorPick({ value: props.value, onCommit: props.onChange });
  return (
    <input
      {...pick}
      aria-label={props.label}
      data-testid={props.testId}
      disabled={props.disabled}
      style={colorInputStyle}
    />
  );
}

/** Excel's "Negative Value and Axis Settings": edits a copy; OK writes it back. */
function NegativeValueAndAxisPanel(props: {
  value: DataBarUi;
  onOk: (next: DataBarUi) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [draft, setDraft] = useState<DataBarUi>(props.value);
  const set = (patch: Partial<DataBarUi>) => setDraft((d) => ({ ...d, ...patch }));
  // The negative bar's border exists only when the bar has one.
  const bordered = draft.border === "solid";
  return (
    // `data-section-flyout`: the dialog host's capture-phase Escape closes the
    // topmost DIALOG unless the key comes from a surface the dialog opened, so
    // Escape here cancels this sub-dialog only (shell/DialogContainer.tsx).
    <div style={panelStyle} data-testid="cf-databar-negative-panel" data-section-flyout>
      <div
        role="dialog"
        aria-label="Negative Value and Axis Settings"
        style={panelBoxStyle}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // Enter / Escape belong to this sub-dialog, not to New Rule under it.
          e.stopPropagation();
          if (e.key === "Escape") props.onCancel();
          if (e.key === "Enter" && !(e.target instanceof HTMLSelectElement)) props.onOk(draft);
        }}
      >
        <h4 style={{ margin: 0, fontSize: 13 }}>Negative Value and Axis Settings</h4>

        <p style={groupLabelStyle}>Negative bar fill color</p>
        <label style={rowStyle}>
          <input
            type="radio"
            name="cf-negative-fill"
            checked={draft.negativeFill === "color"}
            onChange={() => set({ negativeFill: "color" })}
            data-testid="cf-databar-negative-fill-color"
          />
          <span style={labelStyle}>Fill color:</span>
          <ColorInput
            label="Negative bar fill color"
            value={draft.negativeFillColor}
            onChange={(hex) => set({ negativeFill: "color", negativeFillColor: hex })}
            disabled={draft.negativeFill !== "color"}
            testId="cf-databar-negative-fill-picker"
          />
        </label>
        <label style={rowStyle}>
          <input
            type="radio"
            name="cf-negative-fill"
            checked={draft.negativeFill === "sameAsPositive"}
            onChange={() => set({ negativeFill: "sameAsPositive" })}
            data-testid="cf-databar-negative-fill-same"
          />
          <span style={labelStyle}>Apply same fill color as positive bar</span>
        </label>

        <p style={groupLabelStyle}>Negative bar border color</p>
        <label style={rowStyle}>
          <input
            type="radio"
            name="cf-negative-border"
            checked={draft.negativeBorder === "color"}
            disabled={!bordered}
            onChange={() => set({ negativeBorder: "color" })}
            data-testid="cf-databar-negative-border-color"
          />
          <span style={labelStyle}>Border color:</span>
          <ColorInput
            label="Negative bar border color"
            value={draft.negativeBorderColor}
            onChange={(hex) => set({ negativeBorder: "color", negativeBorderColor: hex })}
            disabled={!bordered || draft.negativeBorder !== "color"}
            testId="cf-databar-negative-border-picker"
          />
        </label>
        <label style={rowStyle}>
          <input
            type="radio"
            name="cf-negative-border"
            checked={draft.negativeBorder === "sameAsPositive"}
            disabled={!bordered}
            onChange={() => set({ negativeBorder: "sameAsPositive" })}
            data-testid="cf-databar-negative-border-same"
          />
          <span style={labelStyle}>Apply same border color as positive bar</span>
        </label>

        <p style={groupLabelStyle}>Axis settings</p>
        <span style={{ fontSize: 12 }}>Select axis position in cell to change the appearance of bars for negative values</span>
        {AXIS_POSITIONS.map((a) => (
          <label key={a.value} style={rowStyle}>
            <input
              type="radio"
              name="cf-axis-position"
              checked={draft.axisPosition === a.value}
              onChange={() => set({ axisPosition: a.value })}
              data-testid={`cf-databar-axis-${a.value}`}
            />
            <span style={labelStyle}>{a.label}</span>
          </label>
        ))}
        <div style={rowStyle}>
          <span style={labelStyle}>Axis color:</span>
          <ColorInput
            label="Axis color"
            value={draft.axisColor}
            onChange={(hex) => set({ axisColor: hex })}
            testId="cf-databar-axis-color"
          />
        </div>

        <div style={{ ...rowStyle, justifyContent: "flex-end" }}>
          <button type="button" style={primaryButtonStyle} onClick={() => props.onOk(draft)}>
            OK
          </button>
          <button type="button" style={buttonStyle} onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** The data-bar page's controls. */
export function DataBarRuleOptions(props: { value: DataBarUi; onChange: (next: DataBarUi) => void }): React.ReactElement {
  const { value, onChange } = props;
  const [negativeOpen, setNegativeOpen] = useState(false);
  const set = (patch: Partial<DataBarUi>) => onChange({ ...value, ...patch });
  return (
    <>
      <label style={rowStyle}>
        <input
          type="checkbox"
          checked={value.showBarOnly}
          onChange={(e) => set({ showBarOnly: e.target.checked })}
          data-testid="cf-databar-show-bar-only"
        />
        <span style={labelStyle}>Show Bar Only</span>
      </label>

      <p style={groupLabelStyle}>Bar Appearance:</p>
      <div style={rowStyle}>
        <span style={labelStyle}>Fill</span>
        <select
          style={selectStyle}
          value={value.fill}
          onChange={(e) => set({ fill: e.target.value as DataBarUi["fill"] })}
          aria-label="Fill"
          data-testid="cf-databar-fill"
        >
          <option value="solid">Solid Fill</option>
          <option value="gradient">Gradient Fill</option>
        </select>
        <span style={labelStyle}>Color</span>
        <ColorInput label="Bar color" value={value.color} onChange={(hex) => set({ color: hex })} testId="cf-databar-color" />
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>Border</span>
        <select
          style={selectStyle}
          value={value.border}
          onChange={(e) => set({ border: e.target.value as DataBarUi["border"] })}
          aria-label="Border"
          data-testid="cf-databar-border"
        >
          <option value="none">No Border</option>
          <option value="solid">Solid Border</option>
        </select>
        <span style={labelStyle}>Color</span>
        <ColorInput
          label="Border color"
          value={value.borderColor}
          onChange={(hex) => set({ borderColor: hex })}
          disabled={value.border !== "solid"}
          testId="cf-databar-border-color"
        />
      </div>

      <button type="button" style={buttonStyle} onClick={() => setNegativeOpen(true)} data-testid="cf-databar-negative-open">
        Negative Value and Axis...
      </button>

      <div style={rowStyle}>
        <span style={labelStyle}>Bar Direction:</span>
        <select
          style={selectStyle}
          value={value.direction}
          onChange={(e) => set({ direction: e.target.value as DataBarDirection })}
          aria-label="Bar Direction"
          data-testid="cf-databar-direction"
        >
          {BAR_DIRECTIONS.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </select>
      </div>

      {negativeOpen && (
        <NegativeValueAndAxisPanel
          value={value}
          onOk={(next) => {
            onChange(next);
            setNegativeOpen(false);
          }}
          onCancel={() => setNegativeOpen(false)}
        />
      )}
    </>
  );
}

/** A lighter tint of a hex colour, for the gradient's far end (sample only). */
function tint(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const mix = (c: number) => Math.round(c + (255 - c) * 0.6);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** The page's preview: one positive bar as the options paint it. */
export function DataBarPreview(props: { value: DataBarUi }): React.ReactElement {
  const { value } = props;
  const rtl = value.direction === "rightToLeft";
  const background =
    value.fill === "gradient"
      ? `linear-gradient(to ${rtl ? "left" : "right"}, ${value.color}, ${tint(value.color)})`
      : value.color;
  return (
    <div
      data-colour-data
      data-testid="cf-databar-preview"
      style={{
        height: 20,
        borderRadius: 3,
        border: `1px solid ${DT.border}`,
        display: "flex",
        justifyContent: rtl ? "flex-end" : "flex-start",
        padding: 2,
        boxSizing: "border-box",
      }}
    >
      <div
        data-colour-data
        style={{
          width: "70%",
          background,
          border: value.border === "solid" ? `1px solid ${value.borderColor}` : "none",
          boxSizing: "border-box",
        }}
      />
    </div>
  );
}
