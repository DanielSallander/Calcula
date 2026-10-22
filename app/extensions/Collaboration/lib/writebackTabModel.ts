// FILENAME: app/extensions/Collaboration/lib/writebackTabModel.ts
// PURPOSE: The contextual Writeback ribbon tab's model: which region is under
//          Core's active cell, whether an action is running, what the Status
//          lines say, and the four actions (Submit, Submit All, Discard Drafts,
//          Check Status) plus opening the pane -- and, for the PUBLISHER of a
//          region this workbook designated, Edit Region, Remove Region and
//          Collected Responses.
// CONTEXT: Kept apart from the selection handler (lib/writebackTab.ts) because
//          the handler imports the panel definition, the panel definition
//          imports the sections, and the sections import THIS -- one module
//          further and the chain would be a cycle.
//
//          Every action ends in `refreshWriteback()`, which re-reads the shared
//          snapshot, notifies the grid markers, the pane and this tab, and asks
//          the grid to repaint: a submit can no longer leave cells looking
//          unsent. Every action that sends or throws away the subscriber's
//          values asks first with `confirmAsync`, which fails CLOSED (a dialog
//          that cannot be shown is a refusal), and the submit question lists
//          exactly which values leave the machine and where they go -- the
//          same outbound preview the pane's two-step review shows.

import {
  previewRegionSubmission,
  submitRegion,
  submitAllRegions,
  discardWritebackDrafts,
  removeWritebackRegion,
  type OutboundSubmissionPreview,
  type WritebackRegionDeclaration,
} from "@api/collaboration";
import { sentAsText } from "./senderLabel";
import { confirmAsync, alertAsync } from "@api/dialogs";
import { showToast } from "@api/notifications";
import { focusCollectedResponsesRegion } from "./collectedResponsesFocus";
import { openTaskPane, showTaskPaneContainer, showDialog } from "@api/ui";
import { refreshGridData } from "@api/grid";
import { emitAppEvent, AppEvents } from "@api/events";
import { refuseIfSelectionOwned } from "@api/selectionOwner";
import { formatNumber, formatDateTime } from "@api/locale";
import { columnToLetter } from "@api/types";
import {
  refreshWriteback,
  getRegionSummary,
  listRegionSummaries,
  getWritebackReconcileError,
  getWritebackRefreshError,
  getDesignatedRegion,
  regionRangeA1,
  type WritebackRegionSummary,
  type WritebackVisibility,
} from "./writebackStore";
import {
  WRITEBACK_PANE_ID,
  PUBLISHER_DASHBOARD_PANE_ID,
  DESIGNATE_WRITEBACK_DIALOG_ID,
  WRITEBACK_REGIONS_CHANGED_EVENT,
} from "./writebackIds";

// ============================================================================
// Tab state: the region under Core's active cell, and "an action is running"
// ============================================================================

let tabRegionId: string | null = null;
let busy = false;
let version = 0;
const listeners = new Set<() => void>();

function notify(): void {
  version++;
  for (const cb of Array.from(listeners)) {
    try {
      cb();
    } catch (err) {
      console.error("[writebackTab] a tab-state listener threw:", err);
    }
  }
}

/** Subscribe to tab-state changes (useSyncExternalStore-shaped). */
export function subscribeWritebackTabState(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Bumped on every tab-state change. */
export function getWritebackTabStateVersion(): number {
  return version;
}

/** The region under Core's active cell, or null (set by the selection handler). */
export function getWritebackTabRegionId(): string | null {
  return tabRegionId;
}

/** Called by the selection handler only. */
export function setWritebackTabRegionId(regionId: string | null): void {
  if (regionId === tabRegionId) return;
  tabRegionId = regionId;
  notify();
}

/** True while Submit / Submit All / Discard / Check Status is running. */
export function isWritebackActionBusy(): boolean {
  return busy;
}

function setBusy(next: boolean): void {
  if (busy === next) return;
  busy = next;
  notify();
}

/** Test seam: forget the region and the busy flag. */
export function resetWritebackTabModel(): void {
  tabRegionId = null;
  publisherRegionId = null;
  busy = false;
  notify();
}

// ============================================================================
// Words
// ============================================================================

/** A count in the app locale ("1 234" in sv-SE). */
export function countText(n: number): string {
  return formatNumber(n, { decimals: 0, grouping: true });
}

/** "1 value" / "1 234 values", the count in the app locale. */
export function valuesText(n: number): string {
  return `${countText(n)} value${n === 1 ? "" : "s"}`;
}

const values = valuesText;

/** Who sees what the subscriber enters, in the subscriber's words. */
export function visibilitySentence(v: WritebackVisibility | undefined): string {
  switch (v) {
    case "own_only":
      return "Only the publisher sees your values";
    case "own_plus_aggregate":
      // What the read side does (apply_gather_governance): every value reaches
      // other subscribers' GATHER, with the submitter's name replaced. Not
      // "only totals" -- that would promise a privacy the backend does not give.
      return "The publisher sees your values; other subscribers see each value without your name";
    case "transparent":
    default:
      // Rust resolves the default: a declaration naming no visibility applies
      // no filter, which is what "transparent" means.
      return "Everyone subscribed can see your values";
  }
}

/** The tone a status line is painted and iconed in. */
export type WritebackStatusTone = "warn" | "danger" | "info" | "ok";

export interface WritebackStatusLine {
  tone: WritebackStatusTone;
  text: string;
}

/**
 * The two Status lines for a region: its state first (with the due date when
 * it has a deadline), then who sees the input. Two lines exactly, because a
 * ribbon section holds two rows.
 */
export function statusLinesFor(s: WritebackRegionSummary): [WritebackStatusLine, WritebackStatusLine] {
  let state: WritebackStatusLine;
  const cells = s.draftCount + s.submittedCount + s.approvedCount + s.rejectedCount + s.emptyCount;
  // "All sent" is a lie while cells are still empty: say how many are filled.
  const filled =
    s.emptyCount > 0 ? ` (${countText(cells - s.emptyCount)} of ${countText(cells)} filled)` : "";
  if (s.draftCount > 0) {
    state = { tone: "warn", text: `${countText(s.draftCount)} not sent` };
  } else if (s.rejectedCount > 0) {
    state = {
      tone: "danger",
      text: `${countText(s.rejectedCount)} rejected - fix and submit again`,
    };
  } else if (s.submittedCount > 0) {
    // WHAT A SENT VALUE DOES DEPENDS ON THE POLICY. Under on_approval the
    // publisher's approval decides whether it counts; otherwise (on_submit,
    // immediate) it counts as soon as it arrives -- there is no review to wait for.
    state =
      s.submissionPolicy === "on_approval"
        ? { tone: "info", text: `Sent - waiting for the publisher's approval${filled}` }
        : { tone: "ok", text: `Sent - the publisher can see them${filled}` };
  } else if (s.approvedCount > 0) {
    state = { tone: "ok", text: `All approved${filled}` };
  } else if (s.submissionPolicy === "immediate") {
    state = { tone: "info", text: "Nothing entered yet - values are sent as you type" };
  } else {
    state = { tone: "info", text: "Nothing entered yet" };
  }
  if (s.deadline) {
    const due = formatDateTime(s.deadline);
    if (due) state = { ...state, text: `${state.text} - due ${due}` };
  }
  return [state, { tone: "info", text: visibilitySentence(s.visibility) }];
}

function applicationLabel(s: { applicationName: string }): string {
  return s.applicationName ? `"${s.applicationName}"` : "the publisher";
}

/** Whether Submit is offered for a region, and the tooltip that says why. */
export function submitButtonState(s: WritebackRegionSummary | null): {
  disabled: boolean;
  tooltip: string;
} {
  if (!s) {
    return { disabled: true, tooltip: "Select a cell in a writeback region first" };
  }
  if (s.draftCount === 0) {
    return {
      disabled: true,
      tooltip:
        s.submissionPolicy === "immediate"
          ? `Nothing to send: values in ${s.rangeA1} are sent to ${applicationLabel(s)} as you type`
          : `Nothing to send: every value in ${s.rangeA1} has been sent or nothing was entered`,
    };
  }
  return {
    disabled: false,
    tooltip:
      s.submissionPolicy === "immediate"
        ? `Send again the ${values(s.draftCount)} in ${s.rangeA1} that could not be sent as you typed, to ${applicationLabel(s)}`
        : `Send ${values(s.draftCount)} in ${s.rangeA1} to ${applicationLabel(s)}`,
  };
}

/** Whether Submit All is offered, and why. */
export function submitAllButtonState(total: number): { disabled: boolean; tooltip: string } {
  if (total === 0) {
    return { disabled: true, tooltip: "Nothing to send: no writeback region has unsent values" };
  }
  return {
    disabled: false,
    tooltip: `Send all ${values(total)} not yet sent, in every writeback region`,
  };
}

/** Whether Discard Drafts is offered for a region, and why. */
export function discardButtonState(s: WritebackRegionSummary | null): {
  disabled: boolean;
  tooltip: string;
} {
  if (!s) {
    return { disabled: true, tooltip: "Select a cell in a writeback region first" };
  }
  if (s.draftCount === 0) {
    return { disabled: true, tooltip: `Nothing to discard: ${s.rangeA1} has no unsent values` };
  }
  return {
    disabled: false,
    tooltip:
      `Throw away the ${values(s.draftCount)} not yet sent in ${s.rangeA1}; ` +
      `each cell goes back to what you last sent. Needs the workspace, to look up ` +
      `what you sent; it cannot be undone and it clears the Undo history`,
  };
}

// ============================================================================
// The outbound summary a confirm shows
// ============================================================================

/** At most this many values are listed in a confirm; the rest are counted. */
export const CONFIRM_VALUE_LINES = 12;

function cellA1(row: number, col: number): string {
  return `${columnToLetter(col)}${row + 1}`;
}

/** One outbound value as the subscriber typed it: a number in the APP locale
 *  (the backend sends it invariant, "1.5"), never the invariant spelling; a
 *  cleared cell as "(cleared)". Shared by the confirm and the pane's review. */
export function outboundValueText(v: OutboundSubmissionPreview["values"][number]): string {
  if (v.valueKind === "empty") return "(cleared)";
  if (v.valueKind === "number") {
    const n = Number(v.valueDisplay);
    return Number.isFinite(n) ? formatNumber(n) : v.valueDisplay;
  }
  return v.valueDisplay;
}

function valueLine(v: OutboundSubmissionPreview["values"][number]): string {
  return `  ${cellA1(v.cellRow, v.cellCol)} = ${outboundValueText(v)}`;
}

/**
 * The confirm text for one or more outbound previews: per destination, the
 * application, the workspace and who it is sent as, then the values (capped).
 */
export function outboundConfirmText(previews: readonly OutboundSubmissionPreview[]): string {
  const total = previews.reduce((n, p) => n + p.values.length, 0);
  const apps = Array.from(new Set(previews.map((p) => p.packageName).filter((x) => x)));
  const head =
    apps.length === 1
      ? `Send ${values(total)} to "${apps[0]}"?`
      : `Send ${values(total)} to ${countText(apps.length)} applications?`;
  const lines: string[] = [head, ""];
  let listed = 0;
  for (const p of previews) {
    if (previews.length > 1 || apps.length !== 1) lines.push(`To "${p.packageName}":`);
    lines.push(`Workspace: ${p.registryPath}`);
    const sentAs = sentAsText(p);
    if (sentAs) lines.push(`Sent as: ${sentAs}`);
    for (const v of p.values) {
      if (listed >= CONFIRM_VALUE_LINES) break;
      lines.push(valueLine(v));
      listed++;
    }
    lines.push("");
  }
  if (total > listed) lines.push(`...and ${values(total - listed)} more.`, "");
  lines.push("Once sent, the publisher can see them.");
  return lines.join("\n");
}

/**
 * A preview that cannot be submitted, in the subscriber's words, or null.
 * Rust refuses these anyway (fail closed); saying so BEFORE the confirm keeps
 * the user from approving a send that is certain to fail.
 */
export function previewBlocker(p: OutboundSubmissionPreview): string | null {
  if (p.validatorError) return p.validatorError;
  if (p.validator && !p.validator.consented) {
    return (
      `"${p.packageName}" checks values with its own rule ("${p.validator.name}") before ` +
      `accepting them, and you have not approved that rule yet. Review and approve it ` +
      `in the Writeback Pane, then submit again.`
    );
  }
  return null;
}

// ============================================================================
// Actions
// ============================================================================

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Open the Writeback task pane. */
export function openWritebackPane(): void {
  openTaskPane(WRITEBACK_PANE_ID);
  showTaskPaneContainer();
}

async function runExclusive(work: () => Promise<void>): Promise<void> {
  if (busy) return;
  setBusy(true);
  try {
    await work();
  } finally {
    setBusy(false);
  }
}

async function readPreviews(regionIds: readonly string[]): Promise<OutboundSubmissionPreview[] | null> {
  const previews: OutboundSubmissionPreview[] = [];
  for (const id of regionIds) {
    try {
      previews.push(await previewRegionSubmission(id));
    } catch (err) {
      // Fail closed: no preview, no send. The user is never asked to approve
      // values they cannot see.
      showToast(`Could not prepare the values for sending: ${errorText(err)}`, {
        type: "error",
        duration: 8000,
      });
      return null;
    }
  }
  return previews;
}

async function refuseIfBlocked(previews: readonly OutboundSubmissionPreview[]): Promise<boolean> {
  for (const p of previews) {
    const blocker = previewBlocker(p);
    if (blocker) {
      await alertAsync(blocker, { title: "Cannot submit yet", kind: "warning" });
      if (p.validator && !p.validator.consented) openWritebackPane();
      return true;
    }
  }
  return false;
}

/**
 * Submit the unsent values of ONE region (the one under the cursor): show
 * what will leave the machine, ask, send, re-read, and say what happened.
 */
export async function submitWritebackRegion(regionId: string): Promise<void> {
  if (refuseIfSelectionOwned("Submit")) return;
  await runExclusive(async () => {
    const summary = getRegionSummary(regionId);
    if (!summary || summary.draftCount === 0) {
      showToast("Nothing to send in this region.", { type: "info", duration: 3000 });
      return;
    }
    const previews = await readPreviews([regionId]);
    if (!previews) return;
    const preview = previews[0];
    if (preview.values.length === 0) {
      showToast("Nothing to send in this region.", { type: "info", duration: 3000 });
      await refreshWriteback();
      return;
    }
    if (await refuseIfBlocked(previews)) return;
    const ok = await confirmAsync(outboundConfirmText(previews), {
      title: "Submit writeback values",
      okLabel: "Submit",
    });
    if (!ok) return;
    const app = preview.packageName || summary.applicationName || "the publisher";
    try {
      const sent = await submitRegion(regionId);
      showToast(`${values(sent)} sent to ${app}. The publisher can now see them.`, {
        type: "success",
        duration: 5000,
      });
    } catch (err) {
      showToast(`Could not submit: ${errorText(err)}`, { type: "error", duration: 8000 });
    } finally {
      await refreshWriteback();
    }
  });
}

/** Submit the unsent values of EVERY region, after one confirm that lists them. */
export async function submitAllWriteback(): Promise<void> {
  await runExclusive(async () => {
    const pending = listRegionSummaries().filter((s) => s.draftCount > 0);
    if (pending.length === 0) {
      showToast("Nothing to send.", { type: "info", duration: 3000 });
      return;
    }
    const previews = await readPreviews(pending.map((s) => s.regionId));
    if (!previews) return;
    const nonEmpty = previews.filter((p) => p.values.length > 0);
    if (nonEmpty.length === 0) {
      showToast("Nothing to send.", { type: "info", duration: 3000 });
      await refreshWriteback();
      return;
    }
    if (await refuseIfBlocked(nonEmpty)) return;
    const ok = await confirmAsync(outboundConfirmText(nonEmpty), {
      title: "Submit all writeback values",
      okLabel: "Submit All",
    });
    if (!ok) return;
    const apps = Array.from(new Set(nonEmpty.map((p) => p.packageName).filter((x) => x)));
    const where = apps.length === 1 ? apps[0] : `${countText(apps.length)} applications`;
    try {
      const sent = await submitAllRegions();
      showToast(`${values(sent)} sent to ${where}. The publisher can now see them.`, {
        type: "success",
        duration: 5000,
      });
    } catch (err) {
      showToast(`Could not submit: ${errorText(err)}`, { type: "error", duration: 8000 });
    } finally {
      await refreshWriteback();
    }
  });
}

/**
 * Throw away the unsent values of ONE region. Not undoable (the writeback
 * layer is outside the undo graph), so the confirm says so.
 */
export async function discardWritebackRegionDrafts(regionId: string): Promise<void> {
  if (refuseIfSelectionOwned("Discard Drafts")) return;
  await runExclusive(async () => {
    const summary = getRegionSummary(regionId);
    if (!summary || summary.draftCount === 0) {
      showToast("Nothing to discard in this region.", { type: "info", duration: 3000 });
      return;
    }
    const where = summary.sheetName ? `${summary.sheetName}!${summary.rangeA1}` : summary.rangeA1;
    const ok = await confirmAsync(
      `Discard the ${values(summary.draftCount)} not yet sent in ${where}?\n\n` +
        `Each cell goes back to the value you last sent, or becomes blank if you ` +
        `never sent one. This cannot be undone, and it clears the Undo history ` +
        `(so an earlier step cannot bring a discarded value back).`,
      { title: "Discard writeback drafts", okLabel: "Discard", kind: "warning" },
    );
    if (!ok) return;
    try {
      const result = await discardWritebackDrafts(regionId);
      if (result.discarded === 0) {
        showToast("Nothing was discarded: the region has no unsent values.", {
          type: "info",
          duration: 4000,
        });
      } else {
        // The restored cells changed in the backend: re-fetch what the grid
        // shows (a repaint alone would keep the discarded text on screen) and
        // tell cell listeners (charts, dependents' views).
        refreshGridData();
        emitAppEvent(AppEvents.CELLS_UPDATED);
        showToast(`${values(result.discarded)} discarded.`, { type: "success", duration: 4000 });
      }
    } catch (err) {
      showToast(`Could not discard: ${errorText(err)}`, { type: "error", duration: 8000 });
    } finally {
      await refreshWriteback();
    }
  });
}

/**
 * Ask the workspace for the publisher's decisions (approved / rejected) now.
 * ONE round-trip: every store read reconciles first, so a re-read IS the
 * check, and the store keeps why it could not reconcile. There is no
 * background poll on the subscriber side.
 */
export async function checkWritebackStatus(): Promise<void> {
  await runExclusive(async () => {
    await refreshWriteback();
    const problem = getWritebackReconcileError() ?? getWritebackRefreshError();
    if (problem) {
      showToast(`Could not reach the workspace to check: ${problem}`, {
        type: "warning",
        duration: 8000,
      });
      return;
    }
    showToast("Status updated", { type: "success", duration: 3000 });
  });
}

// ============================================================================
// Publisher side: the tab over one of THIS workbook's own designated regions
// ============================================================================
//
// The same "Writeback" tab, with the publisher's commands instead of the
// subscriber's: an author whose cursor is in a region they designated (in a
// fresh workbook or a working copy) edits or removes that region and opens the
// responses collected for it. The selection handler decides which role the
// tab is in; a cell is never both (a workbook cannot subscribe to the
// application it is a working copy of).

/** Which commands the tab shows: a subscriber's or a publisher's. */
export type WritebackTabRole = "subscriber" | "publisher";

let publisherRegionId: string | null = null;

/** The author's own region under Core's active cell, or null. */
export function getWritebackPublisherRegionId(): string | null {
  return publisherRegionId;
}

/** Called by the selection handler only. */
export function setWritebackPublisherRegionId(regionId: string | null): void {
  if (regionId === publisherRegionId) return;
  publisherRegionId = regionId;
  notify();
}

/** What a value-type id reads as in a sentence. */
export function valueTypeText(valueType: string | undefined): string {
  switch (valueType) {
    case "number":
      return "numbers";
    case "integer":
      return "whole numbers";
    case "text":
      return "text";
    case "boolean":
      return "TRUE/FALSE";
    case "date":
      return "dates";
    case "enum":
      return "a choice from a list";
    default:
      return "any value";
  }
}

/** When a subscriber's value reaches the publisher, in the publisher's words. */
export function submissionPolicyText(policy: string | undefined): string {
  switch (policy) {
    case "immediate":
      return "sent as soon as it is typed";
    case "on_approval":
      return "counted once you approve it";
    case "on_submit":
    default:
      return "sent when the subscriber submits";
  }
}

/** Who sees the collected values, in the publisher's words (same policy as
 *  {@link visibilitySentence}, which says it to the subscriber). */
export function publisherVisibilitySentence(v: string | undefined): string {
  switch (v) {
    case "own_only":
      return "Each subscriber sees only their own values";
    case "own_plus_aggregate":
      return "Subscribers see each other's values, without names";
    case "transparent":
    default:
      return "Every subscriber sees every value, with names";
  }
}

/** The publisher tab's two Status lines for one of this workbook's regions. */
export function publisherStatusLinesFor(
  d: WritebackRegionDeclaration,
): [WritebackStatusLine, WritebackStatusLine] {
  const sel = d.selector;
  const range = regionRangeA1(sel);
  return [
    {
      tone: "info",
      text: `${range}: ${valueTypeText(d.schema?.valueType)}, ${submissionPolicyText(d.submissionPolicy)}`,
    },
    { tone: "info", text: publisherVisibilitySentence(d.visibility) },
  ];
}

/** Open the Designate dialog in EDIT mode for one of this workbook's regions. */
export function editDesignatedRegion(regionId: string): void {
  if (refuseIfSelectionOwned("Edit Region")) return;
  const region = getDesignatedRegion(regionId);
  if (!region) {
    showToast("That writeback region no longer exists.", { type: "info", duration: 3000 });
    return;
  }
  showDialog(DESIGNATE_WRITEBACK_DIALOG_ID, { region });
}

/**
 * Remove one of this workbook's own writeback regions (it stops being
 * collected from the next publish/push on). Asks first, fails closed.
 */
export async function removeDesignatedRegion(regionId: string): Promise<void> {
  if (refuseIfSelectionOwned("Remove Region")) return;
  await runExclusive(async () => {
    const region = getDesignatedRegion(regionId);
    if (!region) {
      showToast("That writeback region no longer exists.", { type: "info", duration: 3000 });
      return;
    }
    const range = regionRangeA1(region.selector);
    const ok = await confirmAsync(
      `Remove the writeback region ${range}?\n\n` +
        `Its cells stay as they are, but subscribers can no longer send values ` +
        `for them once you publish or push this change. Responses already ` +
        `collected stay in the workspace.`,
      { title: "Remove writeback region", okLabel: "Remove", kind: "warning" },
    );
    if (!ok) return;
    try {
      await removeWritebackRegion(regionId);
      emitAppEvent(WRITEBACK_REGIONS_CHANGED_EVENT, {});
      showToast(`Writeback region ${range} removed.`, { type: "success", duration: 4000 });
    } catch (err) {
      showToast(`Could not remove the region: ${errorText(err)}`, { type: "error", duration: 8000 });
    } finally {
      await refreshWriteback();
    }
  });
}

/** Open the publisher's Collected Responses pane ON the region the cursor is
 *  in (when there is one), not on whichever region the list puts first. */
export function openCollectedResponses(): void {
  focusCollectedResponsesRegion(publisherRegionId);
  openTaskPane(PUBLISHER_DASHBOARD_PANE_ID);
  showTaskPaneContainer();
}
