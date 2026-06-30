//! FILENAME: app/extensions/Animation/components/AnimationDialog.tsx
// PURPOSE: Create / edit a saved AnimationSpec (name + clock-cell driver + fps +
//          loop). Saving persists it (animationStore) and loads it into the engine
//          so the user can immediately play it.
// DATA: opened via showDialog("animation.editor", { editingId? , prefill? }).
import React, { useEffect, useState } from "react";
import type { DialogProps } from "@api/uiTypes";
import { getActiveSheet } from "@api/lib";
import { parseA1, toA1 } from "../lib/a1";
import { getAnimation, upsertAnimation, newAnimationId } from "../lib/animationStore";
import { playbackEngine } from "../lib/animationEngine";
import type { AnimationSpec } from "../types";

/** Dialog id shared by the registration (index.ts) and the openers (panel). */
export const ANIMATION_DIALOG_ID = "animation.editor";

const backdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.35)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};
const dialog: React.CSSProperties = {
  width: 380,
  background: "var(--panel-bg, #fff)",
  color: "var(--text-color, #1a1a1a)",
  borderRadius: 8,
  boxShadow: "0 8px 32px rgba(0,0,0,0.25)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};
const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "10px 14px",
  borderBottom: "1px solid var(--border-color, #e0e0e0)",
  fontWeight: 600,
};
const body: React.CSSProperties = { padding: 14, display: "flex", flexDirection: "column", gap: 10, fontSize: 12 };
const footer: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  padding: "10px 14px",
  borderTop: "1px solid var(--border-color, #e0e0e0)",
};
const field: React.CSSProperties = {
  width: "100%",
  height: 26,
  boxSizing: "border-box",
  padding: "0 8px",
  border: "1px solid var(--border-color, #d0d0d0)",
  borderRadius: 4,
};
const labelStyle: React.CSSProperties = { fontSize: 11, opacity: 0.75, marginBottom: 3 };
const button: React.CSSProperties = {
  height: 28,
  padding: "0 14px",
  border: "1px solid var(--border-color, #d0d0d0)",
  borderRadius: 4,
  background: "var(--button-bg, #fff)",
  cursor: "pointer",
};
const primary: React.CSSProperties = {
  ...button,
  background: "var(--accent-color, #217346)",
  borderColor: "var(--accent-color, #217346)",
  color: "#fff",
};

export function AnimationDialog({ isOpen, onClose, data }: DialogProps): React.ReactElement | null {
  const editingId = typeof data?.editingId === "string" ? data.editingId : null;

  const [name, setName] = useState("");
  const [cellRef, setCellRef] = useState("B1");
  const [fromStr, setFromStr] = useState("0");
  const [toStr, setToStr] = useState("100");
  const [stepStr, setStepStr] = useState("1");
  const [fpsStr, setFpsStr] = useState("12");
  const [loop, setLoop] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    const existing = editingId ? getAnimation(editingId) : undefined;
    if (existing?.clockCell) {
      setName(existing.name);
      setCellRef(toA1(existing.clockCell.row, existing.clockCell.col));
      setFromStr(String(existing.clockCell.from));
      setToStr(String(existing.clockCell.to));
      setStepStr(String(existing.clockCell.step));
      setFpsStr(String(existing.playback.fps));
      setLoop(existing.playback.loop);
      return;
    }
    const p = (data?.prefill ?? {}) as Record<string, unknown>;
    setName(typeof p.name === "string" ? p.name : "");
    setCellRef(typeof p.cellRef === "string" ? p.cellRef : "B1");
    setFromStr(p.from != null ? String(p.from) : "0");
    setToStr(p.to != null ? String(p.to) : "100");
    setStepStr(p.step != null ? String(p.step) : "1");
    setFpsStr(p.fps != null ? String(p.fps) : "12");
    setLoop(p.loop === true);
  }, [isOpen, editingId, data]);

  if (!isOpen) return null;

  const handleSave = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required");
      return;
    }
    const parsed = parseA1(cellRef);
    if (!parsed) {
      setError("Driver cell must be like B1");
      return;
    }
    const from = Number(fromStr);
    const to = Number(toStr);
    const step = Number(stepStr);
    const fps = Number(fpsStr);
    if (![from, to, step, fps].every(Number.isFinite) || step === 0) {
      setError("From / To / Step / fps must be numbers and Step ≠ 0");
      return;
    }
    setError(null);
    const existing = editingId ? getAnimation(editingId) : undefined;
    const sheetIndex = existing ? existing.sheetIndex : await getActiveSheet();
    const spec: AnimationSpec = {
      id: editingId ?? newAnimationId(),
      name: trimmed,
      sheetIndex,
      driver: "clockCell",
      playback: { fps: Math.max(1, Math.min(120, Math.round(fps))), loop },
      clockCell: { row: parsed.row, col: parsed.col, from, to, step },
    };
    await upsertAnimation(spec);
    await playbackEngine.loadSpec(spec);
    onClose();
  };

  return (
    <div style={backdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div style={dialog}>
        <div style={header}>
          <span>{editingId ? "Edit animation" : "New animation"}</span>
          <button style={{ ...button, height: 24, padding: "0 8px" }} onClick={onClose}>
            ✕
          </button>
        </div>
        <div style={body}>
          <div>
            <div style={labelStyle}>Name</div>
            <input style={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Revenue ramp" />
          </div>
          <div>
            <div style={labelStyle}>Driver cell</div>
            <input style={field} value={cellRef} onChange={(e) => setCellRef(e.target.value)} placeholder="B1" />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 1 }}>
              <div style={labelStyle}>From</div>
              <input style={field} value={fromStr} onChange={(e) => setFromStr(e.target.value)} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={labelStyle}>To</div>
              <input style={field} value={toStr} onChange={(e) => setToStr(e.target.value)} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={labelStyle}>Step</div>
              <input style={field} value={stepStr} onChange={(e) => setStepStr(e.target.value)} />
            </div>
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <div>
              <div style={labelStyle}>fps</div>
              <input
                style={{ ...field, width: 70 }}
                type="number"
                min={1}
                max={120}
                value={fpsStr}
                onChange={(e) => setFpsStr(e.target.value)}
              />
            </div>
            <label style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 14 }}>
              <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
              loop
            </label>
          </div>
          {error && <div style={{ color: "var(--error-color, #c0392b)", fontSize: 11 }}>{error}</div>}
        </div>
        <div style={footer}>
          <button style={button} onClick={onClose}>
            Cancel
          </button>
          <button style={primary} onClick={() => void handleSave()}>
            {editingId ? "Save" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
