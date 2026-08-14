// FILENAME: app/extensions/ModelEditor/cli/modelCompletion.ts
// PURPOSE: Live object-name suggestions for the MODEL domain's CLI
//          completion, from a ModelOverview. ONE copy, two consumers: the
//          Model Editor window's language context (cliLanguage.ts, which
//          holds the current overview) and the main-window panel's generic
//          engine context (modelDomain.ts kind specs, which read the bound
//          session's overview).

import type { ModelOverview } from "@api";
import { cliNameInsert } from "../../_shared/cli/language";
import type { CliNameSuggestion } from "../../_shared/cli/registry";
import type { Kind } from "./parse";

/** Live object-name suggestions for one kind, from one overview. */
export function modelNameSuggestions(
  overview: ModelOverview | null,
  kind: Kind,
): CliNameSuggestion[] {
  const o = overview;
  if (!o) return [];
  switch (kind) {
    case "table":
      return o.tables.map((t) => ({ label: t.name, insert: cliNameInsert(t.name), detail: "table" }));
    case "measure":
      return o.measures.map((m) => ({ label: `[${m.name}]`, insert: `[${m.name}]`, detail: `measure on ${m.table}` }));
    case "column":
      return o.tables.flatMap((t) =>
        t.columns.map((c) => ({
          label: `${t.name}[${c.name}]`,
          insert: `${cliNameInsert(t.name)}[${c.name}]`,
          detail: c.dataType,
        })),
      );
    case "relationship":
      return o.relationships.map((r) => ({
        label: r.name,
        insert: cliNameInsert(r.name),
        detail: `${r.fromTable} -> ${r.toTable}`,
      }));
    case "hierarchy":
      return o.hierarchies.map((h) => ({ label: h.name, insert: cliNameInsert(h.name), detail: h.table }));
    case "kpi":
      return o.kpis.map((k) => ({ label: k.name, insert: cliNameInsert(k.name), detail: k.baseMeasure }));
    case "role":
      return o.securityRoles.map((r) => ({ label: r.name, insert: cliNameInsert(r.name), detail: "role" }));
    case "perspective":
      return o.perspectives.map((p) => ({ label: p.name, insert: cliNameInsert(p.name), detail: "perspective" }));
    case "culture":
    case "translation":
      return o.cultures.map((c) => ({ label: c.locale, insert: c.locale, detail: "culture" }));
    case "calcgroup":
      return o.calculationGroups.map((g) => ({ label: g.name, insert: cliNameInsert(g.name), detail: "calc group" }));
    case "calcitem":
      return o.calculationGroups.flatMap((g) =>
        g.items.map((i) => ({
          label: `${g.name}[${i.name}]`,
          insert: `${cliNameInsert(g.name)}[${i.name}]`,
          detail: "calc item",
        })),
      );
    case "calctable":
      return o.globalVariables.map((g) => ({
        label: g.name,
        insert: cliNameInsert(g.name),
        detail: g.dynamic ? "dynamic" : "materialized",
      }));
    case "tablevar":
      return o.tableVariables.map((v) => ({ label: v.name, insert: cliNameInsert(v.name), detail: v.source }));
    case "scriptfunction":
      return o.scriptFunctions.map((f) => ({ label: f.name, insert: cliNameInsert(f.name), detail: f.returnType }));
    case "context":
      return o.contexts.map((c) => ({ label: c.name, insert: cliNameInsert(c.name), detail: "context" }));
    case "contextcolumn":
      return o.contextColumns.map((c) => ({ label: c.name, insert: cliNameInsert(c.name), detail: c.table }));
    case "writeback":
      return o.writebackColumns.map((w) => ({ label: w.name, insert: cliNameInsert(w.name), detail: w.table }));
    case "source":
      return o.sources.map((src) => ({
        label: src.displayName ?? src.id,
        insert: cliNameInsert(src.displayName ?? src.id),
        detail: src.kind,
      }));
    default:
      return [];
  }
}
