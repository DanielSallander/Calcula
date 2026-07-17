// FILENAME: app/extensions/ModelEditor/cli/format.ts
// PURPOSE: Plain-text output shaping for the command panel: aligned tables
//          for `ls`, key/value blocks for `show`. Monospace-friendly, no
//          Unicode box drawing (the panel renders in <pre>).

const MAX_CELL = 64;

function clip(s: string): string {
  const flat = s.replace(/\s*\n\s*/g, " ");
  return flat.length > MAX_CELL ? flat.slice(0, MAX_CELL - 1) + "…" : flat;
}

/** Render an aligned text table. Returns "" for zero rows (callers print a
 *  "(none)" style message instead). */
export function textTable(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "";
  const cells = rows.map((r) => r.map((c) => clip(c ?? "")));
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...cells.map((r) => (r[i] ?? "").length)),
  );
  const line = (cols: string[]): string =>
    cols.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ").trimEnd();
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  return [line(headers), sep, ...cells.map(line)].join("\n");
}

/** Render a `show` detail block: aligned `key: value` lines; multi-line
 *  values (formulas) start on their own line, indented. */
export function detailBlock(pairs: Array<[string, string | null | undefined]>): string {
  const present = pairs.filter(([, v]) => v !== null && v !== undefined && v !== "");
  const w = Math.max(0, ...present.map(([k]) => k.length));
  return present
    .map(([k, v]) => {
      const val = String(v);
      if (val.includes("\n")) {
        return `${k}:\n${val
          .split("\n")
          .map((l) => "  " + l)
          .join("\n")}`;
      }
      return `${(k + ":").padEnd(w + 1)} ${val}`;
    })
    .join("\n");
}

export function yesNo(b: boolean): string {
  return b ? "yes" : "no";
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
