//! FILENAME: app/extensions/BuiltIn/ObjectPane/components/cards/DataFormatCard.tsx
// PURPOSE: The Format tab's Data format card: one row per value field of the
//          object (a pivot's value fields, a design-query chart's measures),
//          each an Excel number-format code -- a preset or custom text -- with a
//          preview of 1234.5 beside it, and "Use source format".
// CONTEXT: The family owns the fields and the write (`dataFormats` /
//          `setDataFormat` on its @api/objectFormat provider): a pivot writes
//          `ValueField.number_format`, a chart `spec.fieldFormats`. `format` is
//          the USER override only; null means "the source's", whose code
//          (`sourceFormat`, e.g. the model measure's) is the placeholder.
//          "Use source format" sets null. The preview is Rust's own formatter
//          (`previewNumberFormat`, @api/numberFormats), so what the row shows
//          is what a cell with that code shows.

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { DataFormatField } from "@api/objectFormat";
import { previewNumberFormat } from "@api/numberFormats";
import { showToast } from "@api/notifications";
import { useFormatContext } from "../formatContext";
import { DATA_FORMAT_PRESETS, DATA_FORMAT_SAMPLE } from "../../lib/formatValues";
import { TextBox } from "../fields/TextField";
import { SelectBox } from "../fields/SelectField";
import { PlainRow } from "../fields/FormatRow";
import { FormatCard } from "./FormatCard";
import { paneStyles } from "../paneStyles";

/** The combo's value for "type your own code". */
const CUSTOM = "__custom__";
/** The combo's value for "the source's format" (no override). */
const SOURCE = "__source__";

/** The sentence a refused data-format write leads with. */
export const DATA_FORMAT_REFUSED = "The number format could not be set.";

function FormatPreview({ code }: { code: string | null }): React.ReactElement | null {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (!code) {
      setText(null);
      return;
    }
    previewNumberFormat(code, DATA_FORMAT_SAMPLE)
      .then((r) => {
        if (live) setText(r.display);
      })
      .catch(() => {
        if (live) setText(null);
      });
    return () => {
      live = false;
    };
  }, [code]);
  if (text === null) return null;
  return (
    <span style={paneStyles.muted} data-testid="format-data-preview">
      {text}
    </span>
  );
}

function DataFormatRow({
  field,
  disabled,
  onSet,
}: {
  field: DataFormatField;
  disabled: boolean;
  onSet: (format: string | null) => Promise<void>;
}): React.ReactElement {
  const preset = field.format === null ? SOURCE : DATA_FORMAT_PRESETS.includes(field.format) ? field.format : CUSTOM;
  const [mode, setMode] = useState<string>(preset);
  useEffect(() => setMode(preset), [preset]);

  const options: Array<readonly [string, string]> = [
    [SOURCE, field.sourceFormat ? `Source (${field.sourceFormat})` : "Source format"],
    ...DATA_FORMAT_PRESETS.map((p) => [p, p] as const),
    [CUSTOM, "Custom..."],
  ];

  return (
    <PlainRow fieldId={`dataFormat.${field.key}`} label={field.label}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <SelectBox
          value={mode}
          options={options}
          disabled={disabled}
          ariaLabel={`${field.label} number format`}
          testId={`format-data-${field.key}`}
          onCommit={(v) => {
            setMode(v);
            if (v === CUSTOM) return;
            void onSet(v === SOURCE ? null : v);
          }}
        />
        {mode === CUSTOM && (
          <TextBox
            value={field.format ?? ""}
            placeholder={field.sourceFormat ?? "Excel format code"}
            disabled={disabled}
            ariaLabel={`${field.label} custom number format`}
            testId={`format-data-${field.key}-code`}
            onCommit={(code) => void onSet(code.trim() === "" ? null : code.trim())}
          />
        )}
        <div style={paneStyles.inline}>
          <FormatPreview code={field.format ?? field.sourceFormat} />
          {field.format !== null && (
            <button
              type="button"
              style={paneStyles.smallButton}
              disabled={disabled}
              data-testid={`format-data-${field.key}-source`}
              onClick={() => void onSet(null)}
            >
              Use source format
            </button>
          )}
        </div>
      </div>
    </PlainRow>
  );
}

export function DataFormatCard(): React.ReactElement | null {
  const ctx = useFormatContext();
  const { region, provider, readOnly } = ctx;
  const [fields, setFields] = useState<DataFormatField[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  // Re-load when the OBJECT changes, not on every re-publish of its region.
  const regionRef = useRef(region);
  regionRef.current = region;
  const regionId = region.id;

  const load = useCallback(async () => {
    const mine = ++seq.current;
    if (!provider?.dataFormats || !regionId) {
      setFields([]);
      return;
    }
    try {
      const next = await provider.dataFormats(regionRef.current);
      if (mine === seq.current) {
        setFields(next);
        setError(null);
      }
    } catch (err) {
      if (mine === seq.current) {
        setFields([]);
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }, [provider, regionId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!ctx.snapshot?.capabilities.dataFormat || !provider?.dataFormats || !provider.setDataFormat) return null;

  const set = async (key: string, format: string | null): Promise<void> => {
    if (readOnly) return;
    try {
      await provider.setDataFormat!(region, key, format);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      showToast(`${DATA_FORMAT_REFUSED} ${why}`, { type: "error" });
    }
    await load();
  };

  return (
    <FormatCard id="dataFormat" title="Data format">
      {fields === null && <div style={paneStyles.muted}>Loading...</div>}
      {fields !== null && fields.length === 0 && (
        <div style={paneStyles.muted}>{error ?? "This object has no values to format."}</div>
      )}
      {fields?.map((field) => (
        <DataFormatRow key={field.key} field={field} disabled={readOnly} onSet={(format) => set(field.key, format)} />
      ))}
    </FormatCard>
  );
}
