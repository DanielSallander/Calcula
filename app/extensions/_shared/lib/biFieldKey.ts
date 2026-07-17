/**
 * Splitting of BI field keys ("Table.Column" strings).
 *
 * Field keys are built as `${table}.${column}`, but table names can
 * themselves contain dots (schema-qualified sources like "BI.dim_customer"),
 * so a naive first-dot split mis-attributes the table (key
 * "BI.dim_customer.fullname" would yield table "BI"). When the model's table
 * names are available, the longest table name that prefixes the key wins;
 * otherwise fall back to the first-dot split (correct for dot-free tables).
 */
export function splitBiFieldKey(
  name: string,
  tableNames?: Iterable<string> | null,
): { table: string; column: string } {
  if (tableNames) {
    let best = '';
    for (const t of tableNames) {
      if (
        t.length > best.length &&
        name.length > t.length + 1 &&
        name.charCodeAt(t.length) === 46 /* '.' */ &&
        name.startsWith(t)
      ) {
        best = t;
      }
    }
    if (best) return { table: best, column: name.substring(best.length + 1) };
  }
  const dot = name.indexOf('.');
  if (dot === -1) return { table: '', column: name };
  return { table: name.substring(0, dot), column: name.substring(dot + 1) };
}
