/**
 * Collaboration (.calp) flows for fixall-calp.spec.ts, each driven through the
 * @api/collaboration functions the dialogs themselves call, followed by the
 * SAME announcements the dialog makes afterwards (SubscribeDialog,
 * RefreshPreviewDialog, PublishDialog). A flow that skipped the announcements
 * would test a backend the user never sees.
 */
import type { Page } from "@playwright/test";
import { COLLAB, bounded, callModule, emitApp, installAppImport, sheets } from "./calp-harness";
import type { AppWindow } from "./calp-harness";

export interface PublishResult {
  packageName: string;
  version: string;
  sheetsPublished: number;
  warnings: string[];
}

/** First publish of an application (createNew), every sheet of the workbook unless named. */
export async function publishNew(page: Page, workspace: string, app: string, version: string, sheetIndices: number[] = []): Promise<PublishResult> {
  return callModule<PublishResult>(page, COLLAB, "publishApplication", [
    {
      registryPath: workspace,
      packageName: app,
      version,
      kind: "report",
      sheetIndices,
      publishedBy: "",
      includeComments: false,
      mode: "createNew",
      changeSummary: "first",
    },
  ]);
}

export interface WorkingCopyStatus {
  baseVersion: string;
  packageName: string;
  registryUrl: string;
  baseSheets: Array<{ sheetId: string; name: string }>;
}

export async function workingCopy(page: Page): Promise<WorkingCopyStatus | null> {
  return callModule<WorkingCopyStatus | null>(page, COLLAB, "workingCopyStatus");
}

/** The sheet indices the push dialog ticks by default (publishPreview's answer). */
export async function pushDefaultIndices(page: Page, workspace: string, app: string): Promise<number[]> {
  const p = await callModule<{ defaultSheetIndices?: number[] }>(page, COLLAB, "publishPreview", [undefined, false, { registryPath: workspace, packageName: app }]);
  return p.defaultSheetIndices ?? [];
}

/**
 * A push, the way PublishDialog makes one: the default sheet selection, mode
 * "update" against the working copy's base, and -- when cells are held back --
 * hold back, publish, and ALWAYS put them back with a scoped undo.
 */
export async function push(
  page: Page,
  workspace: string,
  app: string,
  version: string,
  holdBack: Array<{ sheetId: string; row: number; col: number }> = [],
): Promise<PublishResult> {
  const wc = await workingCopy(page);
  if (!wc) throw new Error("push: this workbook is not a working copy");
  const sheetIndices = await pushDefaultIndices(page, workspace, app);
  let holdBackSeq: number | null = null;
  if (holdBack.length > 0) {
    const r = await callModule<{ undoRecorded: boolean; undoSeq?: number | null; cellsHeldBack: number }>(page, COLLAB, "holdBackCells", [
      { registryPath: workspace, packageName: app, baseVersion: wc.baseVersion, cells: holdBack },
    ]);
    holdBackSeq = r.undoSeq ?? null;
    if (r.undoRecorded && holdBackSeq === null) throw new Error("hold-back recorded an undo step with no id");
  }
  try {
    return await callModule<PublishResult>(page, COLLAB, "publishApplication", [
      {
        registryPath: workspace,
        packageName: app,
        version,
        kind: "report",
        sheetIndices,
        publishedBy: "",
        includeComments: false,
        mode: "update",
        expectedBaseVersion: wc.baseVersion,
        changeSummary: `push ${version}`,
      },
    ]);
  } finally {
    if (holdBackSeq !== null) {
      await callModule(page, "/src/core/lib/tauri-api.ts", "undo", [holdBackSeq]);
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("grid:refresh")));
    }
  }
}

export interface PullResult {
  packageName: string;
  resolvedVersion: string;
  sheetsPulled: number;
  scriptsPulled: number;
  firstPulledSheetIndex?: number | null;
}

/** Subscribe the way SubscribeDialog does, including what it announces afterwards. */
export async function subscribe(page: Page, workspace: string, app: string, versionPin = "latest"): Promise<PullResult> {
  const r = await callModule<PullResult>(page, COLLAB, "subscribeToApplication", [
    { registryPath: workspace, packageName: app, versionPin, environment: null, followLine: false },
  ]);
  await emitApp(page, "SHEET_CHANGED", {});
  const first = r.firstPulledSheetIndex;
  if (first !== undefined && first !== null) {
    await callModule(page, "/src/api/index.ts", "setActiveSheetApi", [first]);
    const s = await sheets(page);
    await emitApp(page, "SHEET_CHANGED", { sheetIndex: first, sheetName: s.sheets.find((x) => x.index === first)?.name ?? "" });
  }
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("controlspane:controls-refreshed")));
  await emitApp(page, "PACKAGE_UPDATED", {
    packageName: r.packageName,
    version: r.resolvedVersion,
    kind: "subscribe",
    sheetsPulled: r.sheetsPulled,
    scriptsPulled: r.scriptsPulled,
  });
  await page.waitForTimeout(600);
  return r;
}

export interface ConflictCell {
  sheetName: string;
  a1: string;
}
export interface SubscriptionPreview {
  packageName: string;
  newVersion: string;
  overridesConflicted: number;
  conflicts: ConflictCell[];
  cellsChanged: number;
}
export interface RefreshPreview {
  subscriptionPreviews: SubscriptionPreview[];
  totalOverridesConflicted: number;
  conflictsExact: boolean;
}

export async function refreshPreview(page: Page): Promise<RefreshPreview> {
  return callModule<RefreshPreview>(page, COLLAB, "refreshPreview");
}

/** Apply the previewed refresh the way RefreshPreviewDialog does (no resolutions). */
export async function refreshApply(page: Page, preview: RefreshPreview): Promise<{ subscriptionsRefreshed: number; conflictsCreated: number }> {
  const previewedVersions = preview.subscriptionPreviews.map((sp) => ({
    registryUrl: (sp as unknown as { registryUrl: string }).registryUrl,
    packageName: sp.packageName,
    newVersion: sp.newVersion,
  }));
  const r = await callModule<{ subscriptionsRefreshed: number; conflictsCreated: number }>(page, COLLAB, "refreshApply", [
    { resolutions: [], previewedVersions },
  ]);
  await callModule(page, "/src/api/dataAftermath.ts", "announceUnderlyingDataChanged", [{ forceCube: true, context: "Collaboration" }]);
  for (const sp of preview.subscriptionPreviews) {
    await emitApp(page, "PACKAGE_UPDATED", { packageName: sp.packageName, version: sp.newVersion, kind: "refresh", sheetsPulled: 0, scriptsPulled: null });
  }
  await page.waitForTimeout(600);
  return r;
}

/** Open an application for editing (Collaboration > Open Application for Editing). */
export async function checkout(page: Page, workspace: string, app: string, version?: string): Promise<{ version: string; firstSheetIndex?: number | null }> {
  const r = await callModule<{ version: string; firstSheetIndex?: number | null }>(page, COLLAB, "checkoutApplication", [
    { registryPath: workspace, packageName: app, ...(version ? { version } : {}) },
  ]);
  await page.waitForTimeout(800);
  return r;
}

export interface DiffTotals {
  objectsAdded: number;
  objectsRemoved: number;
  objectsModified: number;
  cellsChanged: number;
}
export interface VersionDiff {
  totals: DiffTotals;
  sheets: Array<{
    sheetId: string;
    name: string;
    change: string;
    cellsAdded: number;
    cellsRemoved: number;
    cellsModified: number;
    sample: Array<{ a1: string; change: string; before?: { formula?: string; display: string }; after?: { formula?: string; display: string } }>;
  }>;
  objects: Array<{ domain: string; name: string; change: string; detail: string; sheetName?: string }>;
  manifestChanges: Array<{ field: string }>;
}

/** What the push dialog shows: the diff for the default selection. */
export async function pushDiff(page: Page, workspace: string, app: string): Promise<VersionDiff> {
  const sheetIndices = await pushDefaultIndices(page, workspace, app);
  const r = await callModule<{ diff: VersionDiff }>(page, COLLAB, "diffWorkingCopy", [{ sheetIndices, includeComments: false }]);
  return r.diff;
}

/** VersionDiffView's own "No differences" predicate. */
export function diffIsEmpty(d: VersionDiff): boolean {
  const cellTotal = (s: VersionDiff["sheets"][number]) => s.cellsAdded + s.cellsRemoved + s.cellsModified;
  return (
    d.totals.cellsChanged === 0 &&
    d.totals.objectsAdded === 0 &&
    d.totals.objectsRemoved === 0 &&
    d.totals.objectsModified === 0 &&
    d.sheets.every((s) => s.change === "modified" && cellTotal(s) === 0) &&
    d.manifestChanges.length === 0
  );
}

/** A short account of a diff, for assertion messages. */
export function describeDiff(d: VersionDiff): string {
  return JSON.stringify({
    totals: d.totals,
    sheets: d.sheets.filter((s) => s.change !== "modified" || s.cellsAdded + s.cellsRemoved + s.cellsModified > 0).map((s) => ({
      name: s.name,
      change: s.change,
      sample: s.sample.map((c) => `${c.a1}:${c.before?.formula ?? c.before?.display ?? ""}->${c.after?.formula ?? c.after?.display ?? ""}`),
    })),
    objects: d.objects.map(
      (o) =>
        `${o.domain}/${o.name}/${o.change}/${o.detail}` +
        ((o as { before?: string }).before !== undefined ? ` BEFORE=${String((o as { before?: string }).before).slice(0, 400)}` : "") +
        ((o as { after?: string }).after !== undefined ? ` AFTER=${String((o as { after?: string }).after).slice(0, 400)}` : ""),
    ),
    manifest: d.manifestChanges.map((m) => m.field),
  }).slice(0, 3000);
}

/** The subscriber's "View changes" diff, exactly as SubscriptionDiffDialog asks for it. */
export async function subscriberDiff(page: Page, app: string): Promise<VersionDiff> {
  const subs = await callModule<{ subscriptions: Array<{ packageName: string; registryUrl: string; resolvedVersion: string }> }>(page, COLLAB, "getSubscriptions");
  const sub = subs.subscriptions.find((s) => s.packageName === app);
  if (!sub) throw new Error(`no subscription to ${app}`);
  const rows = await callModule<Array<{ role: string; packageName: string; registryUrl: string; upstreamRemoved?: boolean; sheetIndex: number; packageSheetId: string }>>(
    page,
    COLLAB,
    "getSheetProvenance",
  );
  const mine = rows.filter((r) => r.role === "subscribed" && r.packageName === app && r.registryUrl === sub.registryUrl && !r.upstreamRemoved);
  const r = await callModule<{ diff: VersionDiff }>(page, COLLAB, "diffWorkingCopy", [
    {
      registryPath: sub.registryUrl,
      packageName: app,
      baseVersion: sub.resolvedVersion,
      sheetIndices: mine.map((x) => x.sheetIndex),
      includeComments: true,
      scopeSheetIds: mine.map((x) => x.packageSheetId),
    },
  ]);
  return r.diff;
}

export async function detachSheet(page: Page, sheetIndex: number): Promise<void> {
  await callModule(page, COLLAB, "detachSheet", [sheetIndex]);
  await page.waitForTimeout(300);
}

export async function overrides(page: Page): Promise<Array<{ sheetId: string; position: [number, number]; current: { type: string; formula?: string; display?: string }; conflict: boolean }>> {
  const layer = await callModule<{ overrides: Array<{ sheetId: string; position: [number, number]; current: { type: string; formula?: string; display?: string }; conflict: boolean }> }>(
    page,
    COLLAB,
    "getOverrides",
  );
  return layer.overrides;
}

/** Wait until a background module finished any write it scheduled (debounced chart saves etc.). */
export async function settle(page: Page, ms = 600): Promise<void> {
  await installAppImport(page);
  await bounded("settle", page.waitForTimeout(ms));
}

export type { AppWindow };
