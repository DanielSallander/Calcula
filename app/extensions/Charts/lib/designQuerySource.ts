//! FILENAME: app/extensions/Charts/lib/designQuerySource.ts
// PURPOSE: The design-query source a Charts door writes when it REWRITES a
//          chart's `data` (the Insert / Edit Chart dialog's full replace, the
//          object pane's `commitDesignQuery` deep-merge patch), and what becomes
//          of the application connection's stable key on the way.
// CONTEXT: `DesignQueryDataSource.packageDataSourceId` is the stable key of an
//          APPLICATION connection (docs/design/model-drillthrough.md 2.10). Rust
//          stamps it at the serialization boundary from the LIVE connection on
//          every save, AutoRecover and publish/push (`collect_charts_for_save`),
//          and its remap prefers it on pull, refresh and open -- so the TS store
//          never has to WRITE it, but it must never keep a WRONG one:
//            - the connection is UNCHANGED: keep the key. A Rust-stamped key is
//              what heals a chart whose uuid died with the previous session (a
//              subscriber's connections are re-minted on every open); the dialog's
//              full replace used to strip it.
//            - the connection CHANGED: drop the key, explicitly. The store's deep
//              merge keeps any key a patch leaves out, and the remap tries the key
//              FIRST, so a stale one re-binds the chart to its OLD application
//              connection at the next refresh or open and silently undoes the
//              user's choice. An explicit `undefined` clears in the deep merge and
//              is simply absent from a full replace and from the saved JSON.

import type { DataSource, DesignQueryDataSource } from "../types";
import { isDesignQueryDataSource } from "../types";

/**
 * The design-query source for `(dslText, connectionId)` written over `previous`
 * (the chart's current `data`, or null for a new chart). See the file header.
 */
export function designQuerySourceFor(
  dslText: string,
  connectionId: string,
  previous: DataSource | null | undefined,
): DesignQueryDataSource {
  const source: DesignQueryDataSource = { type: "designQuery", dslText, connectionId };
  const prior = previous != null && isDesignQueryDataSource(previous) ? previous : null;
  // No key to keep or to clear: write none (a new chart, a range chart turned
  // into a design query, a design-query chart on a local connection).
  if (prior === null || prior.packageDataSourceId === undefined) return source;
  const priorKey: unknown = prior.packageDataSourceId;
  const keep = prior.connectionId === connectionId && typeof priorKey === "string" && priorKey !== "";
  // Kept while the connection is unchanged; otherwise an explicit undefined,
  // which CLEARS the old key in the store's deep merge (a key left out of the
  // patch would be kept).
  source.packageDataSourceId = keep ? (priorKey as string) : undefined;
  return source;
}
