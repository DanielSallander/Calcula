// FILENAME: app/extensions/ModelEditor/components/editorShared.tsx
// PURPOSE: Shared building blocks for the Model Editor window: the section
//          context contract, the neutral light-theme style kit, and small
//          primitives (Modal, ErrorBanner, Badge, Field) used by all sections.

import React, { useCallback, useEffect, useId, useRef } from "react";
import type { ModelMeasureInfo, ModelOverview, RoleFilterDto } from "@api";
import { FONT, LINE, ME, PAD, RADIUS, SHADOW, SIZE, SPACE } from "./theme";

// ============================================================================
// Section identity
// ============================================================================
// Lives here rather than in ModelEditorApp because `SectionCtx.navigate` is
// part of the contract every section consumes — putting the union in the app
// would make every section import its own host.

/** The runtime list is the source of truth and `SectionId` is derived from it,
 *  so a section can never exist in the type but not in the validator that
 *  guards a restored route. */
export const SECTION_IDS = [
  "overview",
  "tables",
  "connections",
  "relationships",
  "hierarchies",
  "measures",
  "contexts",
  "kpis",
  "strategy",
  "calcGroups",
  "globals",
  "tableVariables",
  "scriptFunctions",
  "roles",
  "perspectives",
  "translations",
  "lineage",
  "testing",
  "settings",
  "import",
] as const;

export type SectionId = (typeof SECTION_IDS)[number];

export function isSectionId(value: string): value is SectionId {
  return (SECTION_IDS as readonly string[]).includes(value);
}

// ============================================================================
// Section contract (provided by ModelEditorApp to every model section)
// ============================================================================

export interface SectionCtx {
  connectionId: string;
  overview: ModelOverview;
  /**
   * The object the route asks this section to select, if any.
   *
   * Without this the route's selection half was INERT: `navigate(section, name)`
   * recorded a name, the hash showed it, and no section ever read it — so the
   * palette landed you on the right page and left you to find the row yourself,
   * which is most of the way to not having a palette. A section honours it
   * on arrival and is then free to ignore it; it is a request, not a lock.
   */
  selection?: string;
  /** True when the model rejects edits (readOnlyReason banner is shown). */
  readOnly: boolean;
  /** Install the fresh overview a mutation returned; also notifies the main
   * window (emitModelChanged) so CUBE cells re-evaluate there. */
  applyOverview: (overview: ModelOverview) => void;
  /** Same, for the measure endpoints that return only the measure list. */
  applyMeasures: (measures: ModelMeasureInfo[]) => void;
  /** Surface an API error in the window-level dismissible banner. */
  reportError: (err: unknown) => void;
  /**
   * Move to another section, optionally selecting an object inside it.
   *
   * Before this existed, `setActive` was called in exactly ONE place (the nav
   * map), so every empty state that said "import some under Import" was a
   * dead end the reader had to navigate by hand. The standing rule now: AN
   * EMPTY STATE MAY NOT NAME A DESTINATION IT CANNOT NAVIGATE TO. That is
   * reviewable precisely because there is one call.
   */
  navigate: (section: SectionId, selection?: string) => void;
  /**
   * Run a CLI command line and install its result. The ONE write path for a
   * multi-object edit.
   *
   * A bulk edit routed here is a single backend batch — one undo step,
   * all-or-nothing, and ONE fresh overview — where N direct API calls would be
   * N cross-window `recalcWithCube()` round trips in the main window. It also
   * means the GUI has no second write path that could drift from the CLI's.
   *
   * Unlike the search palette (which HANDS a typed command to the CLI panel so
   * its confirmation card can gate a wildcard), this executes: the caller has
   * an explicit, visible selection, so the selection IS the confirmation.
   * Resolves with the echoed lines; rejects with the CliError message.
   */
  runCommand: (text: string) => Promise<string[]>;
}

// ============================================================================
// Style kit
// ============================================================================
// EVERY EXPORT NAME HERE IS LOAD-BEARING. 43 of this window's 90 files import
// this object and spread its members; renaming a key would be a 300-site edit
// for no user-visible gain. So the names are frozen and only the VALUES moved
// — from hardcoded hex at 1995 dialog density to skin tokens at the density in
// theme.ts.

export const ACCENT = ME.accent;
export const SELECTION_BG = ME.select;

export const styles = {
  input: {
    padding: PAD.control,
    border: `1px solid ${ME.ctlBorder}`,
    borderRadius: RADIUS.control,
    fontSize: FONT.base,
    minHeight: SIZE.control,
    background: ME.ctlBg,
    color: ME.text,
    fontFamily: "inherit",
  },
  textarea: {
    padding: PAD.control,
    border: `1px solid ${ME.ctlBorder}`,
    borderRadius: RADIUS.control,
    fontSize: FONT.sm,
    lineHeight: LINE.code,
    background: ME.ctlBg,
    color: ME.text,
    fontFamily: ME.mono,
    resize: "vertical",
  },
  btn: {
    padding: PAD.button,
    fontSize: FONT.base,
    minHeight: SIZE.control,
    border: `1px solid ${ME.ctlBorder}`,
    borderRadius: RADIUS.control,
    background: ME.btnBg,
    color: ME.text,
    cursor: "pointer",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
  },
  primaryBtn: {
    padding: PAD.button,
    fontSize: FONT.base,
    fontWeight: 600,
    minHeight: SIZE.control,
    border: `1px solid ${ME.accent}`,
    borderRadius: RADIUS.control,
    background: ME.accent,
    color: ME.onAccent,
    cursor: "pointer",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
  },
  smallBtn: {
    padding: "3px 9px",
    fontSize: FONT.sm,
    border: `1px solid ${ME.ctlBorder}`,
    borderRadius: RADIUS.control,
    background: ME.btnBg,
    color: ME.text,
    cursor: "pointer",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
  },
  field: { display: "flex", flexDirection: "column", gap: SPACE.xs, marginBottom: SPACE.md },
  label: { fontSize: FONT.sm, fontWeight: 600, color: ME.text2 },
  muted: { color: ME.text2 },
  hint: { fontSize: FONT.sm, color: ME.text3 },
  th: {
    textAlign: "left",
    padding: PAD.cell,
    borderBottom: `1px solid ${ME.border}`,
    fontWeight: 600,
    fontSize: FONT.sm,
    color: ME.text2,
    whiteSpace: "nowrap",
  },
  td: {
    padding: PAD.cell,
    // Rows separate by spacing and a hover tint, not a rule each. The header
    // keeps its rule because it is a real boundary.
    fontSize: FONT.base,
    verticalAlign: "top",
  },
  // Cards trade their border for the first elevation step.
  card: {
    background: ME.surface,
    border: "none",
    borderRadius: RADIUS.control,
    boxShadow: SHADOW.card,
    padding: PAD.card,
  },
  sectionHeader: {
    display: "flex",
    alignItems: "center",
    gap: SPACE.sm,
    marginBottom: SPACE.xs,
  },
  sectionTitle: { fontSize: FONT.sectionTitle, fontWeight: 600, flex: 1 },
  listRow: {
    padding: "7px 10px",
    borderRadius: RADIUS.control,
    cursor: "pointer",
  },
} satisfies Record<string, React.CSSProperties>;

// ============================================================================
// ErrorBanner (window-level, dismissible)
// ============================================================================

export function ErrorBanner({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: SPACE.sm,
        padding: `${SPACE.sm}px ${SPACE.md}px`,
        background: ME.dangerBg,
        color: ME.dangerFg,
        fontSize: FONT.sm,
        borderBottom: `1px solid ${ME.borderSubtle}`,
        flexShrink: 0,
      }}
    >
      <div style={{ flex: 1, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{message}</div>
      <button
        onClick={onDismiss}
        title="Dismiss"
        aria-label="Dismiss error"
        style={{
          border: "none",
          background: "transparent",
          color: ME.dangerFg,
          cursor: "pointer",
          fontSize: FONT.sectionTitle,
          lineHeight: 1,
          padding: 0,
        }}
      >
        &times;
      </button>
    </div>
  );
}

// ============================================================================
// Badge
// ============================================================================

// An `error` tone exists because there was NO way to render one: the set was
// neutral/warn/ok, so OverviewSection mapped `level === "error"` onto `warn`
// and every validation error rendered in warning yellow. That was not an edge
// case — `bi_model_validate` only ever emits `level: "error"`, so the one tone
// it can produce was the one tone that was wrong. (Stage 2 replaces these
// literals with the --tone-* skin tokens; the shape stays.)
export function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "warn" | "ok" | "error";
}): React.ReactElement {
  const colors = {
    neutral: { bg: ME.sunken, fg: ME.text2 },
    warn: { bg: ME.warnBg, fg: ME.warnFg },
    ok: { bg: ME.okBg, fg: ME.okFg },
    error: { bg: ME.dangerBg, fg: ME.dangerFg },
  }[tone];
  return (
    <span
      style={{
        background: colors.bg,
        color: colors.fg,
        borderRadius: RADIUS.pill,
        padding: "2px 8px",
        fontSize: FONT.xs,
        fontWeight: 500,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

// ============================================================================
// Field (label above a control, optional hint below)
// ============================================================================

export function Field({
  label,
  hint,
  flex,
  children,
}: {
  label: string;
  hint?: string;
  flex?: number;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div style={{ ...styles.field, ...(flex !== undefined ? { flex } : {}) }}>
      <label style={styles.label}>{label}</label>
      {children}
      {hint && <div style={styles.hint}>{hint}</div>}
    </div>
  );
}

// ============================================================================
// FilterPredicateList — shared row-filter editor
// ============================================================================
// The engine `FilterPredicate` (table/column/operator/value + optional dynamic
// USERNAME()/CUSTOMDATA()) is reused verbatim by Security Roles and Table
// Variables. (Contexts are authored as CONTEXT expression text, not through
// this widget.) This widget + the draft<->DTO mappers keep the operator
// strings and dynamic handling in ONE place.

/** The bare remote-table guess for a model table: tables imported from a
 *  schema are NAMED "<schema>.<table>", but a source binding's table must be
 *  the bare remote name — the SQL builder qualifies it with the schema itself,
 *  so a doubled prefix renders as "BI"."BI.fact_sales" and the database
 *  rejects it. The backend applies the same normalization on save. */
export function stripSchemaPrefix(name: string, schema: string): string {
  const s = schema.trim();
  if (!s) return name;
  const dot = name.indexOf(".");
  if (dot > 0 && name.slice(0, dot).toLowerCase() === s.toLowerCase() && dot + 1 < name.length) {
    return name.slice(dot + 1);
  }
  return name;
}

export const FILTER_OPERATORS = ["=", "!=", ">", ">=", "<", "<="];

const DYNAMIC_OPTIONS = [
  { value: "", label: "None" },
  { value: "username", label: "USERNAME()" },
  { value: "customData", label: "CUSTOMDATA()" },
];

export interface FilterDraft {
  table: string;
  column: string;
  operator: string;
  /** Static comparison value; ignored (blanked) when `dynamic` is set. */
  value: string;
  /** "" = static; "username" | "customData" = dynamic RLS. */
  dynamic: string;
}

export function emptyFilterDraft(): FilterDraft {
  return { table: "", column: "", operator: "=", value: "", dynamic: "" };
}

export function filterDtoToDraft(f: RoleFilterDto): FilterDraft {
  return {
    table: f.table,
    column: f.column,
    operator: f.operator,
    value: f.value,
    dynamic: f.dynamic ?? "",
  };
}

export function filterDraftToDto(f: FilterDraft): RoleFilterDto {
  return {
    table: f.table,
    column: f.column,
    operator: f.operator,
    value: f.dynamic !== "" ? "" : f.value,
    dynamic: f.dynamic === "" ? null : f.dynamic,
  };
}

/** A draft filter is complete when it has a table, a column, and either a
 * dynamic kind or a non-empty static value. */
export function isFilterDraftComplete(f: FilterDraft): boolean {
  return f.table !== "" && f.column !== "" && (f.dynamic !== "" || f.value.trim() !== "");
}

export function FilterPredicateList({
  overview,
  filters,
  onChange,
  allowDynamic = true,
  addLabel = "Add filter",
  emptyHint = "No filters.",
}: {
  overview: ModelOverview;
  filters: FilterDraft[];
  onChange: (filters: FilterDraft[]) => void;
  /** Roles/contexts allow dynamic RLS; table-variable filters are static. */
  allowDynamic?: boolean;
  addLabel?: string;
  emptyHint?: string;
}): React.ReactElement {
  const columnsOf = (tableName: string): string[] =>
    overview.tables.find((t) => t.name === tableName)?.columns.map((c) => c.name) ?? [];

  const update = (index: number, patch: Partial<FilterDraft>) => {
    onChange(filters.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {filters.length === 0 && <div style={styles.hint}>{emptyHint}</div>}
      {filters.map((f, i) => (
        <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <select
            style={{ ...styles.input, flex: 2, minWidth: 0 }}
            value={f.table}
            onChange={(e) => update(i, { table: e.target.value, column: "" })}
          >
            <option value="">(table)</option>
            {overview.tables.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
          <select
            style={{ ...styles.input, flex: 2, minWidth: 0 }}
            value={f.column}
            onChange={(e) => update(i, { column: e.target.value })}
          >
            <option value="">(column)</option>
            {columnsOf(f.table).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <select
            style={{ ...styles.input, width: 58, flexShrink: 0 }}
            value={f.operator}
            onChange={(e) => update(i, { operator: e.target.value })}
          >
            {FILTER_OPERATORS.map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </select>
          <input
            style={{ ...styles.input, flex: 2, minWidth: 0 }}
            value={f.value}
            disabled={f.dynamic !== ""}
            onChange={(e) => update(i, { value: e.target.value })}
            placeholder={f.dynamic !== "" ? "(dynamic)" : "Value"}
          />
          {allowDynamic && (
            <select
              style={{ ...styles.input, flex: 2, minWidth: 0 }}
              value={f.dynamic}
              onChange={(e) => update(i, { dynamic: e.target.value })}
            >
              {DYNAMIC_OPTIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          )}
          <button
            style={styles.smallBtn}
            onClick={() => onChange(filters.filter((_, j) => j !== i))}
          >
            Remove
          </button>
        </div>
      ))}
      <div>
        <button style={styles.smallBtn} onClick={() => onChange([...filters, emptyFilterDraft()])}>
          {addLabel}
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// Modal (window-local, light theme — NOT a Tauri dialog)
// ============================================================================

/** The sanctioned dialog sizes. Widths were ad-hoc (560/620/720/760/1280),
 *  so dialogs of the same visual weight had wildly different footprints. Any
 *  requested width snaps UP to the first step that fits it, which keeps every
 *  existing call site working without touching 20 files. */
export const MODAL_WIDTHS = [480, 640, 880, 1200] as const;

export function quantiseModalWidth(width: number): number {
  return MODAL_WIDTHS.find((w) => w >= width) ?? MODAL_WIDTHS[MODAL_WIDTHS.length - 1];
}

/** Elements that can hold focus inside a dialog. `[tabindex="-1"]` is excluded
 *  deliberately: it is programmatically focusable but must not appear in the
 *  Tab cycle. */
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),' +
  'textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Modal({
  title,
  width = 560,
  onClose,
  children,
  footer,
}: {
  title: string;
  width?: number;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}): React.ReactElement {
  // Close on backdrop click only when the interaction both STARTS and ENDS on
  // the backdrop. A drag that starts inside the dialog (e.g. selecting text)
  // and is released over the backdrop must NOT discard the user's input.
  const mouseDownOnBackdrop = useRef(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  // Focus the dialog's first control on mount and give focus BACK to whatever
  // opened it on unmount. Without the restore, closing a dialog dropped focus
  // onto <body> and the next Tab restarted from the top of the window.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const node = dialogRef.current;
    const first = node?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? node)?.focus();
    return () => opener?.focus?.();
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        // Nested dialogs (CalcColumnModal -> ExpressionEditorModal) render the
        // inner backdrop INSIDE the outer dialog, so this event bubbles. Stop
        // it, or one Escape closes the whole stack instead of the top of it.
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const node = dialogRef.current;
      if (!node) return;
      // No visibility filter here on purpose. `offsetParent` is the obvious
      // test and it is wrong twice: it is null for ANY position:fixed element
      // (which this backdrop is) and it is always null under jsdom, so it
      // silently collapsed the cycle to a single element. Content these
      // dialogs hide is conditionally RENDERED, so it is absent from the DOM
      // rather than hidden in it, and [hidden] elements are not focusable.
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      // Wrap manually only at the ends; everything between is the browser's job.
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    },
    [onClose],
  );

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: ME.scrim,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => {
        mouseDownOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (mouseDownOnBackdrop.current && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{
          background: ME.overlay,
          color: ME.text,
          borderRadius: RADIUS.panel,
          boxShadow: SHADOW.modal,
          width: quantiseModalWidth(width),
          maxWidth: "94vw",
          maxHeight: "88vh",
          display: "flex",
          flexDirection: "column",
          outline: "none",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3
          id={titleId}
          style={{
            margin: 0,
            padding: `${SPACE.lg}px ${SPACE.xl}px ${SPACE.md}px`,
            fontSize: FONT.sectionTitle,
            fontWeight: 600,
          }}
        >
          {title}
        </h3>
        <div
          style={{ padding: `0 ${SPACE.xl}px`, overflowY: "auto", flex: 1, minHeight: 0 }}
        >
          {children}
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: SPACE.sm,
            padding: `${SPACE.lg}px ${SPACE.xl}px`,
          }}
        >
          {footer}
        </div>
      </div>
    </div>
  );
}
