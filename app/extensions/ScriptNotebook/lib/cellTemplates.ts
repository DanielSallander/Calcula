//! FILENAME: app/extensions/ScriptNotebook/lib/cellTemplates.ts
// PURPOSE: Starter cell sources offered from the notebook toolbar.
// CONTEXT: Discoverability door named in the Phase 3 plan — `model.*` is the
//          notebook's differentiator (the app's only measure-evaluate surface),
//          and an empty cell teaches nobody it exists. The template is plain
//          text: it grants nothing, and the first `model.*` call it makes still
//          faces the per-notebook bi.query consent prompt.

/** "Model query…" — the read-only model API, in the order you would use it. */
export const MODEL_QUERY_TEMPLATE = [
  "// Read-only model query. The first call asks for the `bi.query` capability",
  "// (per notebook, revocable in Settings > Script Security); every call is",
  "// recorded in this workbook's audit trail.",
  "",
  "// 1. Which models can this workbook see?",
  "const conns = model.connections();",
  "console.log(conns.map((c) => `${c.name} (${c.id})`).join('\\n'));",
  "",
  "// 2. What does one of them define? (tables, columns, measures, KPIs)",
  "// const info = model.info(conns[0].id);",
  "// console.log(info.measures.map((m) => m.name).join(', '));",
  "",
  "// 3. Evaluate measures at a grain. The result auto-renders as a table when",
  "//    it is the cell's last expression; .objects() and .toGrid(row, col) are",
  "//    on it too.",
  "// model.query(conns[0].id, {",
  "//   measures: ['Revenue'],",
  "//   groupBy: [{ table: 'dim_date', column: 'Year' }],",
  "//   filters: [{ table: 'dim_region', column: 'Region', operator: '=', value: 'EMEA' }],",
  "// });",
  "",
].join("\n");
