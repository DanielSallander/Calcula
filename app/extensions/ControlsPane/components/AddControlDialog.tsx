//! FILENAME: app/extensions/ControlsPane/components/AddControlDialog.tsx
// PURPOSE: Dialog for adding a pane control (button / slider / dropdown /
//          checkbox / custom) to the Controls pane. Opened by AddItemMenu with
//          the picked type in the dialog data; a type selector still allows
//          switching. Name is required and unique case-insensitively across
//          pane controls AND ribbon filters (validated inline with the same
//          rule the backend enforces; other backend failures surface as a
//          generic inline error). "Custom..." can scaffold + open a starter
//          object script right away.
// CONTEXT: Visual idiom mirrors AddFilterDialog (overlay, header, footer).

import React, { useState, useEffect, useCallback, useMemo } from "react";
import type { DialogProps } from "@api";
import {
  listAnimatableCharts,
  listChartParams,
  type AnimatableChart,
  type ChartParameter,
} from "@api/chartParams";
import type {
  ChartParamTarget,
  ControlValue,
  PaneControlConfig,
  PaneControlType,
} from "../lib/controlsPaneTypes";
import { createControlAsync, getAllControls } from "../lib/controlsPaneStore";
import { getAllFilters } from "../lib/filterPaneStore";
import { openControlScriptEditor } from "./CustomControlHost";

// ============================================================================
// Types & helpers
// ============================================================================

const TYPE_LABELS: Record<PaneControlType, string> = {
  button: "Button",
  slider: "Slider",
  dropdown: "Dropdown",
  checkbox: "Checkbox",
  custom: "Custom (scripted)",
};

const CONTROL_TYPES: PaneControlType[] = [
  "button",
  "slider",
  "dropdown",
  "checkbox",
  "custom",
];

function isPaneControlType(v: unknown): v is PaneControlType {
  return (
    typeof v === "string" && (CONTROL_TYPES as string[]).includes(v)
  );
}

/** Where a conflicting name already lives, or null when the name is free.
 *  Same case-insensitive both-families rule create_pane_control enforces. */
function findNameConflict(name: string): string | null {
  const upper = name.toUpperCase();
  if (getAllControls().some((c) => c.name.toUpperCase() === upper)) {
    return "a pane control";
  }
  if (getAllFilters().some((f) => f.name.toUpperCase() === upper)) {
    return "a ribbon filter";
  }
  return null;
}

interface BuiltConfig {
  config: PaneControlConfig;
  value?: ControlValue;
}

// ============================================================================
// Component
// ============================================================================

export function AddControlDialog({
  isOpen,
  onClose,
  data,
}: DialogProps): React.ReactElement | null {
  const [controlType, setControlType] = useState<PaneControlType>("button");
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  // Slider config (kept as strings so partial input doesn't fight the user).
  const [sliderMin, setSliderMin] = useState("0");
  const [sliderMax, setSliderMax] = useState("100");
  const [sliderStep, setSliderStep] = useState("1");
  const [sliderShowValue, setSliderShowValue] = useState(true);
  // Dropdown config
  const [dropdownSourceType, setDropdownSourceType] = useState<
    "static" | "cellRange"
  >("static");
  const [dropdownItemsText, setDropdownItemsText] = useState("");
  const [dropdownReference, setDropdownReference] = useState("");
  // Custom config
  const [withStarterScript, setWithStarterScript] = useState(true);
  // Optional chart-param binding (slider/dropdown): "" = not bound.
  const [chartParamChartId, setChartParamChartId] = useState("");
  const [chartParamName, setChartParamName] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // Charts with declared params (via the @api/chartParams facade; empty when
  // the Charts extension is unavailable — the section hides itself then).
  const bindableCharts: AnimatableChart[] = useMemo(
    () => (isOpen ? listAnimatableCharts() : []),
    [isOpen],
  );
  const chartParams: ChartParameter[] = useMemo(
    () => (chartParamChartId ? listChartParams(chartParamChartId) : []),
    [chartParamChartId],
  );

  // Reset the form each time the dialog opens; the launching menu item picks
  // the initial type via dialog data.
  useEffect(() => {
    if (isOpen) {
      const initialType = data?.controlType;
      setControlType(isPaneControlType(initialType) ? initialType : "button");
      setName("");
      setLabel("");
      setSliderMin("0");
      setSliderMax("100");
      setSliderStep("1");
      setSliderShowValue(true);
      setDropdownSourceType("static");
      setDropdownItemsText("");
      setDropdownReference("");
      setWithStarterScript(true);
      setChartParamChartId("");
      setChartParamName("");
      setError(null);
      setIsCreating(false);
    }
  }, [isOpen, data]);

  /** Build the per-type config (+ optional initial value), or an error. */
  const buildConfig = useCallback(
    (trimmedName: string): BuiltConfig | { error: string } => {
      // Optional chart-param binding — only when both halves are picked.
      const chartParamTarget: ChartParamTarget | undefined =
        chartParamChartId && chartParamName
          ? { chartId: chartParamChartId, param: chartParamName }
          : undefined;
      switch (controlType) {
        case "button":
          return {
            config: { type: "button", label: label.trim() || trimmedName },
          };
        case "checkbox":
          return {
            config: { type: "checkbox", label: label.trim() || trimmedName },
            value: { kind: "boolean", value: false },
          };
        case "slider": {
          const min = Number(sliderMin);
          const max = Number(sliderMax);
          const step = Number(sliderStep);
          if (
            sliderMin.trim() === "" ||
            sliderMax.trim() === "" ||
            sliderStep.trim() === "" ||
            !Number.isFinite(min) ||
            !Number.isFinite(max) ||
            !Number.isFinite(step)
          ) {
            return { error: "Min, max, and step must be numbers." };
          }
          if (min >= max) {
            return { error: "Min must be less than max." };
          }
          if (step <= 0) {
            return { error: "Step must be greater than zero." };
          }
          return {
            config: {
              type: "slider",
              min,
              max,
              step,
              showValue: sliderShowValue,
              ...(chartParamTarget ? { chartParamTarget } : {}),
            },
            value: { kind: "number", value: min },
          };
        }
        case "dropdown": {
          if (dropdownSourceType === "static") {
            const items = dropdownItemsText
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            if (items.length === 0) {
              return { error: "Enter at least one item (one per line)." };
            }
            return {
              config: {
                type: "dropdown",
                source: { type: "static", items },
                placeholder: null,
                ...(chartParamTarget ? { chartParamTarget } : {}),
              },
            };
          }
          const reference = dropdownReference.trim();
          if (!reference) {
            return {
              error: "Enter a cell range reference (e.g. Sheet1!A1:A10).",
            };
          }
          return {
            config: {
              type: "dropdown",
              source: { type: "cellRange", reference },
              placeholder: null,
              ...(chartParamTarget ? { chartParamTarget } : {}),
            },
          };
        }
        case "custom":
          return { config: { type: "custom", properties: {} } };
      }
    },
    [
      controlType,
      label,
      sliderMin,
      sliderMax,
      sliderStep,
      sliderShowValue,
      dropdownSourceType,
      dropdownItemsText,
      dropdownReference,
      chartParamChartId,
      chartParamName,
    ],
  );

  const handleCreate = useCallback(async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Enter a control name.");
      return;
    }
    // Inline uniqueness check — the same case-insensitive both-families rule
    // the backend enforces, surfaced before the round-trip.
    const conflict = findNameConflict(trimmedName);
    if (conflict) {
      setError(
        `A control named "${trimmedName}" already exists (${conflict}) — ` +
          "control names are unique across the Controls pane.",
      );
      return;
    }
    const built = buildConfig(trimmedName);
    if ("error" in built) {
      setError(built.error);
      return;
    }

    setError(null);
    setIsCreating(true);
    try {
      const created = await createControlAsync({
        name: trimmedName,
        controlType,
        config: built.config,
        value: built.value ?? null,
      });
      if (!created) {
        // createControlAsync logs the backend message and returns null.
        setError(
          "Failed to create the control — the name may already be in use " +
            "(see the console for details).",
        );
        return;
      }
      if (controlType === "custom" && withStarterScript) {
        void openControlScriptEditor(created);
      }
      onClose();
    } finally {
      setIsCreating(false);
    }
  }, [name, buildConfig, controlType, withStarterScript, onClose]);

  if (!isOpen) return null;

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.dialog} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={styles.header}>
          <span style={styles.title}>Add {TYPE_LABELS[controlType]}</span>
          <button style={styles.closeButton} onClick={onClose}>
            x
          </button>
        </div>

        {/* Body */}
        <div style={styles.body}>
          {/* Type */}
          <div style={styles.field}>
            <label style={styles.label}>Control Type</label>
            <select
              style={styles.select}
              value={controlType}
              onChange={(e) => {
                setControlType(e.target.value as PaneControlType);
                setError(null);
              }}
            >
              {CONTROL_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </div>

          {/* Name */}
          <div style={styles.field}>
            <label style={styles.label}>Name</label>
            <input
              type="text"
              style={styles.input}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              placeholder="Unique name, e.g. Rate"
              autoFocus
            />
            <div style={styles.hint}>
              Formulas read the control with =GET.CONTROLVALUE("name").
            </div>
          </div>

          {/* Per-type config */}
          {(controlType === "button" || controlType === "checkbox") && (
            <div style={styles.field}>
              <label style={styles.label}>Label</label>
              <input
                type="text"
                style={styles.input}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Defaults to the control name"
              />
            </div>
          )}

          {controlType === "slider" && (
            <>
              <div style={styles.numberRow}>
                <div style={styles.numberField}>
                  <label style={styles.label}>Min</label>
                  <input
                    type="number"
                    style={styles.input}
                    value={sliderMin}
                    onChange={(e) => setSliderMin(e.target.value)}
                  />
                </div>
                <div style={styles.numberField}>
                  <label style={styles.label}>Max</label>
                  <input
                    type="number"
                    style={styles.input}
                    value={sliderMax}
                    onChange={(e) => setSliderMax(e.target.value)}
                  />
                </div>
                <div style={styles.numberField}>
                  <label style={styles.label}>Step</label>
                  <input
                    type="number"
                    style={styles.input}
                    value={sliderStep}
                    onChange={(e) => setSliderStep(e.target.value)}
                  />
                </div>
              </div>
              <div style={styles.field}>
                <label style={styles.checkboxRow}>
                  <input
                    type="checkbox"
                    checked={sliderShowValue}
                    onChange={(e) => setSliderShowValue(e.target.checked)}
                  />
                  <span>Show the current value next to the slider</span>
                </label>
              </div>
            </>
          )}

          {controlType === "dropdown" && (
            <>
              <div style={styles.field}>
                <label style={styles.label}>Items Source</label>
                <div style={styles.radioRow}>
                  <label style={styles.checkboxRow}>
                    <input
                      type="radio"
                      name="controls-pane-dropdown-source"
                      checked={dropdownSourceType === "static"}
                      onChange={() => setDropdownSourceType("static")}
                    />
                    <span>Static list</span>
                  </label>
                  <label style={styles.checkboxRow}>
                    <input
                      type="radio"
                      name="controls-pane-dropdown-source"
                      checked={dropdownSourceType === "cellRange"}
                      onChange={() => setDropdownSourceType("cellRange")}
                    />
                    <span>Cell range</span>
                  </label>
                </div>
              </div>
              {dropdownSourceType === "static" ? (
                <div style={styles.field}>
                  <label style={styles.label}>Items (one per line)</label>
                  <textarea
                    style={styles.textarea}
                    value={dropdownItemsText}
                    onChange={(e) => setDropdownItemsText(e.target.value)}
                    rows={5}
                    placeholder={"North\nSouth\nEast\nWest"}
                  />
                </div>
              ) : (
                <div style={styles.field}>
                  <label style={styles.label}>Cell Range</label>
                  <input
                    type="text"
                    style={styles.input}
                    value={dropdownReference}
                    onChange={(e) => setDropdownReference(e.target.value)}
                    placeholder="e.g. Sheet1!A1:A10"
                  />
                  <div style={styles.hint}>
                    Items re-read from the grid when it refreshes.
                  </div>
                </div>
              )}
            </>
          )}

          {/* Optional chart-param binding (slider/dropdown only; hidden when
              no chart declares bindable params) */}
          {(controlType === "slider" || controlType === "dropdown") &&
            bindableCharts.length > 0 && (
              <div style={styles.field}>
                <label style={styles.label}>
                  Drive a Chart Parameter (optional)
                </label>
                <div style={styles.radioRow}>
                  <select
                    style={styles.select}
                    value={chartParamChartId}
                    onChange={(e) => {
                      setChartParamChartId(e.target.value);
                      setChartParamName("");
                    }}
                  >
                    <option value="">(no chart)</option>
                    {bindableCharts.map((c) => (
                      <option key={c.chartId} value={c.chartId}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <select
                    style={styles.select}
                    value={chartParamName}
                    onChange={(e) => setChartParamName(e.target.value)}
                    disabled={!chartParamChartId}
                  >
                    <option value="">(parameter)</option>
                    {chartParams.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={styles.hint}>
                  Value changes (including slider drags) set the parameter live
                  via the chart-params facade.
                </div>
              </div>
            )}

          {controlType === "custom" && (
            <div style={styles.field}>
              <div style={styles.hint}>
                A custom control starts empty and is rendered by its object
                script (runs sandboxed; publish a value with
                shape.setProperty("value", ...)).
              </div>
              <label style={{ ...styles.checkboxRow, marginTop: "6px" }}>
                <input
                  type="checkbox"
                  checked={withStarterScript}
                  onChange={(e) => setWithStarterScript(e.target.checked)}
                />
                <span>Create with starter script (opens the code editor)</span>
              </label>
            </div>
          )}

          {error && <div style={styles.error}>{error}</div>}
        </div>

        {/* Footer */}
        <div style={styles.footer}>
          <button style={styles.cancelButton} onClick={onClose}>
            Cancel
          </button>
          <button
            style={{
              ...styles.createButton,
              opacity: name.trim().length === 0 || isCreating ? 0.5 : 1,
            }}
            disabled={name.trim().length === 0 || isCreating}
            onClick={handleCreate}
          >
            {isCreating ? "Adding..." : "Add Control"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Styles — mirrors AddFilterDialog
// ============================================================================

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.3)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10000,
  },
  dialog: {
    background: "#fff",
    borderRadius: "6px",
    width: "420px",
    maxHeight: "90vh",
    display: "flex",
    flexDirection: "column",
    boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 16px",
    borderBottom: "1px solid #e0e0e0",
  },
  title: {
    fontSize: "14px",
    fontWeight: 600,
    color: "#333",
  },
  closeButton: {
    border: "none",
    background: "none",
    fontSize: "16px",
    cursor: "pointer",
    color: "#888",
    padding: "0 4px",
  },
  body: {
    padding: "12px 16px",
    overflowY: "auto" as const,
    flex: 1,
  },
  field: {
    marginBottom: "12px",
  },
  label: {
    display: "block",
    fontSize: "12px",
    fontWeight: 600,
    color: "#555",
    marginBottom: "4px",
  },
  input: {
    width: "100%",
    boxSizing: "border-box" as const,
    padding: "6px 8px",
    fontSize: "12px",
    border: "1px solid #d0d0d0",
    borderRadius: "3px",
  },
  select: {
    width: "100%",
    padding: "6px 8px",
    fontSize: "12px",
    border: "1px solid #d0d0d0",
    borderRadius: "3px",
  },
  textarea: {
    width: "100%",
    boxSizing: "border-box" as const,
    padding: "6px 8px",
    fontSize: "12px",
    border: "1px solid #d0d0d0",
    borderRadius: "3px",
    fontFamily: "inherit",
    resize: "vertical" as const,
  },
  numberRow: {
    display: "flex",
    gap: "8px",
    marginBottom: "12px",
  },
  numberField: {
    flex: 1,
    minWidth: 0,
  },
  radioRow: {
    display: "flex",
    gap: "16px",
  },
  checkboxRow: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    fontSize: "12px",
    color: "#333",
    cursor: "pointer",
  },
  hint: {
    fontSize: "11px",
    color: "#888",
    marginTop: "4px",
  },
  error: {
    fontSize: "11px",
    color: "#c00",
    marginBottom: "8px",
    whiteSpace: "pre-wrap" as const,
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "8px",
    padding: "12px 16px",
    borderTop: "1px solid #e0e0e0",
  },
  cancelButton: {
    padding: "6px 16px",
    fontSize: "12px",
    border: "1px solid #d0d0d0",
    borderRadius: "3px",
    background: "#fff",
    cursor: "pointer",
  },
  createButton: {
    padding: "6px 16px",
    fontSize: "12px",
    border: "none",
    borderRadius: "3px",
    background: "#0078d4",
    color: "#fff",
    cursor: "pointer",
  },
};
