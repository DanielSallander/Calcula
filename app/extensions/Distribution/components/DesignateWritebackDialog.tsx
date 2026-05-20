// FILENAME: app/extensions/Distribution/components/DesignateWritebackDialog.tsx
// PURPOSE: Dialog for publisher to designate a range as a writeback region.
// CONTEXT: Opened from the Data menu or context menu on a selected range.

import React, { useState, useCallback } from "react";
import {
  addWritebackRegion,
  type WritebackRegionDeclaration,
  type ValueSchemaConfig,
  type LifecyclePolicyConfig,
} from "@api/distribution";

interface Props {
  onClose: () => void;
  data?: {
    sheetId: string;
    startRow: number;
    endRow: number;
    startCol: number;
    endCol: number;
  };
}

export function DesignateWritebackDialog({ onClose, data }: Props) {
  const [mode, setMode] = useState<"per_subscriber" | "list_object">("per_subscriber");
  const [valueType, setValueType] = useState<string>("number");
  const [required, setRequired] = useState(false);
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [enumValues, setEnumValues] = useState("");
  const [visibility, setVisibility] = useState<string>("own_plus_aggregate");
  const [submissionPolicy, setSubmissionPolicy] = useState<string>("on_submit");
  const [versionBinding, setVersionBinding] = useState<string>("lenient");
  const [lifecyclePolicy, setLifecyclePolicy] = useState<string>("always");
  const [deadline, setDeadline] = useState("");
  const [aggregationHint, setAggregationHint] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleDesignate = useCallback(async () => {
    if (!data) {
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
        lifecycle.deadline = deadline;
      }

      const id = crypto.randomUUID();

      const region: WritebackRegionDeclaration = {
        id,
        selector: {
          sheetId: data.sheetId,
          rowStart: data.startRow,
          rowEnd: data.endRow,
          colStart: data.startCol,
          colEnd: data.endCol,
        },
        mode,
        schema,
        visibility: visibility as WritebackRegionDeclaration["visibility"],
        submissionPolicy: submissionPolicy as WritebackRegionDeclaration["submissionPolicy"],
        versionBinding: versionBinding as WritebackRegionDeclaration["versionBinding"],
        lifecycle,
        aggregationHint: aggregationHint || undefined,
      };

      await addWritebackRegion(region);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [data, mode, valueType, required, min, max, enumValues, visibility, submissionPolicy, versionBinding, lifecyclePolicy, deadline, aggregationHint, onClose]);

  const rangeLabel = data
    ? `Row ${data.startRow + 1}-${data.endRow + 1}, Col ${data.startCol + 1}-${data.endCol + 1}`
    : "No range selected";

  return (
    <div style={{ padding: 16, minWidth: 400 }}>
      <h3 style={{ marginTop: 0 }}>Designate Writeback Region</h3>
      <p style={{ fontSize: 12, color: "#666" }}>
        Range: <strong>{rangeLabel}</strong>
      </p>
      <p style={{ fontSize: 12, color: "#666" }}>
        Subscribers will be able to input values into these cells after subscribing.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <label>
          Mode:
          <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} style={{ marginLeft: 8 }}>
            <option value="per_subscriber">Per Subscriber</option>
            <option value="list_object">List Object</option>
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
            <option value="requires_unlock">Requires Unlock</option>
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
      </div>

      {error && <div style={{ color: "red", marginTop: 8, fontSize: 12 }}>{error}</div>}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        <button onClick={onClose}>Cancel</button>
        <button onClick={handleDesignate} disabled={submitting || !data}>
          {submitting ? "Designating..." : "Designate Region"}
        </button>
      </div>
    </div>
  );
}
