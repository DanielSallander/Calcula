// FILENAME: app/extensions/ModelEditor/components/sections/KpisSection.tsx
// PURPOSE: KPIs section of the Model Editor window: list model KPIs and
//          add/edit/delete them (base measure, measure-or-constant target,
//          ascending status bands, description).

import React, { useState } from "react";
import { biModelDeleteKpi, biModelUpsertKpi } from "@api";
import type { ModelKpiInfo, ModelOverview } from "@api";
import { Field, Modal, styles } from "../editorShared";
import type { SectionCtx } from "../editorShared";

const KPI_STATUSES = [
  { value: "offTrack", label: "Off track" },
  { value: "atRisk", label: "At risk" },
  { value: "onTrack", label: "On track" },
];

export function KpisSection({ ctx }: { ctx: SectionCtx }): React.ReactElement {
  const { connectionId, overview, readOnly, applyOverview, reportError } = ctx;
  const [editing, setEditing] = useState<{ original: ModelKpiInfo | null } | null>(null);

  const handleDelete = async (k: ModelKpiInfo) => {
    if (!window.confirm(`Delete KPI '${k.name}'?`)) return;
    try {
      applyOverview(await biModelDeleteKpi(connectionId, k.name));
    } catch (err: unknown) {
      reportError(err);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1, minHeight: 0 }}>
      <div style={styles.sectionHeader}>
        <span style={styles.sectionTitle}>KPIs ({overview.kpis.length})</span>
        <button style={styles.btn} disabled={readOnly} onClick={() => setEditing({ original: null })}>
          New
        </button>
      </div>
      <div style={{ ...styles.card, flex: 1, overflowY: "auto", padding: 4 }}>
        {overview.kpis.length === 0 && (
          <div style={{ ...styles.muted, padding: 8 }}>No KPIs defined — create one with New.</div>
        )}
        {overview.kpis.map((k) => (
          <div
            key={k.name}
            style={{ ...styles.listRow, cursor: "default", display: "flex", alignItems: "center", gap: 8 }}
            title={k.description ?? undefined}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div>
                <strong>{k.name}</strong>
              </div>
              <div
                style={{
                  ...styles.muted,
                  fontSize: 12,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                Base: {k.baseMeasure} · Target:{" "}
                {k.targetMeasure ?? (k.targetConstant !== null ? String(k.targetConstant) : "(none)")} ·{" "}
                {k.statusBands.length} band{k.statusBands.length === 1 ? "" : "s"}
              </div>
            </div>
            <button style={styles.smallBtn} disabled={readOnly} onClick={() => setEditing({ original: k })}>
              Edit
            </button>
            <button style={styles.smallBtn} disabled={readOnly} onClick={() => void handleDelete(k)}>
              Delete
            </button>
          </div>
        ))}
      </div>

      {editing && (
        <KpiModal
          connectionId={connectionId}
          overview={overview}
          original={editing.original}
          onClose={() => setEditing(null)}
          onSaved={(o) => {
            applyOverview(o);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

// ============================================================================
// Add/edit modal
// ============================================================================

interface BandDraft {
  threshold: string;
  status: string;
}

function KpiModal({
  connectionId,
  overview,
  original,
  onClose,
  onSaved,
}: {
  connectionId: string;
  overview: ModelOverview;
  original: ModelKpiInfo | null;
  onClose: () => void;
  onSaved: (overview: ModelOverview) => void;
}): React.ReactElement {
  const measureNames = overview.measures.map((m) => m.name);

  const [name, setName] = useState(original?.name ?? "");
  const [baseMeasure, setBaseMeasure] = useState(original?.baseMeasure ?? "");
  const [targetKind, setTargetKind] = useState<"measure" | "constant">(
    original && original.targetConstant !== null && original.targetMeasure === null
      ? "constant"
      : "measure",
  );
  const [targetMeasure, setTargetMeasure] = useState(original?.targetMeasure ?? "");
  const [targetConstant, setTargetConstant] = useState(
    original?.targetConstant !== null && original?.targetConstant !== undefined
      ? String(original.targetConstant)
      : "",
  );
  const [bands, setBands] = useState<BandDraft[]>(
    original
      ? original.statusBands.map((b) => ({ threshold: String(b.threshold), status: b.status }))
      : [],
  );
  const [description, setDescription] = useState(original?.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateBand = (index: number, patch: Partial<BandDraft>) => {
    setBands((bs) => bs.map((b, i) => (i === index ? { ...b, ...patch } : b)));
  };

  const targetOk =
    targetKind === "measure"
      ? targetMeasure !== ""
      : targetConstant.trim() !== "" && Number.isFinite(Number(targetConstant));
  const bandsOk = bands.every(
    (b) => b.threshold.trim() !== "" && Number.isFinite(Number(b.threshold)),
  );
  const canSave = name.trim() !== "" && baseMeasure !== "" && targetOk && bandsOk;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await biModelUpsertKpi({
          connectionId,
          originalName: original?.name ?? null,
          name: name.trim(),
          baseMeasure,
          targetMeasure: targetKind === "measure" ? targetMeasure : null,
          targetConstant: targetKind === "constant" ? Number(targetConstant) : null,
          statusBands: bands.map((b) => ({ threshold: Number(b.threshold), status: b.status })),
          description: description.trim() || null,
        }),
      );
    } catch (err: unknown) {
      setError(String(err));
      setBusy(false);
    }
  };

  const radioRow = (kind: "measure" | "constant", label: string, control: React.ReactNode) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
      <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, width: 90 }}>
        <input
          type="radio"
          name="kpi-target"
          checked={targetKind === kind}
          onChange={() => setTargetKind(kind)}
        />
        {label}
      </label>
      {control}
    </div>
  );

  return (
    <Modal
      title={original ? `Edit KPI: ${original.name}` : "New KPI"}
      width={560}
      onClose={onClose}
      footer={
        <>
          <button style={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button style={styles.primaryBtn} disabled={busy || !canSave} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div style={{ display: "flex", gap: 8 }}>
        <Field label="Name" flex={1}>
          <input
            style={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Revenue vs Target"
          />
        </Field>
        <Field label="Base measure" flex={1}>
          <select
            style={styles.input}
            value={baseMeasure}
            onChange={(e) => setBaseMeasure(e.target.value)}
          >
            <option value="">(select measure)</option>
            {measureNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div style={styles.field}>
        <label style={styles.label}>Target</label>
        {radioRow(
          "measure",
          "Measure",
          <select
            style={{ ...styles.input, flex: 1 }}
            disabled={targetKind !== "measure"}
            value={targetMeasure}
            onChange={(e) => setTargetMeasure(e.target.value)}
          >
            <option value="">(select measure)</option>
            {measureNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>,
        )}
        {radioRow(
          "constant",
          "Constant",
          <input
            type="number"
            style={{ ...styles.input, flex: 1 }}
            disabled={targetKind !== "constant"}
            value={targetConstant}
            onChange={(e) => setTargetConstant(e.target.value)}
            placeholder="1000000"
          />,
        )}
      </div>

      <div style={styles.field}>
        <label style={styles.label}>Status bands</label>
        {bands.map((b, i) => (
          <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="number"
              style={{ ...styles.input, width: 140 }}
              value={b.threshold}
              onChange={(e) => updateBand(i, { threshold: e.target.value })}
              placeholder="Threshold"
            />
            <select
              style={{ ...styles.input, flex: 1 }}
              value={b.status}
              onChange={(e) => updateBand(i, { status: e.target.value })}
            >
              {KPI_STATUSES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <button style={styles.smallBtn} onClick={() => setBands((bs) => bs.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
        ))}
        <div>
          <button
            style={styles.smallBtn}
            onClick={() => setBands((bs) => [...bs, { threshold: "", status: "offTrack" }])}
          >
            Add band
          </button>
        </div>
        <div style={styles.hint}>
          List bands in ascending threshold order — the band whose threshold the
          KPI value passes last determines the status.
        </div>
      </div>

      <Field label="Description (optional)">
        <input
          style={styles.input}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      {error && <div style={{ color: "red", marginBottom: 8, fontSize: 12 }}>{error}</div>}
    </Modal>
  );
}
