// FILENAME: app/extensions/ModelEditor/components/sections/SettingsSection.tsx
// PURPOSE: Model settings section of the Model Editor window: mark the model's
//          date table (enables time-intelligence) and set the default lookup
//          resolution expression. Both are mutations that return a fresh
//          ModelOverview which is installed via ctx.applyOverview.

import React, { useEffect, useState } from "react";
import { biModelSetDateTable, biModelSetDefaultLookupResolution, biModelSetMetadata } from "@api";
import { Field, styles } from "../editorShared";
import type { SectionCtx } from "../editorShared";

export function SettingsSection({ ctx }: { ctx: SectionCtx }): React.ReactElement {
  const { connectionId, overview, readOnly, applyOverview, reportError } = ctx;
  const [busy, setBusy] = useState(false);
  const [lookupDraft, setLookupDraft] = useState(overview.defaultLookupResolution ?? "");

  // Descriptive metadata drafts (name/version/author/description).
  const [meta, setMeta] = useState({
    name: overview.modelName ?? "",
    version: overview.modelVersion ?? "",
    author: overview.modelAuthor ?? "",
    description: overview.modelDescription ?? "",
  });

  // Resync the lookup draft when the connection changes or the model's stored
  // value changes underneath us (e.g. another section's mutation refreshed the
  // overview). Kept simple: reset the draft to the incoming value.
  useEffect(() => {
    setLookupDraft(overview.defaultLookupResolution ?? "");
  }, [connectionId, overview.defaultLookupResolution]);

  // Resync metadata drafts when the connection changes or the stored values
  // change (only this section edits them, so an in-progress edit is not
  // clobbered by unrelated overview refreshes).
  useEffect(() => {
    setMeta({
      name: overview.modelName ?? "",
      version: overview.modelVersion ?? "",
      author: overview.modelAuthor ?? "",
      description: overview.modelDescription ?? "",
    });
  }, [
    connectionId,
    overview.modelName,
    overview.modelVersion,
    overview.modelAuthor,
    overview.modelDescription,
  ]);

  const applyMetadata = async () => {
    setBusy(true);
    try {
      applyOverview(
        await biModelSetMetadata({
          connectionId,
          name: meta.name.trim() || null,
          version: meta.version.trim() || null,
          author: meta.author.trim() || null,
          description: meta.description.trim() || null,
        }),
      );
    } catch (err: unknown) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };

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

      {/* Descriptive metadata */}
      <div style={styles.card}>
        <div style={{ ...styles.sectionTitle, fontSize: 13, marginBottom: 6 }}>Model metadata</div>
        <div style={{ display: "flex", gap: 10 }}>
          <Field label="Name" flex={1}>
            <input
              style={styles.input}
              disabled={disabled}
              value={meta.name}
              onChange={(e) => setMeta((m) => ({ ...m, name: e.target.value }))}
            />
          </Field>
          <Field label="Version" flex={1}>
            <input
              style={styles.input}
              disabled={disabled}
              value={meta.version}
              onChange={(e) => setMeta((m) => ({ ...m, version: e.target.value }))}
            />
          </Field>
        </div>
        <Field label="Author">
          <input
            style={styles.input}
            disabled={disabled}
            value={meta.author}
            onChange={(e) => setMeta((m) => ({ ...m, author: e.target.value }))}
          />
        </Field>
        <Field label="Description">
          <textarea
            style={{ ...styles.textarea, minHeight: 50 }}
            disabled={disabled}
            value={meta.description}
            onChange={(e) => setMeta((m) => ({ ...m, description: e.target.value }))}
          />
        </Field>
        <div>
          <button style={styles.btn} disabled={disabled} onClick={() => void applyMetadata()}>
            Save metadata
          </button>
        </div>
        <div style={{ ...styles.muted, fontSize: 12, marginTop: 4 }}>
          Descriptive only (no query effect); travels with the model when published as a dataset
          package.
        </div>
      </div>
    </div>
  );
}
