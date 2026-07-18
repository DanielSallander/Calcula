//! FILENAME: app/extensions/Pivot/components/DrillThroughBehaviorDialog.tsx
// PURPOSE: Configure a BI pivot's double-click drill-through behavior (Layer 1:
//          built-in vs a declarative query override -- which dimension
//          attributes to attach + a row cap). Persists via
//          set_pivot_drill_behavior; the config travels in .calp so subscribers
//          get the publisher's drill. A Script mode is planned (Layer 2).
// CONTEXT: Opened from the pivot context menu "Drill-through behavior..." action.

import React, { useState, useEffect, useCallback } from "react";
import { css } from "@emotion/css";
import { useDialogWindow } from "@api/dialogWindow";
import {
  getPivotBiMetadata,
  getPivotDrillBehavior,
  setPivotDrillBehavior,
  type DrillThroughBehavior,
  type DrillThroughKind,
  type DrillColumnRef,
} from "../lib/pivot-api";

export interface DrillThroughBehaviorDialogProps {
  isOpen: boolean;
  onClose: () => void;
  data?: Record<string, unknown>;
}

interface AttrOption {
  table: string;
  column: string;
  /** "table.column" — stable key for selection. */
  key: string;
}

const styles = {
  overlay: css`
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
  `,
  modal: css`
    background: #fff;
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
    width: 460px;
    max-width: 90vw;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
  `,
  header: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 18px;
    border-bottom: 1px solid #e0e0e0;
  `,
  title: css`
    font-size: 15px;
    font-weight: 600;
  `,
  closeBtn: css`
    border: none;
    background: none;
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    color: #666;
    &:hover {
      color: #000;
    }
  `,
  body: css`
    padding: 16px 18px;
    overflow-y: auto;
  `,
  muted: css`
    color: #888;
    padding: 8px 0;
  `,
  radioRow: css`
    display: flex;
    gap: 8px;
    align-items: flex-start;
    padding: 6px 0;
    cursor: pointer;
    span {
      line-height: 1.4;
    }
  `,
  customSection: css`
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid #eee;
  `,
  sectionLabel: css`
    font-weight: 600;
    margin-bottom: 6px;
  `,
  attrList: css`
    max-height: 220px;
    overflow-y: auto;
    border: 1px solid #e0e0e0;
    border-radius: 4px;
    padding: 6px;
  `,
  attrItem: css`
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 3px 0;
    cursor: pointer;
  `,
  limitRow: css`
    display: flex;
    gap: 8px;
    align-items: center;
    margin-top: 12px;
  `,
  limitInput: css`
    width: 100px;
    padding: 4px 6px;
    border: 1px solid #ccc;
    border-radius: 4px;
  `,
  footer: css`
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 18px;
    border-top: 1px solid #e0e0e0;
  `,
  btnSecondary: css`
    padding: 6px 14px;
    border: 1px solid #ccc;
    background: #fff;
    border-radius: 4px;
    cursor: pointer;
  `,
  btnPrimary: css`
    padding: 6px 14px;
    border: none;
    background: #0a7a55;
    color: #fff;
    border-radius: 4px;
    cursor: pointer;
    &:disabled {
      opacity: 0.5;
      cursor: default;
    }
  `,
};

function DrillThroughBehaviorDialog({
  isOpen,
  onClose,
  data,
}: DrillThroughBehaviorDialogProps): React.ReactElement | null {
  const pivotId = (data?.pivotId as string) ?? "";

  // Movable + resizable dialog window (shared @api hook)
  const win = useDialogWindow({ minWidth: 340, minHeight: 280 });

  const [loading, setLoading] = useState(false);
  const [isBi, setIsBi] = useState(true);
  const [mode, setMode] = useState<DrillThroughKind>("builtin");
  const [attrOptions, setAttrOptions] = useState<AttrOption[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState<string>("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isOpen || !pivotId) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [model, behavior] = await Promise.all([
          getPivotBiMetadata(pivotId),
          getPivotDrillBehavior(pivotId),
        ]);
        if (cancelled) return;
        if (!model) {
          setIsBi(false);
          return;
        }
        setIsBi(true);
        // Candidate dimension attributes = columns from tables OTHER than the
        // fact (the fact's own columns already come back via the detail rows).
        const factTable = model.measures[0]?.table ?? "";
        const opts: AttrOption[] = [];
        for (const t of model.tables) {
          if (t.name === factTable) continue;
          for (const c of t.columns) {
            opts.push({ table: t.name, column: c.name, key: `${t.name}.${c.name}` });
          }
        }
        setAttrOptions(opts);
        if (behavior?.kind === "query") {
          setMode("query");
          setSelected(
            new Set((behavior.query?.dimensionColumns ?? []).map((d) => `${d.table}.${d.column}`)),
          );
          setLimit(behavior.query?.limit != null ? String(behavior.query.limit) : "");
        } else if (behavior?.kind === "script") {
          setMode("script");
          setSelected(new Set());
          setLimit("");
        } else {
          setMode("builtin");
          setSelected(new Set());
          setLimit("");
        }
      } catch (err) {
        console.error("[Pivot] Failed to load drill behavior:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, pivotId]);

  const toggleAttr = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      if (mode === "builtin") {
        await setPivotDrillBehavior(pivotId, null);
      } else if (mode === "script") {
        await setPivotDrillBehavior(pivotId, { kind: "script" });
      } else {
        const dimensionColumns: DrillColumnRef[] = attrOptions
          .filter((o) => selected.has(o.key))
          .map((o) => ({ table: o.table, column: o.column }));
        const parsedLimit = limit.trim() ? Number(limit) : undefined;
        const behavior: DrillThroughBehavior = {
          kind: "query",
          query: {
            dimensionColumns,
            ...(parsedLimit != null && Number.isFinite(parsedLimit) && parsedLimit > 0
              ? { limit: parsedLimit }
              : {}),
          },
        };
        await setPivotDrillBehavior(pivotId, behavior);
      }
      onClose();
    } catch (err) {
      console.error("[Pivot] Failed to save drill behavior:", err);
    } finally {
      setSaving(false);
    }
  }, [mode, pivotId, attrOptions, selected, limit, onClose]);

  if (!isOpen) return null;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        ref={win.ref}
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        style={{ position: "relative", ...win.style }}
      >
        <div className={styles.header} onMouseDown={win.onHeaderMouseDown}>
          <span className={styles.title}>Drill-through behavior</span>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
            X
          </button>
        </div>
        <div className={styles.body}>
          {loading ? (
            <div className={styles.muted}>Loading...</div>
          ) : !isBi ? (
            <div className={styles.muted}>
              Drill-through customization is available for BI-backed pivots only.
            </div>
          ) : (
            <>
              <label className={styles.radioRow}>
                <input
                  type="radio"
                  name="drillMode"
                  checked={mode === "builtin"}
                  onChange={() => setMode("builtin")}
                />
                <span>
                  <strong>Built-in</strong> - raw fact rows with related dimension attributes
                  (default)
                </span>
              </label>
              <label className={styles.radioRow}>
                <input
                  type="radio"
                  name="drillMode"
                  checked={mode === "query"}
                  onChange={() => setMode("query")}
                />
                <span>
                  <strong>Custom</strong> - choose the dimension attributes and row cap
                </span>
              </label>
              <label className={styles.radioRow}>
                <input
                  type="radio"
                  name="drillMode"
                  checked={mode === "script"}
                  onChange={() => setMode("script")}
                />
                <span>
                  <strong>Script</strong> - run this pivot's onDrillThrough script (advanced)
                </span>
              </label>

              {mode === "query" && (
                <div className={styles.customSection}>
                  <div className={styles.sectionLabel}>Dimension attributes to show</div>
                  {attrOptions.length === 0 ? (
                    <div className={styles.muted}>No related dimension columns found.</div>
                  ) : (
                    <div className={styles.attrList}>
                      {attrOptions.map((o) => (
                        <label key={o.key} className={styles.attrItem}>
                          <input
                            type="checkbox"
                            checked={selected.has(o.key)}
                            onChange={() => toggleAttr(o.key)}
                          />
                          <span>
                            {o.table}.{o.column}
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                  <div className={styles.limitRow}>
                    <span>Max rows</span>
                    <input
                      className={styles.limitInput}
                      type="number"
                      min={1}
                      value={limit}
                      placeholder="default"
                      onChange={(e) => setLimit(e.target.value)}
                    />
                  </div>
                </div>
              )}

              {mode === "script" && (
                <div className={styles.customSection}>
                  <div className={styles.muted}>
                    On double-click, this pivot's sandboxed onDrillThrough(ctx) script runs with the
                    clicked cell. Author it as the pivot's object script (it needs the bi.query
                    capability and writes its own result). It is consented + audited and travels in
                    .calp.
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        <div className={styles.footer}>
          <button className={styles.btnSecondary} onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            className={styles.btnPrimary}
            onClick={handleSave}
            disabled={saving || loading || !isBi}
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
        {win.resizeHandles}
      </div>
    </div>
  );
}

export default DrillThroughBehaviorDialog;
