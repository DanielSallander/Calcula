// FILENAME: app/extensions/Distribution/components/DesignateWritebackDialog.tsx
// PURPOSE: Dialog to designate a range as a writeback region (add), or edit an
//          existing draft region's policies/schema in place (edit).
// CONTEXT: Opened from the Data menu / context menu on a selected range (add),
//          or from the WritebackPane "Edit" button on a draft region (edit).

import React, { useState, useCallback } from "react";
import { emitAppEvent } from "@api";
import {
  addWritebackRegion,
  updateWritebackRegion,
  type WritebackRegionDeclaration,
  type ValueSchemaConfig,
  type LifecyclePolicyConfig,
} from "@api/distribution";

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

export function DesignateWritebackDialog({ onClose, data }: Props) {
  const editing = data?.region;
  const s = editing?.schema;
  const lc = editing?.lifecycle;

  const [mode, setMode] = useState<"per_subscriber" | "list_object">(
    (editing?.mode as "per_subscriber" | "list_object") ?? "per_subscriber",
  );
  const [valueType, setValueType] = useState<string>(s?.valueType ?? "number");
  const [required, setRequired] = useState(s?.required ?? false);
  const [min, setMin] = useState(s?.min != null ? String(s.min) : "");
  const [max, setMax] = useState(s?.max != null ? String(s.max) : "");
  const [enumValues, setEnumValues] = useState((s?.enumValues ?? []).join(", "));
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
  }, [editing, data, mode, valueType, required, min, max, enumValues, visibility, submissionPolicy, versionBinding, lifecyclePolicy, deadline, aggregationHint, expectedRespondents, onClose]);

  const sel = editing?.selector;
  const rangeLabel = editing
    ? `Row ${(sel!.rowStart) + 1}-${(sel!.rowEnd) + 1}, Col ${(sel!.colStart) + 1}-${(sel!.colEnd) + 1}`
    : data && data.startRow != null
      ? `Row ${data.startRow + 1}-${data.endRow! + 1}, Col ${data.startCol! + 1}-${data.endCol! + 1}`
      : "No range selected";

  return (
    <div style={{ padding: 16, minWidth: 400 }}>
      <h3 style={{ marginTop: 0 }}>{editing ? "Edit Writeback Region" : "Designate Writeback Region"}</h3>
      <p style={{ fontSize: 12, color: "#666" }}>
        Range: <strong>{rangeLabel}</strong>
        {editing && <span style={{ color: "#888" }}> (range can't be changed — remove &amp; re-designate to move it)</span>}
      </p>
      <p style={{ fontSize: 12, color: "#666" }}>
        Subscribers will be able to input values into these cells after subscribing.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <label>
          Mode:
          <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} style={{ marginLeft: 8 }}>
            <option value="per_subscriber">Per Subscriber</option>
          </select>
        </label>

        <label>
          Value Type:
          <select value={valueType} onChange={(e) => setValueType(e.target.value)} style={{ marginLeft: 8 }}>
            <option value="number">Number</option>
            <option value="integer">Integer</option>
            <option value="text">Text</option>
            <option value="date">Date</option>
            <option value="boolean">Boolean</option>
            <option value="enum">Enum (list of values)</option>
          </select>
        </label>

        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
          Required
        </label>

        {(valueType === "number" || valueType === "integer") && (
          <div style={{ display: "flex", gap: 8 }}>
            <label>Min: <input type="number" value={min} onChange={(e) => setMin(e.target.value)} style={{ width: 80 }} /></label>
            <label>Max: <input type="number" value={max} onChange={(e) => setMax(e.target.value)} style={{ width: 80 }} /></label>
          </div>
        )}

        {valueType === "enum" && (
          <label>
            Allowed values (comma-separated):
            <input type="text" value={enumValues} onChange={(e) => setEnumValues(e.target.value)} style={{ width: "100%" }} />
          </label>
        )}

        <label>
          Visibility:
          <select value={visibility} onChange={(e) => setVisibility(e.target.value)} style={{ marginLeft: 8 }}>
            <option value="own_only">Own Only</option>
            <option value="own_plus_aggregate">Own + Aggregate</option>
            <option value="transparent">Transparent</option>
          </select>
        </label>

        <label>
          Submission Policy:
          <select value={submissionPolicy} onChange={(e) => setSubmissionPolicy(e.target.value)} style={{ marginLeft: 8 }}>
            <option value="immediate">Immediate</option>
            <option value="on_submit">On Submit</option>
            <option value="on_approval">On Approval</option>
          </select>
        </label>

        <label>
          Version Binding:
          <select value={versionBinding} onChange={(e) => setVersionBinding(e.target.value)} style={{ marginLeft: 8 }}>
            <option value="lenient">Lenient (carry forward)</option>
            <option value="strict">Strict (require redo)</option>
          </select>
        </label>

        <label>
          Lifecycle:
          <select value={lifecyclePolicy} onChange={(e) => setLifecyclePolicy(e.target.value)} style={{ marginLeft: 8 }}>
            <option value="always">Always re-editable</option>
            <option value="until_deadline">Until Deadline</option>
            <option value="never">One-shot</option>
          </select>
        </label>

        {lifecyclePolicy === "until_deadline" && (
          <label>
            Deadline:
            <input type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} style={{ marginLeft: 8 }} />
          </label>
        )}

        <label>
          Aggregation Hint (optional):
          <input type="text" value={aggregationHint} onChange={(e) => setAggregationHint(e.target.value)}
            placeholder="e.g., SUM of regional forecasts" style={{ width: "100%" }} />
        </label>

        <label>
          Expected respondents (optional, comma-separated):
          <input type="text" value={expectedRespondents} onChange={(e) => setExpectedRespondents(e.target.value)}
            placeholder="e.g., Alice, Bob, finance@corp.com" style={{ width: "100%" }} />
        </label>
      </div>

      {error && <div style={{ color: "red", marginTop: 8, fontSize: 12 }}>{error}</div>}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        <button onClick={onClose}>Cancel</button>
        <button onClick={handleSave} disabled={submitting || (!editing && !data)}>
          {submitting
            ? (editing ? "Saving..." : "Designating...")
            : (editing ? "Save Changes" : "Designate Region")}
        </button>
      </div>
    </div>
  );
}
