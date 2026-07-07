// FILENAME: app/extensions/ModelEditor/components/sections/SettingsSection.tsx
// PURPOSE: Model settings section of the Model Editor window: mark the model's
//          date table (enables time-intelligence) and set the default lookup
//          resolution expression. Both are mutations that return a fresh
//          ModelOverview which is installed via ctx.applyOverview.

import React, { useEffect, useState } from "react";
import { biModelSetDateTable, biModelSetDefaultLookupResolution } from "@api";
import { Field, styles } from "../editorShared";
import type { SectionCtx } from "../editorShared";

export function SettingsSection({ ctx }: { ctx: SectionCtx }): React.ReactElement {
  const { connectionId, overview, readOnly, applyOverview, reportError } = ctx;
  const [busy, setBusy] = useState(false);
  const [lookupDraft, setLookupDraft] = useState(overview.defaultLookupResolution ?? "");

  // Resync the lookup draft when the connection changes or the model's stored
  // value changes underneath us (e.g. another section's mutation refreshed the
  // overview). Kept simple: reset the draft to the incoming value.
  useEffect(() => {
    setLookupDraft(overview.defaultLookupResolution ?? "");
  }, [connectionId, overview.defaultLookupResolution]);

  const handleDateTableChange = async (value: string) => {
    setBusy(true);
    try {
      applyOverview(await biModelSetDateTable(connectionId, value || null));
    } catch (err: unknown) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };

  const handleApplyLookup = async () => {
    setBusy(true);
    try {
      applyOverview(
        await biModelSetDefaultLookupResolution(connectionId, lookupDraft.trim() || null),
      );
    } catch (err: unknown) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };

  const disabled = readOnly || busy;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1, minHeight: 0 }}>
      <div style={styles.sectionHeader}>
        <span style={styles.sectionTitle}>Model Settings</span>
      </div>

      <div style={{ ...styles.card, flex: 1, overflowY: "auto" }}>
        <Field
          label="Date table"
          hint="Marking a date table enables time-intelligence (YTD/QTD/PRIORYEAR) over its date-role columns."
        >
          <select
            style={styles.input}
            disabled={disabled}
            value={overview.dateTable ?? ""}
            onChange={(e) => void handleDateTableChange(e.target.value)}
          >
            <option value="">(none)</option>
            {overview.tables.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Default lookup resolution"
          hint="Expression used to resolve a lookup column when it has no per-column resolution (defaults to MIN)."
        >
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              style={{ ...styles.input, flex: 1, minWidth: 0 }}
              disabled={disabled}
              value={lookupDraft}
              onChange={(e) => setLookupDraft(e.target.value)}
              placeholder="MIN"
            />
            <button
              style={styles.btn}
              disabled={disabled}
              onClick={() => void handleApplyLookup()}
            >
              Apply
            </button>
          </div>
        </Field>

        <div style={{ ...styles.muted, fontSize: 12, marginTop: 4 }}>
          Cache/refresh settings (memory budget, storage-mode scheduling, incremental
          refresh) are managed by the engine runtime and are not part of the
          embedded-model editor.
        </div>
      </div>
    </div>
  );
}
