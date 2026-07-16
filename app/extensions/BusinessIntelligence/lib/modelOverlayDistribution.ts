//! FILENAME: app/extensions/BusinessIntelligence/lib/modelOverlayDistribution.ts
// PURPOSE: Model overlays (model-extensibility Phase 4). Lets a report package
//          carry WORKBOOK-LAYER calculated measures defined against a
//          subscribed dataset, so a subscriber who pulls the report (and also
//          subscribes to the dataset) gets the publisher's extra measures.
//
//          Overlays materialize into the WORKBOOK layer (biSetCalculatedMeasures
//          -> build_combined_model re-applies them on top of the base), never
//          into the base model — so the read-only-subscribed-model rule is
//          preserved STRUCTURALLY: the publisher's dataset is never edited, and
//          overlay measures re-apply on package refresh like any other
//          workbook-layer object.
//
//          Collision policy (design doc §8.3): the PUBLISHER wins — an overlay
//          measure whose name a base-model measure also uses is skipped and
//          flagged "shadowed" (it may have been added to the dataset after the
//          overlay was authored).

import {
  registerDistributableObjectProvider,
  type DistributableObjectPayload,
  type PulledDistributableObject,
} from "@api/distributableObjects";
import {
  biGetConnections,
  biGetCalculatedMeasures,
  biSetCalculatedMeasures,
  biModelGetMeasures,
  type CalculatedMeasure,
} from "@api";

const OVERLAY_KIND = "calcula.modelOverlay";

interface ModelOverlayPayload {
  /** Stable dataset identity (the package data-source id both the publisher's
   *  and the subscriber's connections carry). */
  packageDataSourceId: string;
  /** Fallback match + display context. */
  connectionName: string;
  measures: CalculatedMeasure[];
}

/** Collect: one overlay per package-subscribed connection that carries
 *  workbook calculated measures. Local (non-subscribed) connections publish
 *  their measures inside the dataset itself — nothing to overlay. */
async function collect(): Promise<DistributableObjectPayload[]> {
  const connections = await biGetConnections().catch(() => []);
  const out: DistributableObjectPayload[] = [];
  for (const conn of connections) {
    if (!conn.packageDataSourceId) continue;
    const measures = await biGetCalculatedMeasures(String(conn.id)).catch(
      () => [] as CalculatedMeasure[],
    );
    if (measures.length === 0) continue;
    const payload: ModelOverlayPayload = {
      packageDataSourceId: conn.packageDataSourceId,
      connectionName: conn.name,
      measures,
    };
    out.push({
      kind: OVERLAY_KIND,
      id: `overlay:${conn.packageDataSourceId}`,
      name: `Model overlay — ${conn.name} (${measures.length} measure${measures.length === 1 ? "" : "s"})`,
      payload: payload as unknown as Record<string, unknown>,
    });
  }
  return out;
}

/** Materialize: merge overlay measures into the matching connection's
 *  workbook layer. Declarative payloads auto-apply (they are inert data —
 *  signed + hash-verified by the channel, interpreted only by this provider);
 *  base-model name collisions are skipped ("shadowed", publisher wins). */
async function materialize(objects: PulledDistributableObject[]): Promise<void> {
  if (objects.length === 0) return;
  const connections = await biGetConnections().catch(() => []);
  for (const obj of objects) {
    const p = obj.payload as unknown as ModelOverlayPayload;
    if (!p?.packageDataSourceId || !Array.isArray(p.measures)) continue;
    const target =
      connections.find((c) => c.packageDataSourceId === p.packageDataSourceId) ??
      connections.find((c) => c.name === p.connectionName);
    if (!target) {
      console.warn(
        `[modelOverlay] '${obj.name}' skipped: no connection for dataset ${p.packageDataSourceId} — subscribe to the dataset first, then refresh this package`,
      );
      continue;
    }
    const connId = String(target.id);

    // Publisher wins: a base-model measure with the same name shadows the
    // overlay entry (flagged, never silently replaced).
    const baseNames = new Set(
      (await biModelGetMeasures(connId).catch(() => [])).map((m) => m.name.toLowerCase()),
    );
    const applied: CalculatedMeasure[] = [];
    const shadowed: string[] = [];
    for (const m of p.measures) {
      if (!m?.name || typeof m.expression !== "string") continue;
      if (baseNames.has(m.name.toLowerCase())) {
        shadowed.push(m.name);
      } else {
        applied.push({ name: m.name, expression: m.expression });
      }
    }
    if (shadowed.length > 0) {
      console.warn(
        `[modelOverlay] ${shadowed.length} overlay measure(s) shadowed by the publisher's model on '${target.name}': ${shadowed.join(", ")}`,
      );
    }
    if (applied.length === 0) continue;

    // Merge into the existing workbook layer: overlay entries replace
    // same-named workbook measures (refresh = re-apply), others are kept.
    const appliedNames = new Set(applied.map((m) => m.name.toLowerCase()));
    const existing = await biGetCalculatedMeasures(connId).catch(
      () => [] as CalculatedMeasure[],
    );
    const merged = [
      ...existing.filter((m) => !appliedNames.has(m.name.toLowerCase())),
      ...applied,
    ];
    try {
      await biSetCalculatedMeasures(connId, merged);
      console.log(
        `[modelOverlay] applied ${applied.length} overlay measure(s) to '${target.name}'`,
      );
    } catch (e) {
      console.error(`[modelOverlay] failed to apply overlay to '${target.name}':`, e);
    }
  }
}

/** Register the model-overlay distributable-object provider. Returns cleanup. */
export function registerModelOverlayDistribution(): () => void {
  return registerDistributableObjectProvider({
    kind: OVERLAY_KIND,
    collect,
    materialize,
  });
}
