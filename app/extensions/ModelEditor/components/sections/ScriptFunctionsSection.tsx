// FILENAME: app/extensions/ModelEditor/components/sections/ScriptFunctionsSection.tsx
// PURPOSE: Script functions section of the Model Editor window: list sandboxed
//          Rhai UDFs and add/edit/delete them (name, typed parameter list,
//          return type, Rhai body).

import React, { useState } from "react";
import { biModelDeleteScriptFunction, biModelUpsertScriptFunction } from "@api";
import type { ModelOverview, ModelScriptFunctionInfo, ScriptParamDto } from "@api";
import { Field, Modal, styles } from "../editorShared";
import type { SectionCtx } from "../editorShared";

const PARAM_TYPES = ["Int", "Float", "Bool", "String"];

const signatureOf = (fn: ModelScriptFunctionInfo): string => {
  const params = fn.params.map((p) => `${p.name}: ${p.ty}`).join(", ");
  return `(${params}) -> ${fn.returnType}`;
};

export function ScriptFunctionsSection({ ctx }: { ctx: SectionCtx }): React.ReactElement {
  const { connectionId, overview, readOnly, applyOverview, reportError } = ctx;
  const [editing, setEditing] = useState<{ original: ModelScriptFunctionInfo | null } | null>(null);

  const handleDelete = async (fn: ModelScriptFunctionInfo) => {
    if (!window.confirm(`Delete script function '${fn.name}'?`)) return;
    try {
      applyOverview(await biModelDeleteScriptFunction(connectionId, fn.name));
    } catch (err: unknown) {
      reportError(err);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1, minHeight: 0 }}>
      <div style={styles.sectionHeader}>
        <span style={styles.sectionTitle}>Script Functions ({overview.scriptFunctions.length})</span>
        <button style={styles.btn} disabled={readOnly} onClick={() => setEditing({ original: null })}>
          New
        </button>
      </div>
      <div style={{ ...styles.card, flex: 1, overflowY: "auto", padding: 4 }}>
        {overview.scriptFunctions.length === 0 && (
          <div style={{ ...styles.muted, padding: 8 }}>
            No script functions defined — create one with New.
          </div>
        )}
        {overview.scriptFunctions.map((fn) => (
          <div
            key={fn.name}
            style={{ ...styles.listRow, cursor: "default", display: "flex", alignItems: "center", gap: 8 }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div>
                <strong>{fn.name}</strong>
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
                {signatureOf(fn)}
              </div>
            </div>
            <button style={styles.smallBtn} disabled={readOnly} onClick={() => setEditing({ original: fn })}>
              Edit
            </button>
            <button style={styles.smallBtn} disabled={readOnly} onClick={() => void handleDelete(fn)}>
              Delete
            </button>
          </div>
        ))}
      </div>

      {editing && (
        <ScriptFunctionModal
          connectionId={connectionId}
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

interface ParamDraft {
  name: string;
  ty: string;
}

function ScriptFunctionModal({
  connectionId,
  original,
  onClose,
  onSaved,
}: {
  connectionId: string;
  original: ModelScriptFunctionInfo | null;
  onClose: () => void;
  onSaved: (overview: ModelOverview) => void;
}): React.ReactElement {
  const [name, setName] = useState(original?.name ?? "");
  const [params, setParams] = useState<ParamDraft[]>(
    original && original.params.length > 0
      ? original.params.map((p) => ({ name: p.name, ty: p.ty }))
      : [{ name: "", ty: "Float" }],
  );
  const [returnType, setReturnType] = useState(original?.returnType ?? "Float");
  const [body, setBody] = useState(original?.body ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateParam = (index: number, patch: Partial<ParamDraft>) => {
    setParams((ps) => ps.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  };

  const canSave =
    name.trim() !== "" &&
    params.length >= 1 &&
    params.every((p) => p.name.trim() !== "") &&
    body.trim() !== "";

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const dto: ScriptParamDto[] = params.map((p) => ({ name: p.name.trim(), ty: p.ty }));
      onSaved(
        await biModelUpsertScriptFunction({
          connectionId,
          originalName: original?.name ?? null,
          name: name.trim(),
          params: dto,
          returnType,
          body,
        }),
      );
    } catch (err: unknown) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={original ? `Edit Script Function: ${original.name}` : "New Script Function"}
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
      <Field label="Name">
        <input
          style={styles.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="grossMargin"
        />
      </Field>

      <div style={styles.field}>
        <label style={styles.label}>Parameters</label>
        {params.map((p, i) => (
          <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              style={{ ...styles.input, flex: 1, minWidth: 0 }}
              value={p.name}
              onChange={(e) => updateParam(i, { name: e.target.value })}
              placeholder="cost"
            />
            <select
              style={{ ...styles.input, width: 120, flexShrink: 0 }}
              value={p.ty}
              onChange={(e) => updateParam(i, { ty: e.target.value })}
            >
              {PARAM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <button style={styles.smallBtn} onClick={() => setParams((ps) => ps.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
        ))}
        <div>
          <button
            style={styles.smallBtn}
            onClick={() => setParams((ps) => [...ps, { name: "", ty: "Float" }])}
          >
            Add parameter
          </button>
        </div>
        <div style={styles.hint}>A UDF must declare at least one parameter.</div>
      </div>

      <Field label="Return type">
        <select
          style={styles.input}
          value={returnType}
          onChange={(e) => setReturnType(e.target.value)}
        >
          {PARAM_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Body">
        <textarea
          style={styles.textarea}
          rows={8}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="cost * rate"
        />
      </Field>
      <div style={styles.hint}>
        Rhai expression or block; the parameters are in scope. e.g. cost * rate
      </div>
      {error && <div style={{ color: "red", marginBottom: 8, fontSize: 12 }}>{error}</div>}
    </Modal>
  );
}
