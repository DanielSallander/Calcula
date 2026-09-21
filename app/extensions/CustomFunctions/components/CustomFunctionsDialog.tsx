//! FILENAME: app/extensions/CustomFunctions/components/CustomFunctionsDialog.tsx
// PURPOSE: Author user-defined JS formula functions (UDFs). Each function's body
//          runs in a SANDBOXED worker (broker capabilities + audit), exposed as a
//          formula function (=NAME(args)). Bodies may call cube.value/kpi/members
//          when "BI model access" is granted. Saved with the workbook.
// CONTEXT: This dialog is also where the three RETURN/RECALC contracts are
//          documented for the author — scalar vs array (spills) vs
//          cellError("#N/A"), and the per-function "Recalculate on every edit"
//          (volatile) switch. Keep the help text here in lockstep with
//          @api/formulaFunctions (the sentinel) and @api/customFunctions (the
//          injected cellError binding).

import React, { useEffect, useMemo, useState } from "react";
import {
  type DialogProps,
  loadPersistedLibrary,
  savePersistedLibrary,
  installCustomFunctions,
  validateFunctionName,
  validateParam,
  getAllFunctions,
  showToast,
  type CustomFunctionUdf,
  type CustomFunctionLibrary,
} from "@api";
import { DialogBody, DialogPane, dialogWidth, dialogHeight } from "@api/dialogLayout";
import { CustomFunctionsCodeEditor } from "./CustomFunctionsCodeEditor";

const BLANK: CustomFunctionUdf = { name: "", params: [], body: "return ;", description: "" };

/** Width of the pinned Reference column. At 260 the cellError contract alone
 *  reflows to ~7 lines; 300 keeps each contract to two or three. */
const REFERENCE_PANE_WIDTH = 300;
/** Floor for the code editor before the pane starts scrolling instead of
 *  shrinking it further (see the editor pane below). */
const CODE_EDITOR_MIN_HEIGHT = 200;

function listItemStyle(active: boolean): React.CSSProperties {
  return {
    padding: "6px 8px",
    borderRadius: 4,
    cursor: "pointer",
    fontFamily: "monospace",
    fontSize: 12,
    background: active ? "var(--accent, #2563eb)" : "transparent",
    color: active ? "#fff" : "inherit",
    marginBottom: 2,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  };
}

const s: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.35)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  },
  card: {
    background: "var(--surface, #fff)",
    color: "var(--text, #1a1a1a)",
    borderRadius: 8,
    // Three columns now (list | editor | reference), so the card is wide rather
    // than a tall straw: 1040 leaves the code column ~558px, WIDER than the
    // 539px it had at 720 even after the Reference pane takes its 300.
    width: dialogWidth(1040),
    // A DEFINITE height, not just a cap. The code editor is a flex:1 child now,
    // and flex:1 divides *free* space — with an auto-height card there is none,
    // so the editor would collapse to nothing. Same shape as CreateChartDialog.
    height: dialogHeight(780, 0.86),
    maxHeight: "86vh",
    display: "flex",
    flexDirection: "column",
    boxShadow: "0 10px 40px rgba(0,0,0,0.25)",
    fontSize: 13,
  },
  head: { padding: "16px 20px 8px", flexShrink: 0 },
  title: { margin: 0, fontSize: 16, fontWeight: 600 },
  sub: { margin: "4px 0 0", fontSize: 12, color: "var(--text-muted, #777)" },
  // Passed to <DialogBody>, which supplies the row/flex/minHeight-0 bookkeeping.
  bodyWrap: { minHeight: 280, overflow: "hidden" },
  list: {
    width: 180,
    flexShrink: 0,
    borderRight: "1px solid var(--border, #e2e2e2)",
    overflowY: "auto",
    padding: "8px",
  },
  row: { display: "flex", flexDirection: "column", gap: 4, marginBottom: 10, flexShrink: 0 },
  label: { fontSize: 12, fontWeight: 600, color: "var(--text-muted, #555)", flexShrink: 0 },
  input: {
    padding: "6px 8px",
    border: "1px solid var(--border, #ccc)",
    borderRadius: 4,
    background: "var(--input-bg, #fff)",
    color: "inherit",
    fontSize: 13,
  },
  code: {
    fontFamily: "'Cascadia Code', Consolas, monospace",
    fontSize: 12.5,
    minHeight: 150,
    resize: "vertical",
    whiteSpace: "pre",
    overflowWrap: "normal",
    overflowX: "auto",
  },
  foot: {
    display: "flex",
    // The BI-access grant moved up into the Reference pane (it is a LIBRARY
    // capability, not a per-function option), so the footer is buttons only.
    justifyContent: "flex-end",
    alignItems: "center",
    padding: "10px 20px 16px",
    borderTop: "1px solid var(--border, #e2e2e2)",
    flexShrink: 0,
  },
  btn: { padding: "7px 14px", borderRadius: 4, border: "1px solid var(--border, #ccc)", cursor: "pointer", fontSize: 13 },
  btnPrimary: { padding: "7px 14px", borderRadius: 4, border: "none", background: "var(--accent, #2563eb)", color: "#fff", cursor: "pointer", fontSize: 13 },
  smallBtn: { padding: "2px 8px", borderRadius: 4, border: "1px solid var(--border, #ccc)", cursor: "pointer", fontSize: 12 },
  // flexShrink: 0 — these now sit in flex COLUMNS (the editor pane, the
  // Reference pane), where a prose block would otherwise be squashed rather
  // than scrolled.
  hint: { fontSize: 11, color: "var(--text-muted, #888)", flexShrink: 0 },
  helpBox: {
    marginTop: 6,
    padding: "8px 10px",
    borderRadius: 4,
    border: "1px solid var(--border, #e2e2e2)",
    background: "var(--surface-alt, rgba(127,127,127,0.07))",
    fontSize: 11,
    lineHeight: 1.5,
    color: "var(--text-muted, #666)",
    flexShrink: 0,
  },
  helpLine: { marginBottom: 3 },
  // The Reference column. Its own border/caption colours come from THIS
  // dialog's token family (--border / --text-muted with light fallbacks), not
  // from DialogSidePane's --border-default / --text-secondary: those are real,
  // themed tokens and would paint a skinned rule on a hard-light card.
  refPane: { borderLeft: "1px solid var(--border, #e2e2e2)", gap: 8 },
  paneTitle: {
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.4px",
    color: "var(--text-muted, #777)",
    flexShrink: 0,
  },
  checkRow: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, flexShrink: 0 },
  error: { color: "#c00", fontSize: 12, padding: "0 20px", whiteSpace: "pre-wrap", flexShrink: 0 },
};

export function CustomFunctionsDialog(props: DialogProps): React.ReactElement | null {
  const { isOpen, onClose } = props;
  const [functions, setFunctions] = useState<CustomFunctionUdf[]>([]);
  const [biAccess, setBiAccess] = useState(true);
  const [selected, setSelected] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Upper-cased built-in function names — a UDF must not shadow one (the parser
  // resolves built-ins first, so a colliding UDF would silently never run).
  const [builtins, setBuiltins] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setError(null);
    loadPersistedLibrary().then((lib) => {
      if (cancelled) return;
      setFunctions(lib?.functions ?? []);
      setBiAccess((lib?.capabilities ?? ["bi.query"]).includes("bi.query"));
      setSelected(0);
    });
    getAllFunctions()
      .then((res) => {
        if (cancelled) return;
        setBuiltins(new Set(res.functions.map((f) => f.name.toUpperCase())));
      })
      .catch(() => {
        /* best-effort: collision check just won't fire */
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const current = functions[selected];

  function patch(p: Partial<CustomFunctionUdf>): void {
    setFunctions((fs) => fs.map((f, i) => (i === selected ? { ...f, ...p } : f)));
  }

  function addFn(): void {
    setFunctions((fs) => [...fs, { ...BLANK, name: `FUNC${fs.length + 1}` }]);
    setSelected(functions.length);
  }

  function removeFn(i: number): void {
    setFunctions((fs) => fs.filter((_, j) => j !== i));
    setSelected((s2) => Math.max(0, Math.min(s2, functions.length - 2)));
  }

  const lib: CustomFunctionLibrary = useMemo(
    () => ({
      // Params are trimmed and de-blanked HERE, at the point of consumption —
      // never on keystroke. Normalising a controlled input's value as you type
      // means a trailing comma can never survive the round trip: React writes
      // the normalised value straight back over the DOM, so `price` + `,`
      // becomes `price` again and a second parameter cannot be typed.
      functions: functions.map((f) => ({
        ...f,
        name: f.name.trim(),
        params: f.params.map((x) => x.trim()).filter(Boolean),
      })),
      capabilities: biAccess ? ["bi.query"] : [],
    }),
    [functions, biAccess],
  );

  async function onSave(): Promise<void> {
    setError(null);
    // Validate names (non-empty, unique, JS-identifier, not a built-in) and params.
    const seen = new Set<string>();
    for (const f of lib.functions) {
      if (!f.name) continue;
      const nameErr = validateFunctionName(f.name);
      if (nameErr) {
        setError(nameErr);
        return;
      }
      const up = f.name.toUpperCase();
      if (builtins.has(up)) {
        setError(`"${f.name}" is a built-in function and cannot be overridden.`);
        return;
      }
      if (seen.has(up)) {
        setError(`Duplicate function name "${f.name}".`);
        return;
      }
      seen.add(up);
      for (const p of f.params) {
        const perr = validateParam(p.trim(), f.name);
        if (p.trim() && perr) {
          setError(perr);
          return;
        }
      }
    }
    setSaving(true);
    try {
      const cleaned: CustomFunctionLibrary = {
        functions: lib.functions.filter((f) => f.name && f.body.trim()),
        capabilities: lib.capabilities,
      };
      // Mount first (surfaces sandbox/compile errors before we persist), then save.
      // We deliberately do NOT force a recalc here: existing UDF cells keep their
      // last values (the engine preserves them when a definition is in flux), and
      // new/edited usages resolve on their next edit. Forcing a full recalc here
      // raced the just-mounted library and could blank cube/UDF cells.
      await installCustomFunctions(cleaned);
      await savePersistedLibrary(cleaned);
      showToast(`Saved ${cleaned.functions.length} custom function(s)`, { type: "success" });
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  if (!isOpen) return null;

  return (
    <div style={s.overlay} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div style={s.card}>
        <div style={s.head}>
          <h2 style={s.title}>Custom Functions</h2>
          <p style={s.sub}>
            Write JS functions usable in formulas (=NAME(args)). Bodies run sandboxed; grant
            BI access to call <code>cube.value("conn","[Measure]","T[C]=v")</code>.
          </p>
        </div>

        <DialogBody style={s.bodyWrap}>
          <div style={s.list}>
            {functions.map((f, i) => (
              <div
                key={i}
                style={listItemStyle(i === selected)}
                onClick={() => setSelected(i)}
                title={f.name}
              >
                {f.name || "(unnamed)"}
              </div>
            ))}
            <button style={{ ...s.smallBtn, marginTop: 6, width: "100%" }} onClick={addFn}>
              + Add function
            </button>
          </div>

          {/* The editor column is a flex COLUMN (DialogPane supplies that) so the
              code editor can be its one flex:1 child. It keeps overflow-y:auto as
              a floor-breaker only: the editor has a min-height, so on a very short
              viewport the pane scrolls instead of clipping the Delete button. */}
          <DialogPane padding="10px 16px" data-testid="custom-functions-editor">
            {current ? (
              <>
                <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                  <div style={{ ...s.row, flex: 1 }}>
                    <label style={s.label}>Name</label>
                    <input
                      style={s.input}
                      value={current.name}
                      onChange={(e) => patch({ name: e.target.value })}
                    />
                  </div>
                  <div style={{ ...s.row, flex: 2 }}>
                    <label style={s.label}>Parameters (comma-separated)</label>
                    <input
                      style={s.input}
                      placeholder="e.g. price, rate"
                      value={current.params.join(",")}
                      onChange={(e) => patch({ params: e.target.value.split(",") })}
                    />
                  </div>
                </div>
                {/* The one growing row: label fixed, editor takes the rest. The
                    static return contracts that used to sit under it are in the
                    Reference column — they never change, so they cost the author
                    nothing but the height they were eating from the code. */}
                {/* NO `minHeight: 0` here: it lets the row shrink under the editor's own
                    200px floor, and Monaco then paints OVER the Description field
                    instead of the pane scrolling. `min-height: auto` clamps the row
                    at label+editor and hands the overflow to DialogPane. */}
                <div style={{ ...s.row, flex: 1, marginBottom: 10 }}>
                  <label style={s.label}>Body (JavaScript — must return a value)</label>
                  <div style={{ flex: 1, minHeight: CODE_EDITOR_MIN_HEIGHT }}>
                    <CustomFunctionsCodeEditor
                      value={current.body}
                      onChange={(body) => patch({ body })}
                      height="100%"
                    />
                  </div>
                </div>
                <div style={s.row}>
                  <label style={s.label}>Description (shown in autocomplete)</label>
                  <input
                    style={s.input}
                    value={current.description ?? ""}
                    onChange={(e) => patch({ description: e.target.value })}
                  />
                </div>
                {/* The volatile explanation stays WITH its checkbox rather than
                    moving to Reference: "runs on every single edit" is exactly
                    what the author must read at the moment of ticking the box. */}
                <div style={s.row}>
                  <label style={s.checkRow}>
                    <input
                      type="checkbox"
                      checked={current.volatile === true}
                      onChange={(e) => patch({ volatile: e.target.checked })}
                    />
                    Recalculate on every edit (volatile)
                  </label>
                  <span style={s.hint}>
                    Off (default): the cell recalculates only when one of its arguments
                    changes — the cheap, predictable behaviour. Turn it on for functions
                    whose result can change without the arguments changing (a clock, a
                    random sample, a live external reading). Volatile functions run on
                    every single edit in the workbook.
                  </span>
                </div>
                {/* alignSelf: the pane is a flex COLUMN now, and a stretched
                    flex item would run this button the full width of it. */}
                <button
                  style={{ ...s.smallBtn, alignSelf: "flex-start", flexShrink: 0 }}
                  onClick={() => removeFn(selected)}
                >
                  Delete this function
                </button>
              </>
            ) : (
              <div style={s.hint}>No functions yet. Click "Add function".</div>
            )}
          </DialogPane>

          {/* Reference. Deliberately OUTSIDE the `current ? …` ternary: the author
              who most needs the return contracts is the one who has not added a
              function yet and would otherwise see an empty dialog. */}
          <DialogPane
            width={REFERENCE_PANE_WIDTH}
            style={s.refPane}
            data-testid="custom-functions-reference"
          >
            {/* A LIBRARY-wide capability grant. It used to sit in the footer
                beside Cancel/Save, where it read as an option on the function
                being edited; here it is next to the `cube` it unlocks. */}
            <label style={s.checkRow}>
              <input
                type="checkbox"
                checked={biAccess}
                onChange={(e) => setBiAccess(e.target.checked)}
              />
              Allow BI model access (cube.*)
            </label>

            <div style={s.paneTitle}>Reference</div>
            <span style={s.hint}>
              Available: the parameters, <code>cube</code> (when BI access is on),{" "}
              <code>cellError</code>, and standard JS.
            </span>
            <div style={s.helpBox}>
              <div style={s.helpLine}>
                <b>Return a value</b> — a number, text or boolean fills the cell.
              </div>
              <div style={s.helpLine}>
                <b>Return an array</b> to spill like a dynamic array:{" "}
                <code>return [1, 2, 3]</code> fills three rows,{" "}
                <code>return [[1, 2], [3, 4]]</code> fills a 2x2 block.
              </div>
              <div style={s.helpLine}>
                <b>Return an error</b> with <code>cellError</code>:{" "}
                <code>return cellError("#N/A")</code> puts a real #N/A in the cell —
                returning the plain text <code>"#N/A"</code> stays text. Valid codes:
                #N/A, #VALUE!, #REF!, #NAME?, #DIV/0!. You can also{" "}
                <code>throw new Error("#N/A")</code> from inside a catch block; any
                other thrown error becomes #VALUE!.
              </div>
            </div>
          </DialogPane>
        </DialogBody>

        {/* Outside the body, above the footer: the reason a button refused has to
            sit next to the button, not scroll away inside a pane. */}
        {error && <div style={s.error}>{error}</div>}

        <div style={s.foot}>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={s.btn} onClick={onClose}>
              Cancel
            </button>
            <button style={s.btnPrimary} disabled={saving} onClick={onSave}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
