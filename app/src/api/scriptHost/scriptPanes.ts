//! FILENAME: app/src/api/scriptHost/scriptPanes.ts
// PURPOSE: The host half of script-defined TASK PANES (M2, the modeless
//          sibling of scriptForms.ts): the live pane SESSIONS, their rate
//          buckets, and the data-only exchange with the trusted renderer (S4,
//          inside ScriptableObjects, through the `registerPanel` seam). The
//          renderer paints; the worker supplies data; this module holds the
//          state between them. It reaches the host realm only through the
//          `PaneSessionDeps` callbacks host.ts hands it, so it never imports
//          host.ts.
//
// THE SHAPE OF A DOCK. `pane.dock` is a "ui"-class broker call — its FIRST call
// awaits a consent dialog, which is why it carries the person-length deadline
// — but it never awaits the user: it resolves `{ paneId }` the moment the
// renderer acknowledges the pane is ON SCREEN, and after that nothing in the
// worker is waiting on anything. What the user does arrives as events
// (onPaneChange / onPaneClick / onPaneClose) and the pane's values as a mirror,
// exactly as for a form.
//
// WHAT A PANE DELIBERATELY DOES NOT TAKE FROM THE FORM. Each of the modal's
// three attention mechanisms is meaningless or harmful on a surface that lives
// for hours:
//   - the shared app-wide MODAL SLOT: a pane blocks nobody; taking the slot
//     would refuse every dialog in the session for as long as the pane is up;
//   - the three-dismissal MUTE: nothing is being dismissed — the user closes a
//     pane when they are done with it, and that is not a refusal;
//   - HELD WORKER DEADLINES (`holdFormDeadlines`): the opening call returns at
//     once, so there is no relayed call to keep alive; holding the clock would
//     only let a stuck relayed call hang for as long as the pane stayed open;
//   - the IDLE / ABSOLUTE deadlines: a pane the user has not touched for an
//     hour is a pane the user is reading, not a forgotten dialog.
//
// WHAT BOUNDS IT INSTEAD. A per-script PANE CAP (MAX_PANES_PER_SCRIPT), so a
// script cannot tile the sidebar; a per-script DOCK bucket, so a dock loop
// cannot flicker; a per-pane UPDATE bucket, so a script cannot repaint thirty
// times a frame; and OWNERSHIP on every call after the dock — a pane id is
// host-minted and every update/reveal/badge/close is refused unless the calling
// script owns that pane.
//
// HONESTY ON REVEAL. `openPanel` is a NO-OP for a panel whose effective
// placement is "ribbon", so `reveal()` there resolves `{ revealed: false,
// reason }` rather than a success nothing on screen bears out. The registry
// learns the placement from the renderer's own acknowledgement and every
// placement change after it — it never guesses.
//
// THE HOSTILE-SCRIPT BOUNDS (S6, and the dock's own bound after it). Three
// loops a script can write in one line used to win against the user:
//   - `for (;;) { pane.close(); await pane.dock(); }` took the SIDEBAR ten
//     times a minute, for as long as the script was mounted: the wiring called
//     `openPanel` on every dock, which forces the sidebar open and switches
//     the active view away from whatever the user had there. The dock consulted
//     no gesture at all — it was the cheaper route to exactly the screen
//     `pane.reveal` was hardened against — and the user's escape was defeated
//     too, because docking under a new KEY produced a panel id their "put it on
//     the ribbon" had never been recorded against. Now a dock REGISTERS the
//     pane always and OPENS it only within the gesture window (`dockMayOpen`),
//     the result says which (`PaneDockResult.opened`), and the wiring falls
//     back to the last placement the user chose for ANY pane of that script
//     before the registry's default (scriptPaneHost.ts).
//   - `for (;;) await pane.reveal()` re-opened the sidebar onto the pane for
//     as long as the script lived — every guard on reveal was a STATE check
//     (owned, docked, placement), none a rate or provenance check, and the
//     user's own sidebar close only hides a pane, it does not end it. Now a
//     reveal is admitted only within PANE_REVEAL_GESTURE_WINDOW_MS of a USER
//     gesture attributable to the script (`noteScriptGesture`: an input on one
//     of its panes or forms, the user running it, the pane's own dock), and a
//     per-script reveal bucket applies inside the window. Outside it the
//     answer is `{ revealed: false, reason: "no-gesture" }`, audited.
//   - `setInterval(() => pane.update(...), 1)` was dropped silently past the
//     update bucket and could be kept up forever, with the audit ring saying
//     every call succeeded (the broker sees an "emit" row return void). Now
//     refused calls climb a ladder per pane (`noteRefusal`): a HOST-owned
//     banner the script cannot clear, then a cooldown in which every script
//     update is ignored, then — on the third cooldown in ten minutes — a
//     forced close with reason "throttled". Each step is an audit row under
//     the script; the dropped calls themselves are not, one row per step is
//     what a user needs to see and a row per call is what a hostile script
//     would use to flood the ring.
//     THE LADDER GOES BOTH WAYS. Every stage states a present-tense fact, so
//     every stage has an exit: the cooldown's is its timer (`endCooldown`) and
//     the banner's is `armBannerDecay`, which takes the notice down once the
//     sliding minute has decayed to PANE_THROTTLE_BANNER_CLEAR_AT. A stage
//     that could only be climbed left a one-off burst accusing the script for
//     the rest of the pane's life, of something it had long stopped doing.
//     AND IT NAMES THE OFFENCE IT IS FOR. Three refusals climb the one ladder
//     — a dropped `pane.update`, a dropped `pane.setBadge` and a refused
//     `pane.reveal` — and the notices said "updating its pane faster than
//     Calcula allows" for all three, so a script that only ever looped
//     `pane.reveal()` was accused on screen of something it had never done.
//     The window remembers WHICH KIND each refusal was (`PaneRefusalKind`) and
//     the sentence is chosen from the mix (`refusalMix`), while the counting
//     stays kind-blind: one ladder and one set of thresholds, or a script would
//     alternate kinds and sit under every threshold at once.
//
// THE THIRD PLACEMENT: EMBEDDED ON A SHEET (M3c). A form the user has placed on
// the grid gets a session from THIS registry, not from a fourth one, and the
// reason is that every guard on a pane SESSION is exactly the guard an embedded
// form needs: ownership on every call after the open, the update token bucket,
// the throttle ladder with its host-owned banner, the seed refresh, the close
// reasons, and above all the bound-cell pipeline — one `resolveFormBindings`,
// one pinned-sheet rule, one set of audited rows (host.ts). A second registry
// would have been a second copy of all of that, which is the drift the Seam
// Rule exists to stop.
//
// WHAT DOES NOT FIT IS THE DOCK, AND AN EMBEDDED SESSION DOES NOT USE IT. Every
// guard this file applies at `dockScriptPane`'s entry — the per-script cap, the
// dock bucket, the gesture window (`dockMayOpen`), the slot key — answers one
// question: may a SCRIPT take a shared piece of screen it was not given? An
// embedded surface is not taken, it is PLACED, by the user, and no method on
// the worker's surface can create one; the host opens the session when the
// user's placement paints. So those guards are not bypassed on this path, they
// are unreachable, and the bound that replaces them is a document one:
// MAX_EMBEDDED_FORMS_PER_SHEET in `embeddedFormPlacements.ts`.
// `pane.reveal` keeps its shape and answers `revealed: false` with the true
// reason, exactly as it already does for the ribbon.

import { BrokerError } from "./broker";
import { emitAppEvent, onAppEvent } from "../events";
import { showToast } from "../notifications";
import { coerceFormValue, isDirty } from "./scriptFormBindings";
import {
  FORM_INPUT_TYPE_SET,
  type FormOrigin,
  type FormPatch,
  type FormSeed,
  type FormSpec,
  type FormValue,
  type FormWidget,
} from "./scriptFormSpec";
import {
  FORM_TEXT_CHANGE_DEBOUNCE_MS,
  MAX_FORM_CHANGE_FANOUT,
  defineScriptLayout,
  describeFormError,
  forgetAllScriptLayouts,
  forgetScriptLayout,
} from "./scriptForms";
import {
  MAX_PANES_PER_SCRIPT,
  PANE_DOCKED_ACK_TIMEOUT_MS,
  PANE_DOCKS_PER_MINUTE,
  PANE_REVEAL_GESTURE_WINDOW_MS,
  PANE_REVEALS_PER_MINUTE,
  PANE_THROTTLE_BANNER_AT,
  PANE_THROTTLE_BANNER_CLEAR_AT,
  PANE_THROTTLE_CLOSE_AT,
  PANE_THROTTLE_CLOSE_WINDOW_MS,
  PANE_THROTTLE_COOLDOWN_AT,
  PANE_THROTTLE_COOLDOWN_MS,
  PANE_UPDATE_PER_SECOND,
  PANE_UPDATE_WINDOW_MS,
  SCRIPT_PANE_CLOSE_EVENT,
  SCRIPT_PANE_INPUT_EVENT,
  SCRIPT_PANE_PATCH_EVENT,
  SCRIPT_PANE_REQUEST_EVENT,
  type PaneCloseReason,
  type PaneDockResult,
  type PaneHostBanner,
  type PanePlacement,
  type PaneRevealResult,
  type ScriptPaneInputPayload,
  type ScriptPanePatchPayload,
  type ScriptPaneRequestPayload,
  type ScriptPaneSummary,
} from "./scriptPaneSpec";

// The transparency row's shape lives in the leaf module (scriptPaneSpec.ts)
// so codeInventory.ts can type it without this registry in its graph; it is
// re-exported here because this is the module that produces it.
export type { ScriptPaneSummary } from "./scriptPaneSpec";

// ============================================================================
// The host callbacks a session drives (host.ts binds them to a MountedWorker)
// ============================================================================

export interface PaneSessionDeps {
  /** Fire-and-forget event into the owning worker (onPaneChange / onPaneClick / onPaneClose). */
  forward(hook: string, payload: unknown): void;
  /** Push a sync-getter mirror into the worker (`pane.values.<id>` / `pane.isOpen.<id>`). */
  mirror(path: string, value: unknown): void;
  /** Tell the worker the pane is gone, so its shim forgets the id. */
  closed(paneId: string, reason: PaneCloseReason): void;
  /**
   * The renderer acknowledged the dock (registered; not necessarily on screen).
   * `info` says which PLACEMENT this session is — the host relays the id into
   * the worker only for an embedded surface, whose id the script has no other
   * way of learning (see `markDocked`).
   */
  opened?(paneId: string, info: { embedded: boolean; placementId: string | null }): void;
  /**
   * The pane's section component is on screen. The host installs the live
   * cell watch here and re-reads every bound cell — a pane that was hidden
   * for an hour must come back current, not replay an hour of events.
   */
  visible?(paneId: string): void;
  /** The section component unmounted: the host tears the live watch down. */
  hidden?(paneId: string): void;
  /**
   * Write bound widgets back to their cells — exactly `names` (a pane has no
   * Submit, so every write is a `writeOn: "change"` write). Resolves the names
   * written. A throw keeps the pane open and its message is shown in the band.
   */
  writeBindings?(
    paneId: string,
    values: Record<string, FormValue | string[]>,
    names: string[],
  ): Promise<string[]>;
  /**
   * A refusal the REGISTRY decided after the broker admitted the call — a
   * reveal outside the gesture window or past its bucket, or a step of the
   * throttle ladder. The broker's own row for that call says `ok`, because
   * an "emit" method returns void whatever the registry did with it; this is
   * the row that says otherwise, under the script's handle, in the audit ring.
   */
  audit?(paneId: string, refusal: PaneRefusalAudit): void;
}

/** What a registry-decided refusal reports to the audit ring (see PaneSessionDeps.audit). */
export interface PaneRefusalAudit {
  /** The method refused, or the ladder step (`pane.throttle.banner` / `.cooldown` / `.close`). */
  method: string;
  class: "ui" | "emit";
  /** `NoGesture` for a reveal on the script's own clock; `RateLimited` for a spent bucket or a ladder step. */
  error: "NoGesture" | "RateLimited";
}

// ============================================================================
// Registry state
// ============================================================================

interface PaneSession {
  /** Per-SESSION identity, host-minted, never repeated (`pane-<n>`). */
  paneId: string;
  /**
   * The pane's STABLE key within its script: `PaneDockOptions.key`, or the
   * lowest free slot "0".."MAX-1". Unique among the script's LIVE panes, and
   * what the renderer builds the persisted panel id from (see
   * ScriptPaneRequestPayload.paneKey).
   */
  paneKey: string;
  /**
   * EMBEDDED sessions (M3c): the sheet placement this session paints into, and
   * also its `paneKey` — a placement's minted UUID is already unique per script
   * and stable across every structural edit, so it is the natural stable half
   * of the identity, and the duplicate-key guard becomes "one session per
   * placement" for free. null for a docked task pane.
   */
  embedPlacementId: string | null;
  scriptId: string;
  scriptName: string;
  spec: FormSpec;
  /** Widget type by name, for the text-change debounce and value coercion. */
  widgetTypes: Map<string, string>;
  /** Listboxes that take several answers — the value SHAPE depends on it. */
  multiNames: Set<string>;
  values: Record<string, FormValue | string[]>;
  /** What each widget started from, refreshed whenever its cell changes (see `refreshScriptPaneSeeds`). */
  seeds: Record<string, FormSeed>;
  /** Widgets the USER has changed. A script patch is not a user edit. */
  touched: Set<string>;
  /** Bound widgets that write their cell on each committed change (every bound pane widget). */
  writeOnChange: Set<string>;
  deps: PaneSessionDeps;
  /** The renderer acknowledged the dock. */
  docked: boolean;
  /**
   * This dock was allowed to TAKE THE SCREEN (`dockMayOpen` at dock time, kept
   * on the session because the answer must not be re-asked at the ack — the
   * window may well have closed while the pane's cells were being read, and the
   * renderer has already acted on what was decided). Read again at the ack to
   * decide two things: what `pane.dock` resolves as `opened`, and whether the
   * dock earns the script a gesture window at all.
   */
  openOnDock: boolean;
  /** The renderer's section component is mounted (see ScriptPaneInputKind "visible"). */
  visible: boolean;
  closed: boolean;
  /** Where the renderer put it; null until the renderer has said. */
  placement: PanePlacement | null;
  badge: string | null;
  ackTimer: ReturnType<typeof setTimeout> | null;
  /**
   * A text-like widget's change, held back for FORM_TEXT_CHANGE_DEBOUNCE_MS
   * so a keystroke burst is one event and one cell write. The delivery is
   * kept BESIDE its timer because a close must be able to RUN it rather than
   * merely clear it: a timer that is only cleared discards the user's last
   * keystrokes in a bound textbox (see `flushPendingChanges` — and
   * `CLOSE_FLUSHES_PENDING_CHANGES` for the one close, the workbook swap,
   * where running it would write into the wrong document).
   */
  changeTimers: Map<string, { timer: ReturnType<typeof setTimeout>; deliver: () => void }>;
  /** Token bucket for pane.update. */
  updateTokens: number;
  updateRefilledAt: number;
  updateWarned: boolean;
  /**
   * The throttle ladder (S6). `refusals` holds the script calls this pane
   * dropped in the sliding minute, each with WHICH KIND it was (see
   * PaneRefusalKind — the banner has to name the offence that happened);
   * `stage` climbs from the host banner to a cooldown on their COUNT, kind
   * disregarded, because one ladder is what stops a script alternating kinds
   * to stay under every threshold; `cooldowns` remembers when each cooldown
   * began, within PANE_THROTTLE_CLOSE_WINDOW_MS, because the third one closes
   * the pane.
   *
   * `bannerTimer` is the ladder's downward step out of the "banner" stage —
   * see `armBannerDecay`. Without it `refusals` is only ever pruned by the
   * NEXT refusal, so a burst that simply stopped left both the count and the
   * banner frozen at the moment of the last drop.
   *
   * `bannerMix` is the mix the banner on screen is WORDED for, so the sentence
   * can follow the window without re-emitting a patch per dropped call.
   */
  refusals: PaneRefusal[];
  throttleStage: "none" | "banner" | "cooldown";
  bannerMix: PaneRefusalMix | null;
  cooldownUntil: number;
  cooldownTimer: ReturnType<typeof setTimeout> | null;
  bannerTimer: ReturnType<typeof setTimeout> | null;
  cooldowns: number[];
  resolveDocked: ((v: PaneDockResult) => void) | null;
  rejectDocked: ((e: Error) => void) | null;
}

/** paneId -> session. Several per script, up to MAX_PANES_PER_SCRIPT. */
const sessions = new Map<string, PaneSession>();
/** scriptId -> its open paneIds, so the per-script lookups are not scans. */
const sessionsByScript = new Map<string, Set<string>>();
/**
 * paneId -> the script it was minted for, kept after the pane closes (until
 * that script's revoke or a reset). It is what lets `owned` tell "your pane,
 * already gone" (a no-op — the user closed it a moment ago and the script's
 * next update must not become a console error) from "not your pane" (refused),
 * without a live session to ask. Bounded by the dock bucket: at most
 * PANE_DOCKS_PER_MINUTE ids per script per minute, all dropped on revoke.
 */
const ownerOf = new Map<string, string>();
/**
 * paneId -> its stable key, set beside `ownerOf` when the id is minted and
 * dropped with it. Read only for ids that are LIVE (open, or a dock still
 * reading its cells): a key is held exactly while such an id carries it, so a
 * close frees the slot through `endSession`'s own bookkeeping (the id leaves
 * `sessionsByScript`) and nothing has to remember to free it — a slot that
 * stayed taken after a close would make the third re-dock of the same pane
 * land on key "2" and the placement preference drift with it.
 */
const keyOf = new Map<string, string>();
/** scriptId -> timestamps of recent dock attempts (the dock bucket). */
const dockAttempts = new Map<string, number[]>();
/**
 * scriptId -> paneIds whose bound reads are still in flight. A pane counts
 * against the cap from the moment its dock passed the guards, or a script could
 * start MAX+1 docks in one turn and have every one of them land; and an unmount
 * DURING the reads must make the dock refuse rather than paint for a script
 * that is gone.
 */
const pendingDocks = new Map<string, Set<string>>();
/**
 * paneId -> timestamps of the updates ADMITTED for it in the last
 * PANE_UPDATE_WINDOW_MS (S7 transparency: `ScriptPaneSummary.updatesLastMinute`).
 * Refusals are not recorded — a dropped update repainted nothing, and the
 * inventory reports what reached the screen, not what the script attempted.
 * Kept beside the session rather than on it and PRUNED on every read and every
 * record (`admittedUpdatesFor` / `noteAdmittedUpdate`), so a closed pane's
 * tally vanishes with its row and nothing has to remember to drop it. Bounded:
 * at most PANE_UPDATE_PER_SECOND x 60 stamps per live pane.
 */
const admittedUpdates = new Map<string, number[]>();
/**
 * scriptId -> when the user last did something attributable to that script
 * (see `noteScriptGesture`). One stamp per script, not a list: the reveal
 * window asks only "how long ago", and a list would grow with every keystroke
 * in a pane. Dropped on revoke and reset.
 */
const lastGestureAt = new Map<string, number>();
/**
 * scriptId -> the value `lastGestureAt` was set to by that script's OWN dock
 * acknowledgement (`markDocked`), for as long as it is still the newest stamp.
 *
 * ONE CLOCK, ONE NOTE OF PROVENANCE — not a second gesture concept. The dock
 * ack stamps a gesture so that a script which docks in response to the user may
 * go on to reveal the pane it just opened. Fed back into the DOCK's own
 * admission that stamp is circular, and measurably so: dock, close, dock again
 * inside five seconds and every dock is authorised by the previous dock's
 * acknowledgement, for ever, at the dock bucket's ten a minute. So a dock asks
 * for a gesture that is not the one its own predecessor produced
 * (`dockMayOpen`); a reveal, which cannot renew this stamp without having
 * opened something first, still asks only `withinGestureWindow`.
 */
const dockAckGestureAt = new Map<string, number>();
/** scriptId -> timestamps of the reveals ADMITTED in the last minute (the reveal bucket). */
const revealAttempts = new Map<string, number[]>();

let paneSeq = 0;
let inputListenerInstalled = false;

const now = (): number => Date.now();

// ============================================================================
// Helpers shared in SHAPE with scriptForms.ts
// ============================================================================
//
// The two index walks are duplicated from scriptForms.ts on purpose: they are
// four lines each over a type both files import, and exporting them from the
// form registry would make the pane registry's module graph depend on the
// modal's for a `Map` it could build itself. If a third layout surface ever
// appears, lift them into scriptFormSpec.ts.

function indexWidgetTypes(spec: FormSpec): Map<string, string> {
  const out = new Map<string, string>();
  const stack: FormWidget[] = [...spec.children];
  while (stack.length > 0) {
    const w = stack.pop() as FormWidget;
    if (w.name) out.set(w.name, w.type);
    if ("children" in w && Array.isArray(w.children)) stack.push(...w.children);
    if (w.type === "tabs") for (const page of w.pages) stack.push(...page.children);
  }
  return out;
}

function indexMultiNames(spec: FormSpec): Set<string> {
  const out = new Set<string>();
  const stack: FormWidget[] = [...spec.children];
  while (stack.length > 0) {
    const w = stack.pop() as FormWidget;
    if (w.name && w.type === "listbox" && w.multi === true) out.add(w.name);
    if ("children" in w && Array.isArray(w.children)) stack.push(...w.children);
    if (w.type === "tabs") for (const page of w.pages) stack.push(...page.children);
  }
  return out;
}

function isTextLike(type: string | undefined): boolean {
  return type === "textbox" || type === "number" || type === "date";
}

function valuesPath(paneId: string): string {
  return `pane.values.${paneId}`;
}
function isOpenPath(paneId: string): string {
  return `pane.isOpen.${paneId}`;
}

// ============================================================================
// Guards
// ============================================================================

function openCount(scriptId: string): number {
  return (sessionsByScript.get(scriptId)?.size ?? 0) + (pendingDocks.get(scriptId)?.size ?? 0);
}

/**
 * The keys a script holds RIGHT NOW: every open pane's, plus every dock whose
 * cells are still being read — the same two sets `openCount` counts, for the
 * same reason: two docks of one key started in one turn must not both land.
 */
function liveKeys(scriptId: string): Set<string> {
  const out = new Set<string>();
  for (const paneId of sessionsByScript.get(scriptId) ?? []) {
    const key = keyOf.get(paneId);
    if (key !== undefined) out.add(key);
  }
  for (const paneId of pendingDocks.get(scriptId) ?? []) {
    const key = keyOf.get(paneId);
    if (key !== undefined) out.add(key);
  }
  return out;
}

/**
 * The default key: the lowest slot "0".."MAX_PANES_PER_SCRIPT-1" no live pane
 * of this script holds. Called only once the cap has admitted the dock, so
 * there is always one — at most MAX-1 keys are live, and a script-chosen key
 * that is not a slot index frees a slot rather than taking one.
 */
function lowestFreeSlot(live: Set<string>): string {
  for (let i = 0; i < MAX_PANES_PER_SCRIPT; i++) {
    const slot = String(i);
    if (!live.has(slot)) return slot;
  }
  throw new BrokerError("HostError", `this script already has ${MAX_PANES_PER_SCRIPT} panes open; close one first`);
}

function bucketAllowsDock(scriptId: string): boolean {
  const t = now();
  const recent = (dockAttempts.get(scriptId) ?? []).filter((ts) => t - ts < 60_000);
  if (recent.length >= PANE_DOCKS_PER_MINUTE) {
    dockAttempts.set(scriptId, recent);
    return false;
  }
  recent.push(t);
  dockAttempts.set(scriptId, recent);
  return true;
}

function takeUpdateToken(s: PaneSession): boolean {
  const t = now();
  const elapsed = (t - s.updateRefilledAt) / 1000;
  if (elapsed > 0) {
    s.updateTokens = Math.min(PANE_UPDATE_PER_SECOND, s.updateTokens + elapsed * PANE_UPDATE_PER_SECOND);
    s.updateRefilledAt = t;
  }
  if (s.updateTokens < 1) return false;
  s.updateTokens -= 1;
  return true;
}

/** Drop the tally of every pane that is no longer open, and every stamp older than the window. */
function pruneAdmittedUpdates(t: number): void {
  for (const [paneId, stamps] of admittedUpdates) {
    if (!sessions.has(paneId)) {
      admittedUpdates.delete(paneId);
      continue;
    }
    const recent = stamps.filter((ts) => t - ts < PANE_UPDATE_WINDOW_MS);
    if (recent.length === 0) admittedUpdates.delete(paneId);
    else if (recent.length !== stamps.length) admittedUpdates.set(paneId, recent);
  }
}

/** An update passed the bucket and reached the renderer: stamp it for the inventory's "updates in the last minute". */
function noteAdmittedUpdate(s: PaneSession): void {
  const t = now();
  pruneAdmittedUpdates(t);
  const stamps = admittedUpdates.get(s.paneId);
  if (stamps) stamps.push(t);
  else admittedUpdates.set(s.paneId, [t]);
}

/**
 * How many updates this pane was granted in the last PANE_UPDATE_WINDOW_MS.
 * Call AFTER `pruneAdmittedUpdates`: the prune is the one place the window is
 * applied (a second filter here was found to make a sabotage of either a
 * no-op, which is how a guard stops guarding).
 */
function admittedUpdatesFor(paneId: string): number {
  return admittedUpdates.get(paneId)?.length ?? 0;
}

/**
 * The session a script may act on (null when it is this script's pane but
 * already closed — a no-op for the caller), or a refusal. OWNERSHIP IS CHECKED
 * HERE, ONCE: a pane id is host-minted and predictable (`pane-<n>`), so a
 * script that guessed another script's id must get the same answer as one
 * that named a pane that never existed — nothing about the other script's
 * pane may leak, not even that it exists.
 */
function owned(scriptId: string, paneId: string, what: string): PaneSession | null {
  if (ownerOf.get(paneId) !== scriptId) {
    throw new BrokerError("HostError", `${what}: this script has no pane "${paneId}"`);
  }
  const s = sessions.get(paneId);
  return !s || s.closed ? null : s;
}

function addPending(scriptId: string, paneId: string): void {
  let set = pendingDocks.get(scriptId);
  if (!set) {
    set = new Set();
    pendingDocks.set(scriptId, set);
  }
  set.add(paneId);
}

function removePending(scriptId: string, paneId: string): boolean {
  const set = pendingDocks.get(scriptId);
  if (!set || !set.has(paneId)) return false;
  set.delete(paneId);
  if (set.size === 0) pendingDocks.delete(scriptId);
  return true;
}

// ============================================================================
// The reveal gesture window and the throttle ladder (S6)
// ============================================================================

/**
 * The user just did something attributable to `scriptId`: typed or clicked
 * in one of its panes or forms, ran it (Run / F5 in the editor, a shortcut,
 * a button or panel icon bound to it), mounted it, or its pane docked ONTO THE
 * SCREEN. For the next PANE_REVEAL_GESTURE_WINDOW_MS the script may bring its
 * pane forward, and may dock one that takes the screen — with the one
 * exception a dock ack must carry, see `dockAckGestureAt`.
 *
 * STAMP ONLY AT USER ENTRY POINTS. A stamp at a scheduled job, a timer, a
 * cell-change hook or a cross-script call would hand the window to code that
 * runs on its own clock, which is exactly what the window exists to refuse.
 * The pane registry stamps its own change/click inputs and the dock; host.ts
 * stamps the others (search `noteScriptGesture` there for each site and its
 * reason).
 */
export function noteScriptGesture(scriptId: string): void {
  lastGestureAt.set(scriptId, now());
}

function withinGestureWindow(scriptId: string): boolean {
  const at = lastGestureAt.get(scriptId);
  return at !== undefined && now() - at <= PANE_REVEAL_GESTURE_WINDOW_MS;
}

/**
 * May THIS dock open the pane, or only register it?
 *
 * The window is the reveal's, because the two calls reach the same
 * `openPanel`: forcing the sidebar open and switching the active view away
 * from whatever the user had there — the Model Editor, the transparency panel,
 * their own work. `pane.reveal` was bounded by a gesture and a bucket in S6 and
 * `pane.dock` was not, so the cheaper route stayed open; a script that closed
 * and re-docked its own pane took the sidebar ten times a minute for as long as
 * it was mounted, and the user's one escape — moving the pane to the ribbon —
 * was defeated by docking under a different key.
 *
 * The second clause is the anti-circularity rule: see `dockAckGestureAt`. A
 * refusal here is not a refusal of the DOCK — the pane is still registered,
 * listed and openable by the user, and `pane.dock` says `opened: false` rather
 * than pretending otherwise.
 */
function dockMayOpen(scriptId: string): boolean {
  if (!withinGestureWindow(scriptId)) return false;
  return lastGestureAt.get(scriptId) !== dockAckGestureAt.get(scriptId);
}

/** Same shape as the dock bucket: admitted reveals per script per minute. */
function bucketAllowsReveal(scriptId: string): boolean {
  const t = now();
  const recent = (revealAttempts.get(scriptId) ?? []).filter((ts) => t - ts < 60_000);
  if (recent.length >= PANE_REVEALS_PER_MINUTE) {
    revealAttempts.set(scriptId, recent);
    return false;
  }
  recent.push(t);
  revealAttempts.set(scriptId, recent);
  return true;
}

/**
 * WHICH call the ladder refused. THREE different refusals climb the one ladder
 * — a dropped `pane.update`, a dropped `pane.setBadge` (it rides the update
 * bucket) and a refused `pane.reveal` (no gesture, or past the reveal bucket) —
 * and the banner named only the first of them. A script that never called
 * `pane.update` once, looping `pane.reveal()` outside its gesture window, was
 * accused on screen of "updating its pane too fast". The host banner is the one
 * channel a script cannot forge; a sentence in it that is not true of what
 * happened is what teaches a user to stop reading it.
 *
 * `setBadge` is an "update" and not a kind of its own: a badge IS something the
 * script is changing about the pane, so "updating its pane" is true of it.
 */
type PaneRefusalKind = "update" | "reveal";

interface PaneRefusal {
  at: number;
  kind: PaneRefusalKind;
}

/** What the window as a whole is, and therefore which sentence is true of it. */
type PaneRefusalMix = "update" | "reveal" | "mixed";

/**
 * The mix of the refusals still inside the sliding minute.
 *
 * ANY of both is "mixed", not "whichever kind dominates". A majority rule would
 * put a sentence on screen that is false about the other calls — and the
 * minority kind is the one a script would use to hide a second hammer behind a
 * first. The count that drives the ladder is unaffected either way: this reads
 * the same list the thresholds read, and decides only the wording.
 *
 * Never called with an empty list — a caller has either just pushed a refusal
 * or is holding at least PANE_THROTTLE_BANNER_CLEAR_AT of them.
 */
function refusalMix(refusals: readonly PaneRefusal[]): PaneRefusalMix {
  const kinds = new Set(refusals.map((r) => r.kind));
  if (kinds.size > 1) return "mixed";
  return kinds.has("reveal") ? "reveal" : "update";
}

/**
 * The host banner's text at each stage, per offence. The renderer appends the
 * time left while `until` is set.
 *
 * Each of these is a consent-grade sentence: the offence clause names what the
 * script actually did over the window (`refusalMix`), and the consequence
 * clause is true whichever it was — past the banner threshold the excess calls
 * are dropped, and in a cooldown EVERY pane call is swallowed, updates, badges
 * and reveals alike (see `updateScriptPane` / `setScriptPaneBadge` /
 * `revealScriptPane`), which is why the cooldown clause says "its calls to this
 * pane" and not "its updates".
 */
const THROTTLE_BANNER_TEXT: Record<PaneRefusalMix, string> = {
  update: "This script is updating its pane faster than Calcula allows; it is being slowed down.",
  reveal: "This script is asking to bring its pane forward more often than Calcula allows; it is being slowed down.",
  mixed:
    "This script is updating its pane and asking to bring it forward more often than Calcula allows; it is being slowed down.",
};
const THROTTLE_COOLDOWN_TEXT: Record<PaneRefusalMix, string> = {
  update:
    "This script is updating its pane faster than Calcula allows; its calls to this pane are being ignored for a while.",
  reveal:
    "This script is asking to bring its pane forward more often than Calcula allows; its calls to this pane are being ignored for a while.",
  mixed:
    "This script is updating its pane and asking to bring it forward more often than Calcula allows; its calls to this pane are being ignored for a while.",
};

function setHostBanner(s: PaneSession, banner: PaneHostBanner | null): void {
  const payload: ScriptPanePatchPayload = { paneId: s.paneId, hostBanner: banner };
  emitAppEvent(SCRIPT_PANE_PATCH_EVENT, payload);
}

function auditRefusal(s: PaneSession, method: string, cls: "ui" | "emit", error: "NoGesture" | "RateLimited"): void {
  s.deps.audit?.(s.paneId, { method, class: cls, error });
}

/**
 * A script call this pane dropped: count it over the sliding minute and climb
 * the ladder. Every step is one audit row and one host banner; the dropped
 * call itself is neither (see the header). Called for a spent update bucket
 * (update / setBadge) and for a refused reveal (no gesture, spent bucket);
 * NOT while in cooldown, where every script call is swallowed without a
 * count — counting there would re-enter the cooldown on the moment it lifted.
 */
function noteRefusal(s: PaneSession, kind: PaneRefusalKind): void {
  const t = now();
  s.refusals = s.refusals.filter((r) => t - r.at < 60_000);
  s.refusals.push({ at: t, kind });
  if (s.refusals.length >= PANE_THROTTLE_COOLDOWN_AT) {
    enterCooldown(s, t);
    return;
  }
  if (s.throttleStage === "banner") {
    // The stage is already up — one banner per stage, one audit row per step —
    // but the SENTENCE follows the window: a script that hammered updates and
    // has switched to hammering reveals is accused of what it is doing now,
    // not of what opened the stage. `showThrottleBanner` emits only when the
    // mix actually changed, so alternating kinds cannot make the host chatter.
    showThrottleBanner(s);
    return;
  }
  if (s.refusals.length >= PANE_THROTTLE_BANNER_AT) {
    s.throttleStage = "banner";
    showThrottleBanner(s);
    auditRefusal(s, "pane.throttle.banner", "emit", "RateLimited");
    console.warn(`[ScriptHost] "${s.scriptName}" is being slowed down: ${s.refusals.length} pane calls dropped in the last minute`);
    armBannerDecay(s);
  }
}

/**
 * Raise the banner, or re-word the one on screen for the window as it stands.
 * `bannerMix` is what the visible sentence was worded for, so an unchanged mix
 * emits nothing: the banner is a patch to every listener and a script past the
 * threshold produces a refusal per call.
 */
function showThrottleBanner(s: PaneSession): void {
  const mix = refusalMix(s.refusals);
  if (mix === s.bannerMix) return;
  s.bannerMix = mix;
  setHostBanner(s, { text: THROTTLE_BANNER_TEXT[mix], kind: "warning" });
}

/**
 * The banner's own clock: take it down again once the sliding minute has
 * decayed to PANE_THROTTLE_BANNER_CLEAR_AT refusals.
 *
 * WHY A TIMER AND NOT A RE-READ. `s.refusals` is pruned inside `noteRefusal`
 * and nowhere else, so it is current only at the instant of a DROPPED call. A
 * ladder that steps down only when it is climbed cannot step down at all: the
 * banner stage was terminal, and a one-off burst — thirty reveals outside the
 * gesture window, a tight progress loop past the update bucket — left "this
 * script is updating its pane faster than Calcula allows" on screen for hours
 * while every call the script made was being admitted. That is the opposite of
 * what a host banner is for: it is the one channel the script cannot forge, so
 * it must state a CURRENT fact or the user learns to ignore it.
 *
 * The wake-up is scheduled, not polled: the count falls to
 * PANE_THROTTLE_BANNER_CLEAR_AT - 1 exactly when the CLEAR_AT-th newest refusal
 * ages out of the minute (every older one is already gone by then), so one
 * timer per decay is enough. Refusals that arrive meanwhile push the count back
 * up, `reviewBanner` finds it still high and re-arms — that is the hysteresis
 * doing its job, not a missed clear.
 *
 * The COOLDOWN stage keeps its own exit (`endCooldown`), which is why this
 * arms only for "banner" and `enterCooldown` cancels it.
 */
function armBannerDecay(s: PaneSession): void {
  if (s.bannerTimer !== null) clearTimeout(s.bannerTimer);
  s.bannerTimer = null;
  if (s.closed || s.throttleStage !== "banner") return;
  const n = s.refusals.length;
  const lastToExpire = n >= PANE_THROTTLE_BANNER_CLEAR_AT ? s.refusals[n - PANE_THROTTLE_BANNER_CLEAR_AT] : undefined;
  const delay = lastToExpire === undefined ? 0 : Math.max(0, lastToExpire.at + 60_000 - now());
  s.bannerTimer = setTimeout(() => reviewBanner(s), delay);
}

/** The armed moment arrived: re-prune the minute and either clear the banner or re-arm. */
function reviewBanner(s: PaneSession): void {
  s.bannerTimer = null;
  if (s.closed || s.throttleStage !== "banner") return;
  const t = now();
  s.refusals = s.refusals.filter((r) => t - r.at < 60_000);
  if (s.refusals.length >= PANE_THROTTLE_BANNER_CLEAR_AT) {
    // Still above the clear threshold — but the window has just lost its oldest
    // refusals, and with them possibly a whole KIND. Re-word before re-arming,
    // or a burst of updates that aged out would leave the pane accused of
    // updating too fast while every refusal left in the minute is a reveal.
    showThrottleBanner(s);
    armBannerDecay(s);
    return;
  }
  s.throttleStage = "none";
  s.bannerMix = null;
  setHostBanner(s, null);
}

/**
 * Ignore every script update for PANE_THROTTLE_COOLDOWN_MS — or, on the
 * PANE_THROTTLE_CLOSE_AT-th cooldown within PANE_THROTTLE_CLOSE_WINDOW_MS,
 * close the pane: a script that has been slowed down twice and comes straight
 * back for a third round is not going to stop, and the user should not have
 * to keep a pane open that ignores its owner. The close reason "throttled"
 * reaches the script's onPaneClose and the user as a toast (the renderer
 * wiring shows it on the CLOSE event).
 */
function enterCooldown(s: PaneSession, t: number): void {
  s.cooldowns = s.cooldowns.filter((ts) => t - ts < PANE_THROTTLE_CLOSE_WINDOW_MS);
  s.cooldowns.push(t);
  if (s.cooldowns.length >= PANE_THROTTLE_CLOSE_AT) {
    auditRefusal(s, "pane.throttle.close", "emit", "RateLimited");
    console.warn(
      `[ScriptHost] "${s.scriptName}": pane closed — its ${PANE_THROTTLE_CLOSE_AT}rd throttle cooldown in ${PANE_THROTTLE_CLOSE_WINDOW_MS / 60_000} minutes`,
    );
    endSession(s, "throttled");
    return;
  }
  s.throttleStage = "cooldown";
  // Read the mix BEFORE the list is cleared: the cooldown notice names the
  // offence that earned it, on the same evidence the banner used.
  const mix = refusalMix(s.refusals);
  s.refusals = [];
  s.bannerMix = null;
  // The banner's decay clock belongs to the stage it just left: the cooldown
  // has its own exit, and a stale wake-up would find an emptied `refusals` and
  // take down a cooldown notice that is still true.
  if (s.bannerTimer !== null) clearTimeout(s.bannerTimer);
  s.bannerTimer = null;
  s.cooldownUntil = t + PANE_THROTTLE_COOLDOWN_MS;
  if (s.cooldownTimer !== null) clearTimeout(s.cooldownTimer);
  s.cooldownTimer = setTimeout(() => endCooldown(s), PANE_THROTTLE_COOLDOWN_MS);
  setHostBanner(s, { text: THROTTLE_COOLDOWN_TEXT[mix], kind: "error", until: s.cooldownUntil });
  auditRefusal(s, "pane.throttle.cooldown", "emit", "RateLimited");
  console.warn(
    `[ScriptHost] "${s.scriptName}": pane calls ignored for ${PANE_THROTTLE_COOLDOWN_MS / 1000} s (${PANE_THROTTLE_COOLDOWN_AT} dropped in a minute)`,
  );
}

/** The cooldown lifted: the ladder starts over, the banner comes down. `cooldowns` is kept — it is what counts to the close. */
function endCooldown(s: PaneSession): void {
  s.cooldownTimer = null;
  if (s.closed) return;
  s.throttleStage = "none";
  s.bannerMix = null;
  s.cooldownUntil = 0;
  setHostBanner(s, null);
}

function inCooldown(s: PaneSession): boolean {
  return s.throttleStage === "cooldown";
}

// ============================================================================
// Sessions
// ============================================================================

function clearTimers(s: PaneSession): void {
  if (s.ackTimer !== null) clearTimeout(s.ackTimer);
  s.ackTimer = null;
  if (s.cooldownTimer !== null) clearTimeout(s.cooldownTimer);
  s.cooldownTimer = null;
  if (s.bannerTimer !== null) clearTimeout(s.bannerTimer);
  s.bannerTimer = null;
  for (const pending of s.changeTimers.values()) clearTimeout(pending.timer);
  s.changeTimers.clear();
}

/**
 * Deliver every change the text debounce is still holding, NOW, through the
 * same path its timer would have taken — the onPaneChange event and the
 * bound-cell write with its pin check, undo batch and audit row.
 *
 * WHY ALMOST EVERY CLOSE PATH RUNS THIS FIRST. A form's Submit writes every
 * dirty widget and its Cancel deliberately writes nothing; a pane has neither,
 * and its consent sentence promises that a bound field "writes it back as soon
 * as you change it, and closing the pane does not undo that". `endSession` used
 * to set `closed` and clear the timers, so the last keystrokes before the
 * band's X, a `pane.close()` or an unmount were dropped while `onPaneClose`
 * still carried the typed text — a checkbox toggled right before the close was
 * written, a textbox edited right before it was not, purely as a debounce
 * artefact. Runs BEFORE `closed` is set, because `deliver` refuses a closed
 * session; the write it starts may outlive the session, and a refusal then
 * reaches the user as a toast (the band is gone).
 *
 * The one path that does NOT flush is the workbook swap — see
 * CLOSE_FLUSHES_PENDING_CHANGES and `dropPendingChanges`.
 */
function flushPendingChanges(s: PaneSession): void {
  for (const [name, pending] of [...s.changeTimers]) {
    clearTimeout(pending.timer);
    s.changeTimers.delete(name);
    pending.deliver();
  }
}

/**
 * Does a close on this reason still write out what the text debounce is
 * holding?
 *
 * Every close the pane's DOCUMENT survives does: the band's X, `pane.close()`,
 * a dock that never opened, an unmount (the script ended — stopped, faulted,
 * relinked, Stop in the debugger — but the workbook the user was typing into is
 * still on screen), a forced throttle close. That is what the consent sentence
 * promises.
 *
 * "reset" is the one that does not, and it is the whole reason that reason
 * exists. A workbook swap sweeps the host from AFTER_OPEN / AFTER_NEW /
 * BEFORE_CLOSE — the document has already been replaced (or is going) by the
 * time the sweep runs — so flushing there would write text the user typed into
 * the OLD workbook into the NEW workbook's cell of the same address: a write
 * they never asked for, into a document they never typed into. It is dropped
 * instead, and said out loud (`dropPendingChanges`).
 *
 * EXHAUSTIVE ON PURPOSE (`Record<PaneCloseReason, …>`, not `Partial`): a new
 * close reason does not compile until it has decided which of the two it is.
 */
const CLOSE_FLUSHES_PENDING_CHANGES: Record<PaneCloseReason, boolean> = {
  user: true,
  script: true,
  failed: true,
  unmount: true,
  reset: false,
  throttled: true,
  // The embedded surface's ANCHOR cell was deleted; the workbook, and the bound
  // cells (which are addressed independently of the anchor), are still there.
  // So this is an "unmount"-shaped close, not a "reset"-shaped one: the user's
  // last keystrokes belong in the cells they were typed for.
  orphaned: true,
};

/**
 * The workbook the pane was docked against is gone: clear the debounce WITHOUT
 * delivering it, and tell the user about the edits that will not reach a cell.
 *
 * Only bound widgets are named: an unbound widget's held change would have gone
 * to the script as an `onPaneChange` and nowhere else, and the script is being
 * torn down with the workbook. A bound one is different — the user typed a
 * value they were promised would be saved, and it is not in any cell.
 */
function dropPendingChanges(s: PaneSession): void {
  const bound: string[] = [];
  for (const [name, pending] of [...s.changeTimers]) {
    clearTimeout(pending.timer);
    s.changeTimers.delete(name);
    if (s.writeOnChange.has(name)) bound.push(name);
  }
  if (bound.length === 0) return;
  const quoted = bound.map((n) => `"${n}"`).join(", ");
  showToast(
    bound.length === 1
      ? `${s.scriptName}: your last edit to ${quoted} was not saved to its cell — the workbook it belonged to ` +
          `was closed or replaced first. Re-open that workbook and enter the value in the cell directly.`
      : `${s.scriptName}: your last edits to ${quoted} were not saved to their cells — the workbook they ` +
          `belonged to was closed or replaced first. Re-open that workbook and enter the values in those cells directly.`,
    { type: "warning" },
  );
}

/**
 * Close a session on ANY path. Idempotent: the user's close, a script's close,
 * a failed dock, an unmount and a workbook swap all land here, and only the
 * first one settles anything.
 */
function endSession(s: PaneSession, reason: PaneCloseReason): void {
  if (s.closed) return;
  if (CLOSE_FLUSHES_PENDING_CHANGES[reason]) flushPendingChanges(s);
  else dropPendingChanges(s);
  s.closed = true;
  s.visible = false;
  clearTimers(s);
  sessions.delete(s.paneId);
  const owned = sessionsByScript.get(s.scriptId);
  if (owned) {
    owned.delete(s.paneId);
    if (owned.size === 0) sessionsByScript.delete(s.scriptId);
  }
  emitAppEvent(SCRIPT_PANE_CLOSE_EVENT, { paneId: s.paneId, reason });
  if (!s.docked) {
    // The renderer never acknowledged: the awaiting dock() must not hang.
    s.rejectDocked?.(new BrokerError("HostError", "the pane did not open (no renderer acknowledged it)"));
    s.resolveDocked = s.rejectDocked = null;
  }
  s.deps.mirror(isOpenPath(s.paneId), false);
  s.deps.forward("onPaneClose", { paneId: s.paneId, reason, values: { ...s.values } });
  s.deps.closed(s.paneId, reason);
}

/** What a `resolve` thunk hands back once the guards have let the dock through. */
export interface ResolvedPaneDockData {
  seeds?: Record<string, FormSeed>;
  pinnedSheetName?: string;
  /**
   * Bound widgets that write their cell on each committed change. For a pane
   * this is EVERY writable cell binding: there is no Submit, so `writeOn:
   * "submit"` (the form default) would mean "never", and a bound pane widget
   * the user edits with nothing ever written is a lie on screen. The host
   * resolves it that way (see the pane.dock case in host.ts).
   */
  writeOnChange?: Iterable<string>;
}

/**
 * Dock a script's pane. Rejects (BrokerError) only when a guard refuses — the
 * per-script cap, the dock bucket, a duplicate key, an unmount during the
 * reads, no renderer — and otherwise resolves a `PaneDockResult` once the
 * renderer acknowledged "docked".
 *
 * THE GUARDS COME FIRST, INCLUDING BEFORE THE SHEET IS READ, for the reason
 * scriptForms.ts gives at `showScriptForm`: the bound reads arrive as a
 * `resolve` thunk that is awaited only after every guard has passed, so a
 * refused dock performs no audited read for a pane nobody will see.
 *
 * WHETHER IT TAKES THE SCREEN IS DECIDED HERE TOO, and decided EARLY — before
 * the bound reads, not after. The reads are audited round trips to the grid and
 * can outlast the gesture window on a slow workbook; asking afterwards would
 * make "did the user just run this script?" a question about how long their
 * cells took to read. So the answer is taken at the moment the script asked
 * (`dockMayOpen`), carried on the session, and told to the renderer as
 * `ScriptPaneRequestPayload.open`.
 */
export async function dockScriptPane(args: {
  scriptId: string;
  scriptName: string;
  origin: FormOrigin;
  spec: FormSpec;
  initial?: Record<string, unknown>;
  /**
   * The pane's stable key (validated upstream by vPaneDock: 1..MAX_PANE_KEY_CHARS
   * of PANE_KEY_PATTERN). Absent: the lowest free slot. See PaneDockOptions.key.
   */
  key?: string;
  /**
   * EMBEDDED (M3c): the sheet placement this session paints into. Present ONLY
   * on the host's own entry point (`openEmbeddedScriptForm` in host.ts) — no
   * broker method can set it — and it switches off the four guards that exist
   * to stop a SCRIPT taking a shared piece of screen. See the file header.
   */
  embedPlacementId?: string;
  seeds?: Record<string, FormSeed>;
  pinnedSheetName?: string;
  /** Bound widgets whose cell follows each committed change (see ResolvedPaneDockData). */
  writeOnChange?: Iterable<string>;
  resolve?: () => Promise<ResolvedPaneDockData>;
  deps: PaneSessionDeps;
}): Promise<PaneDockResult> {
  const embedded = args.embedPlacementId !== undefined;
  if (!embedded && openCount(args.scriptId) >= MAX_PANES_PER_SCRIPT) {
    throw new BrokerError(
      "HostError",
      `this script already has ${MAX_PANES_PER_SCRIPT} panes open (the most one script may hold); close one first`,
    );
  }
  // A key is held by at most one LIVE pane of a script: docking "status"
  // while "status" is up is refused by name, never answered with a second
  // pane the script did not mean to open (and the renderer's panel id, built
  // from the key, could not tell the two apart). Judged before the bucket,
  // like the cap: a refusal that opens nothing is not a dock attempt.
  //
  // AN EMBEDDED SESSION KEYS ON ITS PLACEMENT, so this same guard becomes "one
  // session per placement on the sheet" — the renderer mounting a surface twice
  // (a re-render, two scroll passes) must not open a second session that reads
  // the same cells again and answers the same events twice.
  const live = liveKeys(args.scriptId);
  const paneKey = embedded ? (args.embedPlacementId as string) : (args.key ?? lowestFreeSlot(live));
  if (live.has(paneKey)) {
    throw new BrokerError(
      "HostError",
      embedded
        ? `this form is already open on the sheet at that placement`
        : `a pane with key "${paneKey}" is already docked; close it first`,
    );
  }
  if (!embedded && !bucketAllowsDock(args.scriptId)) {
    throw new BrokerError(
      "HostError",
      `this script has docked ${PANE_DOCKS_PER_MINUTE} panes in the last minute; it may not dock another yet`,
    );
  }
  // Asked NOW, once, while the script's call is still the newest thing that
  // happened; see the header for why not after the bound reads. An embedded
  // surface takes no shared screen at all — it appears where the user put it,
  // when that part of the sheet is on screen — so there is nothing to permit.
  const openOnDock = embedded ? false : dockMayOpen(args.scriptId);
  // The layout a script last docked is remembered per KIND beside its form's,
  // so a form script that docks a pane keeps both (scriptForms.ts). NOT for an
  // embedded session: its spec came FROM a layout the script defined (the host
  // reads `form.define`'s tree to open it), and writing it back into the pane
  // slot would let a placement's paint silently replace the layout the script's
  // next `pane.dock` is about to use.
  if (!embedded) defineScriptLayout(args.scriptId, "pane", args.spec);
  const paneId = `pane-${++paneSeq}`;
  ownerOf.set(paneId, args.scriptId);
  // Claimed BEFORE the reads, with the id: from here the key is live (through
  // `pendingDocks`) and a second dock of it in the same turn is refused above.
  keyOf.set(paneId, paneKey);

  let argSeeds = args.seeds;
  let pinnedSheetName = args.pinnedSheetName;
  let writeOnChange = args.writeOnChange;
  if (args.resolve) {
    addPending(args.scriptId, paneId);
    let resolved: ResolvedPaneDockData;
    try {
      resolved = await args.resolve();
    } catch (e) {
      removePending(args.scriptId, paneId);
      throw e;
    }
    // The script can have been unmounted, or the workbook reset, while its
    // cells were being read; that dropped the claim, and the dock must not go
    // on to paint for a script that is no longer there.
    if (!removePending(args.scriptId, paneId)) {
      throw new BrokerError("HostError", "the script was unloaded before its pane could open");
    }
    if (resolved.seeds !== undefined) argSeeds = resolved.seeds;
    if (resolved.pinnedSheetName !== undefined) pinnedSheetName = resolved.pinnedSheetName;
    if (resolved.writeOnChange !== undefined) writeOnChange = resolved.writeOnChange;
  }

  const widgetTypes = indexWidgetTypes(args.spec);
  const multiNames = indexMultiNames(args.spec);
  const seeds: Record<string, FormSeed> = {};
  const values: Record<string, FormValue | string[]> = {};
  for (const [name, seed] of Object.entries(argSeeds ?? {})) {
    const widgetType = widgetTypes.get(name);
    if (widgetType === undefined) continue;
    // A seed is not only a value (a table's rows, an image's url) — only the
    // VALUE half is input-only. Same rule as the form.
    seeds[name] = seed;
    if (!FORM_INPUT_TYPE_SET.has(widgetType)) continue;
    values[name] = seed.value;
  }
  if (args.initial) {
    for (const [name, value] of Object.entries(args.initial)) {
      if (!FORM_INPUT_TYPE_SET.has(widgetTypes.get(name) ?? "")) continue;
      const v = value as FormValue | string[];
      const prior = seeds[name];
      // A SEED THE HOST MARKED READ-ONLY OWNS ITS VALUE, AND `initial` LOSES —
      // the same rule, word for word, that `showScriptForm` applies (see the
      // long note there). It has to be repeated here because `resolveFormBindings`
      // (host.ts) is ONE PIPELINE FEEDING THREE SURFACES: a Controls binding
      // seeds a pane exactly as it seeds a form, read-only and carrying the
      // host's own sentence ("a control value can be read, not written"), and so
      // does every binding the host REFUSED, whose seed is nothing but that
      // sentence. Merging `initial` over one of those kept the switched-off box
      // and the host's help line and swapped in the script's number, so the
      // renderer painted a figure the script invented under a caption saying
      // where it came from.
      if (prior?.readOnly) continue;
      seeds[name] = prior ? { ...prior, value: v, display: undefined } : { value: v };
      values[name] = v;
    }
  }

  const session: PaneSession = {
    paneId,
    paneKey,
    embedPlacementId: args.embedPlacementId ?? null,
    scriptId: args.scriptId,
    scriptName: args.scriptName,
    spec: args.spec,
    widgetTypes,
    multiNames,
    values,
    seeds,
    touched: new Set<string>(),
    writeOnChange: new Set(writeOnChange ?? []),
    deps: args.deps,
    docked: false,
    openOnDock,
    visible: false,
    closed: false,
    placement: null,
    badge: null,
    ackTimer: null,
    changeTimers: new Map(),
    updateTokens: PANE_UPDATE_PER_SECOND,
    updateRefilledAt: now(),
    updateWarned: false,
    refusals: [],
    throttleStage: "none",
    bannerMix: null,
    cooldownUntil: 0,
    cooldownTimer: null,
    bannerTimer: null,
    cooldowns: [],
    resolveDocked: null,
    rejectDocked: null,
  };
  sessions.set(paneId, session);
  let owned = sessionsByScript.get(args.scriptId);
  if (!owned) {
    owned = new Set();
    sessionsByScript.set(args.scriptId, owned);
  }
  owned.add(paneId);
  ensureInputListener();

  const request: ScriptPaneRequestPayload = {
    paneId,
    paneKey,
    scriptId: args.scriptId,
    scriptName: args.scriptName,
    origin: args.origin,
    spec: args.spec,
    seeds,
    ...(pinnedSheetName ? { pinnedSheetName } : {}),
    ...(args.embedPlacementId !== undefined ? { embedPlacementId: args.embedPlacementId } : {}),
    open: openOnDock,
  };

  return new Promise<PaneDockResult>((resolve, reject) => {
    session.resolveDocked = resolve;
    session.rejectDocked = reject;
    session.ackTimer = setTimeout(() => {
      if (!session.docked) endSession(session, "failed");
    }, PANE_DOCKED_ACK_TIMEOUT_MS);
    emitAppEvent(SCRIPT_PANE_REQUEST_EVENT, request);
  });
}

/**
 * Change what a docked pane shows. A closed pane is a no-op (audited ok). In
 * a throttle cooldown EVERY update is ignored, uncounted; past the bucket an
 * update is dropped and counted toward the ladder (`noteRefusal`).
 */
export function updateScriptPane(scriptId: string, paneId: string, patch: FormPatch): void {
  const s = owned(scriptId, paneId, "pane.update");
  if (!s) return;
  if (inCooldown(s)) return;
  if (!takeUpdateToken(s)) {
    if (!s.updateWarned) {
      s.updateWarned = true;
      console.warn(
        `[ScriptHost] "${s.scriptName}" updates its pane more than ${PANE_UPDATE_PER_SECOND} times a second; excess updates are dropped`,
      );
    }
    noteRefusal(s, "update");
    return;
  }
  noteAdmittedUpdate(s);
  // THE SAME RULE THE DOCK'S `initial` MEETS, and it has to be here too: a patch
  // is the second way to put a value in a widget, so guarding only the dock
  // would let the identical substitution land a tick later, under the identical
  // host-authored read-only sentence. Stripped from the PAYLOAD as well as from
  // `s.values`, because `landFormPatch` (scriptFormState.ts) applies
  // `patch.values` on its own and consults no seed — see updateScriptForm.
  let outgoing = patch;
  if (patch.values) {
    const sealed = Object.keys(patch.values).filter((name) => s.seeds[name]?.readOnly === true);
    if (sealed.length > 0) {
      const values = { ...patch.values };
      for (const name of sealed) delete values[name];
      outgoing = { ...patch, values };
    }
    for (const [name, value] of Object.entries(outgoing.values ?? {})) {
      const type = s.widgetTypes.get(name) ?? "";
      if (!FORM_INPUT_TYPE_SET.has(type)) continue;
      // The same coercion the renderer applies, so the mirror never disagrees
      // with what the pane holds (see updateScriptForm).
      s.values[name] = coerceFormValue(type, s.multiNames.has(name), value as FormValue | string[]);
    }
    s.deps.mirror(valuesPath(paneId), { ...s.values });
  }
  const payload: ScriptPanePatchPayload = { paneId, patch: outgoing };
  emitAppEvent(SCRIPT_PANE_PATCH_EVENT, payload);
}

/** Pin a short badge on the pane's tab; null clears it. Not rate-limited separately: it rides the update bucket. */
export function setScriptPaneBadge(scriptId: string, paneId: string, badge: string | null): void {
  const s = owned(scriptId, paneId, "pane.setBadge");
  if (!s) return;
  if (s.badge === badge) return;
  if (inCooldown(s)) return;
  if (!takeUpdateToken(s)) {
    // "update": a badge is something the script is changing about the pane, so
    // the banner's "updating its pane" sentence is true of a dropped setBadge.
    noteRefusal(s, "update");
    return;
  }
  noteAdmittedUpdate(s);
  s.badge = badge;
  const payload: ScriptPanePatchPayload = { paneId, badge };
  emitAppEvent(SCRIPT_PANE_PATCH_EVENT, payload);
}

/**
 * Bring a docked pane forward — HONESTLY. `openPanel` does nothing for a panel
 * whose effective placement is "ribbon", so the answer there is `revealed:
 * false` with the reason; and a pane the renderer has not acknowledged yet, or
 * has already closed, cannot be revealed either. Only a real reveal emits.
 *
 * AND BOUNDED (S6). The state answers above are not refusals — nothing was
 * asked that the script could have timed differently. After them: a pane in a
 * throttle cooldown answers "throttled" uncounted; a reveal with no user
 * gesture attributable to this script inside PANE_REVEAL_GESTURE_WINDOW_MS
 * answers "no-gesture"; inside the window the per-script bucket admits
 * PANE_REVEALS_PER_MINUTE and answers "throttled" past it. Both refusals are
 * audited and counted toward the pane's ladder — a reveal loop is the same
 * hammer as an update loop — as kind "reveal", so the banner the ladder raises
 * says what this script did rather than accusing it of updating. Only a real
 * reveal emits.
 */
export function revealScriptPane(scriptId: string, paneId: string): PaneRevealResult {
  const s = owned(scriptId, paneId, "pane.reveal");
  if (!s) return { revealed: false, reason: "the pane is closed" };
  if (!s.docked) return { revealed: false, reason: "the pane has not opened yet" };
  if (s.embedPlacementId !== null) {
    // The same honesty the ribbon gets, for the same reason: there is no
    // `openPanel` to call. This surface is painted where the user placed it on
    // the sheet, and a script cannot scroll the user's grid to it — reporting
    // a reveal here would be a success nothing on screen bears out. Not counted
    // toward the throttle ladder: this is a fact about the placement, not a call
    // the script could have timed differently.
    return {
      revealed: false,
      reason: "this form is embedded on a sheet, where a script cannot bring it forward; the user scrolls to it",
    };
  }
  if (s.placement === "ribbon") {
    return {
      revealed: false,
      reason: "the pane is placed on the ribbon, where a script cannot bring it forward; the user opens it from there",
    };
  }
  if (inCooldown(s)) return { revealed: false, reason: "throttled" };
  if (!withinGestureWindow(scriptId)) {
    auditRefusal(s, "pane.reveal", "ui", "NoGesture");
    noteRefusal(s, "reveal");
    return { revealed: false, reason: "no-gesture" };
  }
  if (!bucketAllowsReveal(scriptId)) {
    auditRefusal(s, "pane.reveal", "ui", "RateLimited");
    noteRefusal(s, "reveal");
    return { revealed: false, reason: "throttled" };
  }
  const payload: ScriptPanePatchPayload = { paneId, reveal: true };
  emitAppEvent(SCRIPT_PANE_PATCH_EVENT, payload);
  return { revealed: true };
}

/**
 * Close a script's own pane from code.
 *
 * REFUSED FOR AN EMBEDDED SURFACE, and loudly. A docked pane is a thing the
 * script asked for, so it may give it back; a form embedded on a sheet is an
 * object the USER placed in their document, and a script that could make it
 * disappear could quietly remove the surface through which the user was about
 * to see what it had done. The mechanics agree: the renderer opens a session
 * whenever the placement paints, so a script-closed embedded session would
 * either come straight back (a loop) or leave an empty box on the sheet with
 * nothing saying why. The refusal names what the script CAN do instead.
 */
export function closeScriptPane(scriptId: string, paneId: string): void {
  const s = owned(scriptId, paneId, "pane.close");
  if (!s) return;
  if (s.embedPlacementId !== null) {
    throw new BrokerError(
      "HostError",
      "this form is embedded on a sheet: a script cannot remove a surface the user placed. " +
        "Use pane.update(...) to change what it shows; the user deletes it from the sheet.",
    );
  }
  endSession(s, "script");
}

/**
 * A bound cell changed underneath a docked pane (the visibility-gated watch),
 * or the pane came back on screen and every bound cell was re-read: hand the
 * renderer fresh seeds and keep the mirror saying what is on screen. Same
 * rules as `refreshScriptFormSeeds` — a widget the user edited keeps their
 * value, `echo: false` marks the pane's own write-back, and the per-name
 * fan-out is capped at MAX_FORM_CHANGE_FANOUT while the mirror is updated in
 * full.
 *
 * `onlyChanged` is the REVEAL re-read's option: the renderer and the mirror
 * still take every seed (a display can change without its value), but an
 * `onPaneChange { source: "cell" }` goes out only for a value that differs
 * from what the pane held — an hour hidden collapses to "what is different
 * now", never to one event per untouched widget.
 */
export function refreshScriptPaneSeeds(
  paneId: string,
  seeds: Record<string, FormSeed>,
  opts?: { echo?: boolean; onlyChanged?: boolean },
): void {
  const s = sessions.get(paneId);
  if (!s || s.closed) return;
  const names = Object.keys(seeds);
  if (names.length === 0) return;
  const payload: ScriptPanePatchPayload = { paneId, seeds };
  emitAppEvent(SCRIPT_PANE_PATCH_EVENT, payload);
  const adopted: string[] = [];
  const announced: string[] = [];
  for (const name of names) {
    const untouched = !s.touched.has(name) || !isDirty(s.seeds[name], s.values[name]);
    const previous = s.seeds[name];
    s.seeds[name] = seeds[name];
    if (!untouched) continue;
    s.values[name] = seeds[name].value;
    adopted.push(name);
    if (opts?.onlyChanged !== true || isDirty(previous, seeds[name].value)) announced.push(name);
  }
  if (adopted.length === 0) return;
  s.deps.mirror(valuesPath(paneId), { ...s.values });
  if (opts?.echo === false) return;
  for (const name of announced.slice(0, MAX_FORM_CHANGE_FANOUT)) {
    s.deps.forward("onPaneChange", {
      paneId,
      name,
      value: seeds[name].value,
      values: { ...s.values },
      source: "cell",
    });
  }
}

/**
 * Every open pane, in dock order — the code inventory's held-state source
 * (`ScriptPaneSummary`, scriptPaneSpec.ts). A LIST — see `getActiveScriptForm`
 * for why.
 *
 * `boundCells` is READ off the session's cell-binding record, never resolved
 * again: for a pane that record is `writeOnChange`, because a pane has no
 * Submit and the host makes EVERY resolved cell binding a `writeOn: "change"`
 * one (host.ts, the `pane.dock` case: `bound.cells.map(name)`), so the set is
 * exactly the cells the pane is bound to. Re-resolving here would be an
 * audited sheet read on behalf of the transparency panel, under the script's
 * handle, for a pane the script did not touch.
 */
export function listScriptPanes(): ScriptPaneSummary[] {
  pruneAdmittedUpdates(now());
  return [...sessions.values()].map(summarize);
}

/**
 * ONE mapping from session to transparency row, shared by the list and the
 * by-placement lookup. Both callers prune first (see `admittedUpdatesFor`).
 */
function summarize(s: PaneSession): ScriptPaneSummary {
  return {
    paneId: s.paneId,
    scriptId: s.scriptId,
    scriptName: s.scriptName,
    docked: s.docked,
    visible: s.visible,
    placement: s.placement,
    embedPlacementId: s.embedPlacementId,
    badge: s.badge,
    boundCells: s.writeOnChange.size,
    updatesLastMinute: admittedUpdatesFor(s.paneId),
  };
}

/**
 * The live session painting one sheet placement, or null.
 *
 * `openEmbeddedScriptForm` (host.ts) asks BEFORE it opens one, so a placement
 * that re-paints — a scroll, a re-render, a second reconcile — reports the
 * session it already has instead of raising an error the surface would have to
 * turn into a sentence. The registry's own key guard would refuse the second
 * dock anyway; this is what makes the answer "you already have it" rather than
 * "no".
 */
export function getScriptPaneForPlacement(placementId: string): ScriptPaneSummary | null {
  pruneAdmittedUpdates(now());
  for (const s of sessions.values()) {
    if (s.embedPlacementId === placementId) return summarize(s);
  }
  return null;
}

/**
 * End the session painting one sheet placement. THE HOST'S DOOR, not a
 * script's: the user deleted the object ("user"), or a structural edit deleted
 * the cell it was anchored to ("orphaned"). A placement with no session is a
 * no-op, because both callers can arrive after the session has already gone —
 * an unmount sweep and a row deletion can land in either order.
 */
export function closeScriptPaneForPlacement(placementId: string, reason: PaneCloseReason): void {
  for (const s of [...sessions.values()]) {
    if (s.embedPlacementId === placementId) {
      endSession(s, reason);
      return;
    }
  }
}

/**
 * Drop a script's pane state on unmount: every pane it owns closes as
 * "unmount" (the worker is gone; the renderer must not stay up on behalf of
 * code that no longer exists), a dock still reading its cells is refused, its
 * pane layout is forgotten, and its dock bucket is reset so a remount starts
 * clean.
 */
export function revokeScriptPanes(scriptId: string): void {
  pendingDocks.delete(scriptId);
  for (const paneId of [...(sessionsByScript.get(scriptId) ?? [])]) {
    const s = sessions.get(paneId);
    if (s) endSession(s, "unmount");
  }
  forgetScriptLayout(scriptId, "pane");
  dockAttempts.delete(scriptId);
  revealAttempts.delete(scriptId);
  lastGestureAt.delete(scriptId);
  dockAckGestureAt.delete(scriptId);
  for (const [paneId, owner] of [...ownerOf.entries()]) {
    if (owner !== scriptId) continue;
    ownerOf.delete(paneId);
    keyOf.delete(paneId);
  }
}

/**
 * Forget everything (workbook swap / tests). Open panes close as "reset", NOT
 * as "unmount": the document they were docked against has been closed or
 * replaced, so a change still inside the text debounce is dropped rather than
 * written into whatever workbook now owns that address (the user is told —
 * `dropPendingChanges`). That is also why `hostResetAll` calls this BEFORE it
 * unmounts the scripts: the per-script sweep would otherwise claim the panes
 * first, under "unmount", and flush them into the new workbook.
 */
export function resetScriptPanes(): void {
  pendingDocks.clear();
  admittedUpdates.clear();
  for (const s of [...sessions.values()]) endSession(s, "reset");
  sessions.clear();
  sessionsByScript.clear();
  ownerOf.clear();
  keyOf.clear();
  forgetAllScriptLayouts("pane");
  dockAttempts.clear();
  revealAttempts.clear();
  lastGestureAt.clear();
  dockAckGestureAt.clear();
}

// ============================================================================
// Renderer -> host
// ============================================================================

function ensureInputListener(): void {
  if (inputListenerInstalled) return;
  inputListenerInstalled = true;
  onAppEvent(SCRIPT_PANE_INPUT_EVENT, (detail) => {
    const input = detail as ScriptPaneInputPayload;
    const s = sessions.get(input.paneId);
    if (!s || s.closed) return;
    handleInput(s, input);
  });
}

/** The renderer registered the pane: settle the dock. Idempotent. */
function markDocked(s: PaneSession, input: ScriptPaneInputPayload): void {
  if (s.docked) return;
  s.docked = true;
  if (s.ackTimer !== null) clearTimeout(s.ackTimer);
  s.ackTimer = null;
  s.values = { ...input.values };
  // The renderer always sends one on "docked"; "sidebar" is the same fallback
  // `panelRegistry.getPlacement` uses for a panel that declares none, so the
  // dock result can promise a placement rather than a nullable one. An EMBEDDED
  // session's placement is not the renderer's to choose — the session exists
  // because a placement on a sheet paints it — so it is taken from the session
  // rather than from the acknowledgement, and a renderer that said "sidebar"
  // for an embedded surface cannot make the transparency panel say so.
  const placement: PanePlacement = s.embedPlacementId !== null ? "embedded" : (input.placement ?? "sidebar");
  s.placement = placement;
  s.deps.mirror(valuesPath(s.paneId), { ...s.values });
  s.deps.mirror(isOpenPath(s.paneId), true);
  // What the dock ACTUALLY did. `openOnDock` was the permission; the ribbon is
  // the second half of the answer, because `openPanel` does nothing there — the
  // same fact `revealScriptPane` answers with, and the same reason it must not
  // be reported as a success.
  const opened = s.openOnDock && placement !== "ribbon";
  // A dock that took the screen opens the reveal window: a script that docks
  // and then reveals is showing the pane it just opened (the wiring's openPanel
  // already did). A dock that only REGISTERED the pane earns nothing — stamping
  // there would hand back through `pane.reveal` the very screen the dock was
  // just refused, one call later.
  if (opened) {
    noteScriptGesture(s.scriptId);
    dockAckGestureAt.set(s.scriptId, lastGestureAt.get(s.scriptId) as number);
  }
  s.resolveDocked?.({ paneId: s.paneId, opened, placement });
  s.resolveDocked = s.rejectDocked = null;
  // BEFORE the hook, not after. `opened` is where the host relays the id into
  // the worker's shim (`__pane_opened`), and the two travel as messages on one
  // port in the order they are posted — so a script's `onPaneOpen` handler
  // calling `pane.update(...)` on the surface it was just told about would
  // otherwise address whatever the shim held a moment earlier.
  s.deps.opened?.(s.paneId, { embedded: s.embedPlacementId !== null, placementId: s.embedPlacementId });
  // ONLY for an embedded surface, and that asymmetry is the point. A docked
  // pane's id is the return value of the `pane.dock` the script itself made, so
  // an `onPaneOpen` there would tell a script something it is already holding.
  // An embedded session is opened by the HOST when the user's placement paints:
  // without this event the script would learn its own surface's id only when
  // the user first touched it, and could not put anything in it before then.
  if (s.embedPlacementId !== null) {
    s.deps.forward("onPaneOpen", {
      paneId: s.paneId,
      placement,
      placementId: s.embedPlacementId,
      values: { ...s.values },
    });
  }
}

function handleInput(s: PaneSession, input: ScriptPaneInputPayload): void {
  switch (input.kind) {
    case "docked":
      markDocked(s, input);
      return;
    case "visible": {
      // A mounted component is the strongest proof of a dock there is, so a
      // renderer that reports "visible" first has docked too — the order of
      // two effects in one commit must not decide whether dock() resolves.
      markDocked(s, input);
      if (s.visible) return;
      s.visible = true;
      s.deps.visible?.(s.paneId);
      return;
    }
    case "hidden":
      if (!s.visible) return;
      s.visible = false;
      s.deps.hidden?.(s.paneId);
      return;
    case "placement":
      if (input.placement) s.placement = input.placement;
      return;
    case "change": {
      // A change or click input is the user's hand on THIS script's pane: the
      // store emits them for the user's own edits only (a patch echoes
      // nothing), and no script can reach the main window's event bus.
      noteScriptGesture(s.scriptId);
      s.values = { ...input.values };
      s.deps.mirror(valuesPath(s.paneId), { ...s.values });
      const name = input.name ?? "";
      if (name) s.touched.add(name);
      const deliver = (): void => {
        s.changeTimers.delete(name);
        if (s.closed) return;
        s.deps.forward("onPaneChange", {
          paneId: s.paneId,
          name,
          value: input.value ?? null,
          values: { ...s.values },
          source: "user",
        });
        // A pane has no Submit: the cell follows each committed change, as a
        // keystroke would (one undo step each), through the same audited
        // rows a form's `writeOn: "change"` write takes. A refused write shows
        // its reason in the band and the pane stays open.
        if (s.writeOnChange.has(name) && s.deps.writeBindings) {
          void s.deps.writeBindings(s.paneId, { ...s.values }, [name]).catch((e: unknown) => {
            if (s.closed) {
              // The pane is gone — a close flushed this change (or the close
              // overtook a write in flight), so there is no band to show the
              // refusal in. It must not vanish: the user typed a value that is
              // NOT in the cell, and the only remaining fix is the cell itself.
              showToast(
                `${s.scriptName}: "${name}" was not saved to its cell when the pane closed ` +
                  `(${describeFormError(e)}) — enter the value in the cell directly`,
                { type: "error" },
              );
              return;
            }
            const payload: ScriptPanePatchPayload = {
              paneId: s.paneId,
              patch: { message: { text: describeFormError(e), kind: "error" } },
            };
            emitAppEvent(SCRIPT_PANE_PATCH_EVENT, payload);
          });
        }
      };
      if (isTextLike(s.widgetTypes.get(name))) {
        const pending = s.changeTimers.get(name);
        if (pending !== undefined) clearTimeout(pending.timer);
        // The delivery rides beside the timer so a close can run it instead
        // of dropping it (`flushPendingChanges`).
        s.changeTimers.set(name, { timer: setTimeout(deliver, FORM_TEXT_CHANGE_DEBOUNCE_MS), deliver });
      } else {
        deliver();
      }
      return;
    }
    case "click":
      noteScriptGesture(s.scriptId);
      s.values = { ...input.values };
      s.deps.mirror(valuesPath(s.paneId), { ...s.values });
      s.deps.forward("onPaneClick", { paneId: s.paneId, name: input.name ?? "", values: { ...s.values } });
      return;
    case "close":
      endSession(s, "user");
      return;
    default:
      return;
  }
}
