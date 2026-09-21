// FILENAME: app/extensions/Distribution/components/DesignateWritebackDialog.tsx
// PURPOSE: Dialog to designate a range as a writeback region (add), or edit an
//          existing draft region's policies/schema in place (edit).
// CONTEXT: Opened from the Data menu / context menu on a selected range (add),
//          or from the WritebackPane "Edit" button on a draft region (edit).
//
// IT HAD NO CHROME. This rendered as a bare padded <div> — no position, no max
// size, no scroller — and DialogContainer mounts it straight into Layout's
// `overflow: hidden` 100vh root. A ~550px form (more once the conditional rows
// open) sat in document flow below the status bar with nowhere for the overflow
// to go, so the bottom of it was simply CLIPPED. It now wears the same fixed
// window its neighbours do (RefreshPreviewDialog, PromoteDialog): the body is
// the only scroller, so the drag handle and the buttons never move.

import React, { useState, useCallback } from "react";
import {
  listWritebackValidators,
  writebackValidatorSchemaExtra,
} from "@api/writebackValidators";
import { emitAppEvent } from "@api";
import {
  addWritebackRegion,
  updateWritebackRegion,
  type WritebackRegionDeclaration,
  type ValueSchemaConfig,
  type LifecyclePolicyConfig,
} from "@api/distribution";
import { useDialogWindow } from "@api/dialogWindow";
import {
  DialogBody,
  DialogPane,
  DialogSection,
  DialogFieldGrid,
  DialogFieldSpan,
  dialogWidth,
} from "@api/dialogLayout";

/** Emitted after a draft writeback region is added/updated, so the WritebackPane
 *  (and anything else listing draft regions) can refresh. */
export const WRITEBACK_REGIONS_CHANGED_EVENT = "distribution:writebackRegionsChanged";

interface Props {
  onClose: () => void;
  data?: {
    // Add mode: the selected range to designate.
    sheetId?: string;
    startRow?: number;
    endRow?: number;
    startCol?: number;
    endCol?: number;
    // Edit mode: the existing draft region to edit (id + selector preserved).
    region?: WritebackRegionDeclaration;
  };
}

/** Convert a stored UTC ISO timestamp back to a `datetime-local` value (local
 *  wall-clock "YYYY-MM-DDTHH:MM") for pre-filling the deadline input on edit. */
function isoToLocalInput(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Height of a field's label line, so a control WITHOUT one (a checkbox labels
 *  itself) can be pushed down by exactly that much and line up with its
 *  neighbour in the column beside it. */
const FIELD_LABEL_HEIGHT = 17; // 14px line + the 3px gap below it

/** Controls fill their grid cell, so a column of them shares one left edge. */
const controlStyle: React.CSSProperties = { width: "100%", boxSizing: "border-box" };

/**
 * One labelled control: label ABOVE, control at full cell width.
 *
 * The inline `Label: <control>` pairs this dialog used cannot be columnised —
 * every label is a different width, so every control starts at a different x
 * and a two-column grid of them reads worse than the single column it replaced.
 */
function Field({
  label,
  title,
  style,
  children,
}: {
  label: string;
  title?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label
      title={title}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 3,
        minWidth: 0,
        padding: "5px 0",
        ...style,
      }}
    >
      <span
        style={{
          fontSize: 11,
          lineHeight: "14px",
          color: "var(--text-secondary)",
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

export function DesignateWritebackDialog({ onClose, data }: Props) {
  const win = useDialogWindow({ minWidth: 520, minHeight: 360 });
  const editing = data?.region;
  const s = editing?.schema;
  const lc = editing?.lifecycle;

  // The setter is gone with the Mode <select>, which offered exactly one
  // option — see where the mode is stated below. The state stays: an edited
  // region's stored mode still has to survive the round trip into `common`.
  const [mode] = useState<"per_subscriber" | "list_object">(
    (editing?.mode as "per_subscriber" | "list_object") ?? "per_subscriber",
  );
  const [valueType, setValueType] = useState<string>(s?.valueType ?? "number");
  const [required, setRequired] = useState(s?.required ?? false);
  const [min, setMin] = useState(s?.min != null ? String(s.min) : "");
  const [max, setMax] = useState(s?.max != null ? String(s.max) : "");
  const [enumValues, setEnumValues] = useState((s?.enumValues ?? []).join(", "));
  const [customValidator, setCustomValidator] = useState<string>(s?.customValidator ?? "");
  const [visibility, setVisibility] = useState<string>(editing?.visibility ?? "own_plus_aggregate");
  const [submissionPolicy, setSubmissionPolicy] = useState<string>(editing?.submissionPolicy ?? "on_submit");
  const [versionBinding, setVersionBinding] = useState<string>(editing?.versionBinding ?? "lenient");
  const [lifecyclePolicy, setLifecyclePolicy] = useState<string>(lc?.policy ?? "always");
  const [deadline, setDeadline] = useState(isoToLocalInput(lc?.deadline));
  const [aggregationHint, setAggregationHint] = useState(editing?.aggregationHint ?? "");
  const [expectedRespondents, setExpectedRespondents] = useState(
    (editing?.expectedRespondents ?? []).join(", "),
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSave = useCallback(async () => {
    if (!editing && (!data || data.sheetId == null)) {
      setError("No range selected. Please select a range before opening this dialog.");
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      const schema: ValueSchemaConfig = {
        valueType: valueType as ValueSchemaConfig["valueType"],
        required,
      };
      if (min) schema.min = parseFloat(min);
      if (max) schema.max = parseFloat(max);
      if (valueType === "enum" && enumValues.trim()) {
        schema.enumValues = enumValues.split(",").map((v) => v.trim()).filter(Boolean);
      }
      if (customValidator) {
        // BOTH keys or neither. The subscriber's machine has no catalogue of
        // this publisher's validators, so a name alone cannot be executed —
        // and the Rust submit gate fails CLOSED on a name without a body
        // ("ships no validator code for it"), which would make every region
        // designated here unsubmittable. `writebackValidatorSchemaExtra`
        // captures the registered function's own source for publication.
        const extra = writebackValidatorSchemaExtra(customValidator);
        // Editing a region whose validator body is already stored and whose
        // name is unchanged keeps that body even if the registering extension
        // is not loaded right now — re-publishing must not silently drop it.
        const kept =
          !extra && s?.customValidator === customValidator && s?.customValidatorSource
            ? { customValidator, customValidatorSource: s.customValidatorSource }
            : extra;
        if (!kept) {
          setError(
            `The validator "${customValidator}" is no longer registered, so its code ` +
              "cannot be published with this region. Pick another validator or none.",
          );
          setSubmitting(false);
          return;
        }
        schema.customValidator = kept.customValidator;
        schema.customValidatorSource = kept.customValidatorSource;
      }

      const lifecycle: LifecyclePolicyConfig = {
        policy: lifecyclePolicy as LifecyclePolicyConfig["policy"],
      };
      if (lifecyclePolicy === "until_deadline" && deadline) {
        // The datetime-local input is local wall-clock with no zone. Convert to
        // an absolute UTC instant so the deadline means the same moment on every
        // subscriber's machine (the backend compares it as RFC 3339 / UTC).
        const d = new Date(deadline);
        if (!isNaN(d.getTime())) lifecycle.deadline = d.toISOString();
      }

      const respondents = expectedRespondents
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);

      const common = {
        mode,
        schema,
        visibility: visibility as WritebackRegionDeclaration["visibility"],
        submissionPolicy: submissionPolicy as WritebackRegionDeclaration["submissionPolicy"],
        versionBinding: versionBinding as WritebackRegionDeclaration["versionBinding"],
        lifecycle,
        aggregationHint: aggregationHint || undefined,
        expectedRespondents: respondents.length > 0 ? respondents : undefined,
      };

      if (editing) {
        // Preserve id + selector; replace the policy/schema fields.
        await updateWritebackRegion({ ...editing, ...common });
      } else {
        await addWritebackRegion({
          id: crypto.randomUUID(),
          selector: {
            sheetId: data!.sheetId!,
            rowStart: data!.startRow!,
            rowEnd: data!.endRow!,
            colStart: data!.startCol!,
            colEnd: data!.endCol!,
          },
          ...common,
        });
      }
      emitAppEvent(WRITEBACK_REGIONS_CHANGED_EVENT, {});
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [editing, data, mode, valueType, required, min, max, enumValues, customValidator, visibility, submissionPolicy, versionBinding, lifecyclePolicy, deadline, aggregationHint, expectedRespondents, onClose]);

  const sel = editing?.selector;
  const rangeLabel = editing
    ? `Row ${(sel!.rowStart) + 1}-${(sel!.rowEnd) + 1}, Col ${(sel!.colStart) + 1}-${(sel!.colEnd) + 1}`
    : data && data.startRow != null
      ? `Row ${data.startRow + 1}-${data.endRow! + 1}, Col ${data.startCol! + 1}-${data.endCol! + 1}`
      : "No range selected";

  // THE WINDOW. Fixed and centred like its neighbours, capped at 82vh, and a
  // flex column so the body below is the only thing that scrolls. No
  // `overflow: hidden` here on purpose: useDialogWindow's resize handles sit
  // 3px OUTSIDE the box and clipping them would cost the edges their grip.
  const windowStyle: React.CSSProperties = {
    position: "fixed",
    left: "50%",
    top: "12%",
    transform: "translateX(-50%)",
    // 620px, not the 720 the survey first proposed: seven short selects and
    // two text inputs do not fill 720, they just leave dead space on the right.
    width: dialogWidth(620),
    maxHeight: "82vh",
    zIndex: 1050,
    display: "flex",
    flexDirection: "column",
    background: "var(--panel-bg)",
    color: "var(--text-primary)",
    border: "1px solid var(--border-default)",
    borderRadius: "8px",
    boxShadow: "0 12px 40px rgba(0, 0, 0, 0.5)",
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    fontSize: "13px",
  };
  const headerStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
    padding: "8px 12px",
    flexShrink: 0,
    cursor: "grab",
    userSelect: "none",
    borderBottom: "1px solid var(--border-default)",
  };
  const closeButtonStyle: React.CSSProperties = {
    background: "transparent",
    border: "none",
    color: "var(--text-secondary)",
    cursor: "pointer",
    padding: "2px 8px",
    borderRadius: "4px",
    fontSize: "14px",
    lineHeight: 1,
  };
  const footerStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    padding: "10px 16px",
    flexShrink: 0,
    borderTop: "1px solid var(--border-default)",
  };
  const introStyle: React.CSSProperties = {
    margin: "0 0 4px 0",
    fontSize: 12,
    color: "var(--text-secondary)",
  };
  const sectionStyle: React.CSSProperties = { marginTop: 14 };

  return (
    <div ref={win.ref} style={{ ...windowStyle, ...win.style }}>
      <div style={headerStyle} onMouseDown={win.onHeaderMouseDown}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>
          {editing ? "Edit Writeback Region" : "Designate Writeback Region"}
        </h3>
        <button style={closeButtonStyle} onClick={onClose} aria-label="Close" title="Close">
          ✕
        </button>
      </div>

      {/* One pane, no companion — but the same DialogBody/DialogPane pair every
          other dialog uses, because the flex bookkeeping that makes an inner
          scroller work (`min-height: 0`) is exactly what was missing here. */}
      <DialogBody>
        <DialogPane scroll data-testid="designate-writeback-fields">
          {/* These three are about the REGION, not about any one field, so
              they stay full width above the grid. */}
          <p style={introStyle}>
            Range: <strong>{rangeLabel}</strong>
            {editing && <span style={{ opacity: 0.8 }}> (range can&apos;t be changed — remove &amp; re-designate to move it)</span>}
          </p>
          <p style={introStyle}>
            Subscribers will be able to input values into these cells after subscribing.
          </p>
          {/* MODE WAS A SELECT WITH ONE OPTION — a control that could not be
              changed, spending a row on it and, on a stored `list_object`
              region, showing a value it had no option for. It states the fact
              instead. */}
          <p style={{ ...introStyle, marginBottom: 12 }}>
            Mode: <strong>{mode === "per_subscriber" ? "Per Subscriber" : "List Object"}</strong>
          </p>

          {/* Three groups the code itself already implies: the schema fields
              feed ValueSchemaConfig, the lifecycle fields LifecyclePolicyConfig.
              `maxColumns` is passed EXPLICITLY — auto-fit alone would lay out
              THREE columns at this width and the form would read as noise. */}
          <DialogSection title="Value">
            <DialogFieldGrid maxColumns={2} minColumnWidth={240}>
              <Field label="Value Type">
                <select value={valueType} onChange={(e) => setValueType(e.target.value)} style={controlStyle}>
                  <option value="number">Number</option>
                  <option value="integer">Integer</option>
                  <option value="text">Text</option>
                  <option value="date">Date</option>
                  <option value="boolean">Boolean</option>
                  <option value="enum">Enum (list of values)</option>
                </select>
              </Field>

              {/* A checkbox carries its own label, so it borrows the label
                  row's height as padding and sits level with the select
                  beside it. */}
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  minWidth: 0,
                  padding: "5px 0",
                  marginTop: FIELD_LABEL_HEIGHT,
                }}
              >
                <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
                Required
              </label>

              {/* BOTH CONSTRAINT ROWS SPAN. valueType swaps one for the other,
                  and in an auto-fit grid a conditional that occupies a single
                  cell re-pairs every field after it — controls would jump
                  columns under the user's cursor. Spanning pins them. */}
              {(valueType === "number" || valueType === "integer") && (
                <DialogFieldSpan>
                  <div style={{ display: "flex", gap: 12 }}>
                    <Field label="Min" style={{ flex: "0 0 150px" }}>
                      <input type="number" value={min} onChange={(e) => setMin(e.target.value)} style={controlStyle} />
                    </Field>
                    <Field label="Max" style={{ flex: "0 0 150px" }}>
                      <input type="number" value={max} onChange={(e) => setMax(e.target.value)} style={controlStyle} />
                    </Field>
                  </div>
                </DialogFieldSpan>
              )}

              {valueType === "enum" && (
                <DialogFieldSpan>
                  <Field label="Allowed values (comma-separated)">
                    <input type="text" value={enumValues} onChange={(e) => setEnumValues(e.target.value)} style={controlStyle} />
                  </Field>
                </DialogFieldSpan>
              )}

              {listWritebackValidators().length > 0 && (
                <Field
                  label="Custom validator"
                  title="An advisory, subscriber-side check layered on the built-in schema. Extensions register these."
                >
                  <select value={customValidator} onChange={(e) => setCustomValidator(e.target.value)} style={controlStyle}>
                    <option value="">None</option>
                    {listWritebackValidators().map((v) => (
                      <option key={v.name} value={v.name}>{v.label}</option>
                    ))}
                  </select>
                </Field>
              )}
            </DialogFieldGrid>
          </DialogSection>

          <DialogSection title="Sharing" style={sectionStyle}>
            <DialogFieldGrid maxColumns={2} minColumnWidth={240}>
              <Field label="Visibility">
                <select value={visibility} onChange={(e) => setVisibility(e.target.value)} style={controlStyle}>
                  <option value="own_only">Own Only</option>
                  <option value="own_plus_aggregate">Own + Aggregate</option>
                  <option value="transparent">Transparent</option>
                </select>
              </Field>

              <Field label="Submission Policy">
                <select value={submissionPolicy} onChange={(e) => setSubmissionPolicy(e.target.value)} style={controlStyle}>
                  <option value="immediate">Immediate</option>
                  <option value="on_submit">On Submit</option>
                  <option value="on_approval">On Approval</option>
                </select>
              </Field>

              <Field label="Version Binding">
                <select value={versionBinding} onChange={(e) => setVersionBinding(e.target.value)} style={controlStyle}>
                  <option value="lenient">Lenient (carry forward)</option>
                  <option value="strict">Strict (require redo)</option>
                </select>
              </Field>
            </DialogFieldGrid>
          </DialogSection>

          <DialogSection title="Lifecycle" style={sectionStyle}>
            <DialogFieldGrid maxColumns={2} minColumnWidth={240}>
              <Field label="Lifecycle">
                <select value={lifecyclePolicy} onChange={(e) => setLifecyclePolicy(e.target.value)} style={controlStyle}>
                  <option value="always">Always re-editable</option>
                  <option value="until_deadline">Until Deadline</option>
                  <option value="never">One-shot</option>
                </select>
              </Field>

              {/* Spanned for the same reason the constraint rows are. */}
              {lifecyclePolicy === "until_deadline" && (
                <DialogFieldSpan>
                  <Field label="Deadline" style={{ maxWidth: 260 }}>
                    <input type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} style={controlStyle} />
                  </Field>
                </DialogFieldSpan>
              )}
            </DialogFieldGrid>
          </DialogSection>

          {/* Last, full width, and deliberately untitled: two free-text notes
              that belong to none of the three groups above. */}
          <DialogSection style={sectionStyle}>
            <DialogFieldGrid maxColumns={2} minColumnWidth={240}>
              <DialogFieldSpan>
                <Field label="Aggregation Hint (optional)">
                  <input type="text" value={aggregationHint} onChange={(e) => setAggregationHint(e.target.value)}
                    placeholder="e.g., SUM of regional forecasts" style={controlStyle} />
                </Field>
              </DialogFieldSpan>

              <DialogFieldSpan>
                <Field label="Expected respondents (optional, comma-separated)">
                  <input type="text" value={expectedRespondents} onChange={(e) => setExpectedRespondents(e.target.value)}
                    placeholder="e.g., Alice, Bob, finance@corp.com" style={controlStyle} />
                </Field>
              </DialogFieldSpan>
            </DialogFieldGrid>
          </DialogSection>
        </DialogPane>
      </DialogBody>

      {/* OUTSIDE THE SCROLLER, next to the button that refused. Inside it, the
          "validator is no longer registered" refusal could be scrolled out of
          sight while Designate Region just looked unresponsive. */}
      {error && (
        <div
          style={{
            flexShrink: 0,
            padding: "8px 16px",
            borderTop: "1px solid var(--border-default)",
            color: "var(--text-error, #d33)",
            fontSize: 12,
            lineHeight: 1.4,
          }}
        >
          {error}
        </div>
      )}

      <div style={footerStyle}>
        <button onClick={onClose}>Cancel</button>
        <button onClick={handleSave} disabled={submitting || (!editing && !data)}>
          {submitting
            ? (editing ? "Saving..." : "Designating...")
            : (editing ? "Save Changes" : "Designate Region")}
        </button>
      </div>

      {win.resizeHandles}
    </div>
  );
}
