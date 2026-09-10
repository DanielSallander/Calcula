// FILENAME: app/extensions/ModelEditor/lib/bulkEdit.ts
// PURPOSE: Turn a multi-object selection + a property patch into ONE CLI
//          command, and describe what the selection currently shares.
// CONTEXT: "Hide 40 of 200 columns before shipping" was forty modals. There was
//          no multi-select in any section and no `where` clause in the CLI —
//          its globs match NAMES only — so the job was inexpressible in either
//          surface.
//
//          WHY A COMMAND STRING RATHER THAN N API CALLS. Every `bi_model_*`
//          mutation returns a whole fresh `ModelOverview`, and the extension's
//          bridge fires `recalcWithCube()` in the MAIN window on each one.
//          Forty unbatched hides are forty cross-window workbook
//          recalculations. Routed through `planRun`/`executeRun` they are one
//          backend batch: one undo step, all-or-nothing, ONE overview.
//          It also makes GUI/CLI drift structurally impossible — the GUI has no
//          second write path to diverge — and the command it prints is a log of
//          exactly what ran.

/** A value shared by every selected object, or `mixed`, or absent. */
export type Shared<T> = { kind: "same"; value: T } | { kind: "mixed" } | { kind: "none" };

/** What `n` objects agree on for one property. */
export function shared<T, V>(items: T[], pick: (t: T) => V): Shared<V> {
  if (items.length === 0) return { kind: "none" };
  const first = pick(items[0]);
  for (let i = 1; i < items.length; i++) {
    if (pick(items[i]) !== first) return { kind: "mixed" };
  }
  return { kind: "same", value: first };
}

/**
 * Quote a name for the CLI when it needs it.
 *
 * The grammar accepts a bare word, `"quoted"` or `[bracketed]`. A name with a
 * space, a comma or a quote MUST be quoted or the lexer splits it into
 * positionals and the command silently targets something else — or nothing.
 */
export function quoteName(name: string): string {
  if (/^[A-Za-z0-9_.]+$/.test(name)) return name;
  // The grammar has no string escapes, so a name containing a double quote
  // cannot be expressed. Bracket form is the fallback; a name with BOTH is
  // reported by `unquotableNames` and excluded from the run rather than
  // silently mistargeted.
  if (!name.includes('"')) return `"${name}"`;
  return `[${name}]`;
}

/** Names this grammar cannot express — the caller must not target them. */
export function unquotableNames(names: string[]): string[] {
  return names.filter((n) => n.includes('"') && (n.includes("[") || n.includes("]")));
}

/** `Table[Column]`, each half quoted only if it needs to be. */
export function columnRef(table: string, column: string): string {
  return `${quoteName(table)}[${column}]`;
}

/** One `key=value` option, with the value quoted when the grammar needs it. */
export function option(key: string, value: string | boolean): string {
  if (typeof value === "boolean") return `${key}=${value ? "true" : "false"}`;
  if (value === "") return `${key}=`; // the grammar's "clear this" spelling
  return `${key}=${quoteName(value)}`;
}

export interface ColumnTarget {
  table: string;
  column: string;
}

/**
 * `set column A[x] A[y] … hidden=true format="0.0%"`.
 *
 * Returns null when there is nothing to do, so a caller never runs an empty
 * command that would report success having changed nothing.
 */
export function buildSetColumnsCommand(
  targets: ColumnTarget[],
  patch: Record<string, string | boolean>,
): string | null {
  const opts = Object.entries(patch).map(([k, v]) => option(k, v));
  if (targets.length === 0 || opts.length === 0) return null;
  const refs = targets.map((t) => columnRef(t.table, t.column));
  return `set column ${refs.join(" ")} ${opts.join(" ")}`;
}

/** `set measure "Margin %" format="0.0%"` — the single-object form used by
 *  "Copy as command" on an object header. */
export function buildSetCommand(
  kind: string,
  name: string,
  patch: Record<string, string | boolean>,
): string | null {
  const opts = Object.entries(patch).map(([k, v]) => option(k, v));
  if (opts.length === 0) return null;
  return `set ${kind} ${quoteName(name)} ${opts.join(" ")}`;
}
