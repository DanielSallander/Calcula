//! FILENAME: app/src/api/scriptHost/scriptPaneSpec.ts
// PURPOSE: The wire and the limits of a script-defined TASK PANE (M2): the
//          MODELESS door onto the SAME data-only widget tree scriptFormSpec.ts
//          declares for the modal form. Leaf module beside scriptFormSpec.ts —
//          it imports only that file — so the validator (validators.ts), the
//          host registry (scriptPanes.ts), the worker shim (contextShims.ts) and
//          the trusted renderer (S4, inside ScriptableObjects) agree on one
//          definition without an import cycle.
//
// WHAT A PANE IS NOT. A pane is not a dialog: it blocks nobody, nothing awaits
// the user, and it can stay open beside the grid for hours. So it takes NONE
// of the modal's attention machinery — no shared modal slot, no dismissal
// streak, no held worker deadlines, no idle/absolute deadline — and it is
// gated by its OWN capability (`ui.pane`), because `ui.dialog`'s consent
// sentence promises "a dialog you must answer or close before continuing" and
// that would be false here (paneConsentHonesty.test.ts pins the sentences).
//
// WHAT CROSSES THE WORKER BOUNDARY is exactly what crosses for a form: a tree of
// plain objects, patches to it, and the values the user entered — plus a
// host-minted `paneId`, because one script may hold several panes at once and
// every later call names which one it means.

import {
  FORM_UPDATE_PER_SECOND,
  type FormPatch,
  type FormOrigin,
  type FormSeed,
  type FormSpec,
  type FormValue,
} from "./scriptFormSpec";

// ============================================================================
// Limits (host-enforced; the worker never sees these)
// ============================================================================

/** Most panes one script may hold open at once. The next dock is refused. */
export const MAX_PANES_PER_SCRIPT = 3;
/** Dock attempts admitted per minute per script — bounds a dock loop. */
export const PANE_DOCKS_PER_MINUTE = 10;
/** `pane.update` calls admitted per second per open pane (host token bucket). */
export const PANE_UPDATE_PER_SECOND = FORM_UPDATE_PER_SECOND;
/** Longest badge text a script may pin on its pane's tab ("3", "NEW", "12 due"). */
export const MAX_PANE_BADGE_CHARS = 8;
/** Longest host-minted pane id a call may name. */
export const MAX_PANE_ID_CHARS = 64;
/** The renderer must acknowledge "docked" within this window or the dock fails. */
export const PANE_DOCKED_ACK_TIMEOUT_MS = 10_000;

// ---- S6: the hostile-script bounds. Every one of these answers a loop a
//      script can write in one line. `for (;;) await pane.reveal()` used to
//      re-open the sidebar onto the pane for as long as the script lived;
//      `setInterval(() => pane.update(...), 1)` was dropped silently and
//      could be kept up forever. ----

/**
 * How long after a USER gesture attributable to a script — an input on one of
 * its own panes or forms, the user running it (Run / F5 in the editor, a
 * button, shortcut or panel icon bound to it), mounting it, or the pane's own
 * dock — a script may TAKE THE SCREEN with that pane. Outside it a reveal
 * answers `{ revealed: false, reason: "no-gesture" }` and a dock registers the
 * pane without opening it (`ScriptPaneRequestPayload.open`): a script brings
 * its pane forward as a RESPONSE to the user, never on a timer.
 *
 * ONE WINDOW, TWO DOORS. `pane.reveal` was bounded by it first (S6) and
 * `pane.dock` was not, which left the shorter route to the same `openPanel`
 * wide open: closing and re-docking a pane forced the sidebar open ten times a
 * minute, for as long as the script was mounted, with no gesture anywhere.
 */
export const PANE_REVEAL_GESTURE_WINDOW_MS = 5_000;
/** Reveals admitted per minute per script inside the gesture window; past it the answer is "throttled". */
export const PANE_REVEALS_PER_MINUTE = 6;
/**
 * Refused script calls (update / setBadge / reveal) on one pane within a
 * sliding minute at which the HOST's own banner appears in the pane — the
 * script cannot clear or overwrite it.
 *
 * ONE threshold over all three kinds, counted kind-blind: split per kind and a
 * script alternates them to sit under every threshold at once. WHICH kind it
 * was is remembered all the same, because the banner's sentence has to name
 * the offence that actually happened (`PaneRefusalKind` in scriptPanes.ts).
 */
export const PANE_THROTTLE_BANNER_AT = 30;
/**
 * ...and the count the sliding minute must fall BACK to before that banner
 * comes down again. The banner is written in the present tense ("it IS being
 * slowed down"), so it has to be able to stop being true: a script that burst
 * once and then behaved normally used to wear the accusation for the rest of
 * the pane's life, because the ladder's only downward step was the end of a
 * COOLDOWN — the heavier stage self-cleared after 30 s while the lighter one
 * never did.
 *
 * LOWER than PANE_THROTTLE_BANNER_AT on purpose — the same high/low-water
 * hysteresis the event queue uses. With one threshold, a script parked at
 * exactly PANE_THROTTLE_BANNER_AT refusals a minute would emit a banner and a
 * clear on alternate calls, forever, and the pane would flash rather than
 * inform.
 */
export const PANE_THROTTLE_BANNER_CLEAR_AT = 10;
/** ...at which the pane ignores EVERY script call — update, setBadge and reveal alike — for PANE_THROTTLE_COOLDOWN_MS. */
export const PANE_THROTTLE_COOLDOWN_AT = 120;
export const PANE_THROTTLE_COOLDOWN_MS = 30_000;
/** A pane that enters its PANE_THROTTLE_CLOSE_AT-th cooldown within this window is force-closed ("throttled"). */
export const PANE_THROTTLE_CLOSE_WINDOW_MS = 10 * 60_000;
export const PANE_THROTTLE_CLOSE_AT = 3;
/**
 * The sliding window behind `ScriptPaneSummary.updatesLastMinute` (S7). The
 * transparency panel answers "is this pane BUSY?" with a count over this
 * window, not with a lifetime total, because a lifetime total says nothing
 * about a pane that has been up since morning — it is the recent rate that
 * tells a user whether a script is repainting behind their back right now.
 */
export const PANE_UPDATE_WINDOW_MS = 60_000;
/**
 * Longest pane KEY a script may choose (`pane.dock({ key })`). The key names
 * the pane's SLOT — the stable half of its identity that the user's placement
 * preference is remembered under — so it is bounded like an identifier, not
 * like a title: it ends up inside a panel id the Shell persists.
 */
export const MAX_PANE_KEY_CHARS = 32;
/** What a pane key may be made of: letters, digits, "_" and "-" (it is a panel-id segment). */
export const PANE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

// ============================================================================
// Shapes
// ============================================================================

/**
 * Where the renderer put the pane. `openPanel` is a NO-OP for a panel whose
 * effective placement is "ribbon", so a `reveal()` there must answer
 * `{ revealed: false }` rather than report a success nobody can see.
 *
 * "embedded" (M3c) is the THIRD placement: the surface is painted on a SHEET,
 * inside a region the user placed there (`embeddedFormPlacements.ts`). It is a
 * placement and not a separate concept because everything a pane session does
 * — ownership, the update bucket, the throttle ladder, the bound-cell pipeline
 * with its pinned sheet — is identical there; only the two calls that address
 * the SIDEBAR mean nothing on it, and both answer honestly about that rather
 * than pretending (`revealScriptPane`). It is deliberately NOT a placement the
 * user can move a docked pane INTO: a form is embedded by being placed on the
 * grid, not by dragging a task pane onto it.
 */
export type PanePlacement = "sidebar" | "ribbon" | "embedded";

/** The two placements the panel system itself hosts, and the only ones a dock can be moved between. */
export type DockedPanePlacement = "sidebar" | "ribbon";

/** What `pane.dock(spec, options)` takes beside the layout. */
export interface PaneDockOptions {
  /** Overrides widget defaults for this dock only (input widgets only). */
  initial?: Record<string, FormValue | string[]>;
  /**
   * The pane's STABLE key within this script (1..MAX_PANE_KEY_CHARS chars of
   * PANE_KEY_PATTERN). Defaults to the lowest free slot "0".."2", so a script's
   * first pane is "0" on every dock and in every session. The host-minted
   * `paneId` is per SESSION and never repeats; the key is what the renderer
   * builds the panel id from, so where the user put the pane last time is
   * where it comes back. A key this script has docked and not yet closed is
   * refused — never silently a second pane.
   */
  key?: string;
}

/**
 * What `pane.dock()` resolves — the whole truth about what the dock did, not
 * just the id. A dock ALWAYS registers the pane (it is listed where panes live
 * and the user can open it); whether it also TOOK THE SCREEN depends on the
 * gesture window, so `opened` is the half a script must not assume. Reporting
 * only `paneId` was a lie by omission: a script that docked on a timer was told
 * the same thing as one the user had just run, and wrote its next line — a
 * progress message, a focus call — believing the user was looking at it.
 */
export interface PaneDockResult {
  /** Host-minted, per SESSION: what every later call and event names. */
  paneId: string;
  /**
   * The pane took the screen: the sidebar opened onto it. False when the dock
   * was outside the gesture window (registered only — the user opens it from
   * the panel list), and false on the ribbon, where `openPanel` does nothing.
   */
  opened: boolean;
  /** Where the renderer put it — the user's own placement choice, read back. */
  placement: PanePlacement;
}

/**
 * The two reveal refusals a script can CAUSE (S6), as codes so a script can
 * branch on them; every other `reason` is a sentence about the pane's state.
 *  - no-gesture : no user gesture attributable to this script within
 *                 PANE_REVEAL_GESTURE_WINDOW_MS — the script is asking on its
 *                 own clock, and the sidebar stays where the user left it
 *  - throttled  : the per-script reveal bucket is spent, or the pane is in a
 *                 throttle cooldown
 */
export type PaneRevealRefusalReason = "no-gesture" | "throttled";

/** What `pane.reveal()` resolves. Honest: false when nothing could be shown. */
export interface PaneRevealResult {
  revealed: boolean;
  reason?: PaneRevealRefusalReason | (string & {});
}

/**
 * Why a pane left the screen. No "submit", no "cancel", no "deadline": a pane
 * has no answer to give and no clock running against the user.
 *  - user      : the person closed it (the X on the panel, or unregistering it)
 *  - script    : `pane.close()`
 *  - failed    : the renderer never acknowledged the dock
 *  - unmount   : the owning script was unmounted (stopped, faulted, relinked,
 *                the debugger's Stop) — the SCRIPT ended; the workbook the pane
 *                was typed into did not, so a pending bound write still lands
 *  - reset     : the WORKBOOK the pane was docked against was closed or
 *                replaced (File > New, File > Open, close). Distinct from
 *                "unmount" for exactly one reason: those sweeps run AFTER the
 *                swap, so a change still inside the pane's text debounce must
 *                be DROPPED rather than written into whatever workbook now
 *                holds that address (the user is told in a toast). See
 *                CLOSE_FLUSHES_PENDING_CHANGES in scriptPanes.ts
 *  - throttled : the host closed it — the script entered its third throttle
 *                cooldown within PANE_THROTTLE_CLOSE_WINDOW_MS (S6)
 *  - orphaned  : an EMBEDDED surface only (M3c). The cell its placement was
 *                anchored to was deleted by a structural edit, so the placement
 *                is orphaned (`embeddedFormPlacements.ts`) and its session ends.
 *                The PLACEMENT survives and paints as an orphan — that is the
 *                whole point of the flag — but nothing runs in it until the
 *                user re-places it. The workbook is still open, so a bound
 *                widget's last keystrokes still reach their cell.
 */
export type PaneCloseReason =
  | "user"
  | "script"
  | "failed"
  | "unmount"
  | "reset"
  | "throttled"
  | "orphaned";

/**
 * A banner the HOST puts on a pane — the throttle notice (S6) and the
 * bindings notice (`ScriptPanePatchPayload.hostBindingNotice`). Each has its
 * OWN slot in the renderer, apart from the script's `message` patch, so the
 * script can neither clear one nor paint over it: the whole point of a host
 * notice is that the user learns something about the pane — what the script
 * is doing to it, or why its bound widgets are read-only — that the script
 * itself has no say in.
 */
export interface PaneHostBanner {
  text: string;
  kind: "warning" | "error";
  /** Epoch millis at which the condition lifts on its own (a cooldown); the renderer shows the time left. */
  until?: number;
}

export interface PaneChangeDetail {
  paneId: string;
  name: string;
  value: FormValue | string[];
  values: Record<string, FormValue | string[]>;
  /** "user" for a keystroke/click, "cell" when a bound cell changed underneath. */
  source: "user" | "cell";
}
export interface PaneClickDetail {
  paneId: string;
  name: string;
  values: Record<string, FormValue | string[]>;
}
export interface PaneCloseDetail {
  paneId: string;
  reason: PaneCloseReason;
  values: Record<string, FormValue | string[]>;
}

// ============================================================================
// Host registry <-> trusted renderer (data-only app events, main window)
// ============================================================================

/** Host -> renderer: dock this pane. Identity is HOST-supplied, never from the script. */
export const SCRIPT_PANE_REQUEST_EVENT = "scriptable-objects:script-pane-request";
/** Host -> renderer: change what a docked pane shows (a patch, refreshed seeds, a badge, a reveal). */
export const SCRIPT_PANE_PATCH_EVENT = "scriptable-objects:script-pane-patch";
/** Host -> renderer: take a pane down (closed by script, failed, unmount). */
export const SCRIPT_PANE_CLOSE_EVENT = "scriptable-objects:script-pane-close";
/** Renderer -> host: what the user did, and where the pane ended up. */
export const SCRIPT_PANE_INPUT_EVENT = "scriptable-objects:script-pane-input";

export interface ScriptPaneRequestPayload {
  /** Per-SESSION identity, host-minted and never repeated: what every later call and event names. */
  paneId: string;
  /**
   * The pane's STABLE key within its script (PaneDockOptions.key, or the
   * slot the registry assigned). The renderer builds the Shell panel id from
   * `scriptId` + THIS, never from `paneId`: the placement store is keyed by
   * panel id, and a per-session id there meant the user's "put it on the
   * ribbon" was lost on every re-dock and left a dead entry behind each time.
   */
  paneKey: string;
  /** Authoritative identity — from the mount handle, never from the script. */
  scriptId: string;
  scriptName: string;
  /** Local, or the package a distributed script arrived in (structural — `FormOrigin`). */
  origin: FormOrigin;
  spec: FormSpec;
  /** Initial values per input name (bound reads, then `initial`, then defaults). */
  seeds: Record<string, FormSeed>;
  /** Restricted tier: the sheet the bindings are pinned to. */
  pinnedSheetName?: string;
  /**
   * EMBEDDED sessions (M3c): the id of the placement on the sheet that this
   * session paints into (`EmbeddedFormPlacement.id`). Absent for a docked task
   * pane, which is what the panel system hosts.
   *
   * It is HOST-supplied like every other field here, and it is the placement's
   * MINTED UUID — never its anchor — so a session survives the structural edit
   * that moves the placement underneath it, and a copy of the placement is a
   * different session rather than a second claimant on this one.
   */
  embedPlacementId?: string;
  /**
   * May this dock TAKE THE SCREEN — `openPanel`, which forces the sidebar open
   * and switches the active view away from whatever the user had there?
   *
   * REGISTERING AND OPENING ARE TWO THINGS. The wiring always registers the
   * panel (the pane exists, is listed, carries its badge, and `pane.dock`
   * resolves honestly); it calls `open` only when this says so. The registry
   * decides, from the same gesture window `pane.reveal` uses: the dock is a
   * RESPONSE to the user, or it waits for them. It used to open unconditionally,
   * which made a close-and-re-dock loop a sidebar takeover on the script's own
   * clock — ten a minute, for as long as the script was mounted.
   */
  open: boolean;
}

export interface ScriptPanePatchPayload {
  paneId: string;
  patch?: FormPatch;
  /** Refreshed seeds for widgets whose bound cell changed underneath. */
  seeds?: Record<string, FormSeed>;
  /** Tab badge; null clears it. Present only when the badge changed. */
  badge?: string | null;
  /** The script asked for the pane to be brought forward. */
  reveal?: true;
  /**
   * HOST-owned banner (the throttle notice, S6); null clears it. Never carried
   * beside a script's `patch` — the two slots are separate all the way to the
   * renderer, so a script's `message` can never displace it.
   */
  hostBanner?: PaneHostBanner | null;
  /**
   * HOST-owned BINDINGS notice: why this pane's bound widgets are read-only
   * right now — today, the one case is that the user has left the sheet the
   * bindings are pinned to (host.ts, `settleOnSheet`). null clears it.
   *
   * WHY ITS OWN SLOT, AND NOT THE SCRIPT'S `message`. It was emitted as
   * `patch: { message }` first, and that gave one slot two owners: a script's
   * own `pane.update({ message })` replaced the host's sentence while the host
   * kept its widgets disabled, and the host's clear on the user's return wiped
   * whatever the script had legitimately put there.
   *
   * WHY NOT `hostBanner` EITHER. Both host notices can be true at once — a
   * script throttled while the user is on another sheet — so sharing one slot
   * would mean whichever arrived second erased the first, and the cooldown's
   * `hostBanner: null` would take the sheet notice down with it.
   */
  hostBindingNotice?: PaneHostBanner | null;
}

export interface ScriptPaneClosePayload {
  paneId: string;
  reason: PaneCloseReason;
}

export type ScriptPaneInputKind =
  /** The renderer registered the pane; `dock()` resolves on this. Carries `placement`. */
  | "docked"
  /**
   * The pane's section component is ON SCREEN (mounted): the sidebar shows it,
   * the ribbon tab is selected, or its launcher flyout is open. The host installs
   * the live cell watch on this and RE-READS every bound cell, so a pane that
   * sat hidden for an hour comes back current instead of replaying an hour.
   *
   * WHY THE COMPONENT, NOT THE PANEL REGISTRY. `PanelService` has no visibility
   * signal: `openPanel` is one-directional and sidebar-only, the activity-bar
   * store answers only for the sidebar, and the ribbon's active tab and the
   * launcher flyouts live in other stores. The section component is mounted
   * exactly when it is painted, on every placement, so its mount effect is the
   * one honest source — and "docked" does NOT imply it: a ribbon tab that is
   * not selected is docked and hidden.
   */
  | "visible"
  /** The section component unmounted: the watch is torn down until the next "visible". */
  | "hidden"
  /** The user moved the pane (sidebar <-> ribbon). Carries `placement`. */
  | "placement"
  | "change"
  | "click"
  /** The person closed the pane. */
  | "close";

export interface ScriptPaneInputPayload {
  paneId: string;
  kind: ScriptPaneInputKind;
  /** docked / placement: where the pane is. */
  placement?: PanePlacement;
  /** change / click: the widget. */
  name?: string;
  /** change: the widget's new value. */
  value?: FormValue | string[];
  /** Every input's current value, always. */
  values: Record<string, FormValue | string[]>;
}

// ============================================================================
// Transparency (S7): what `listScriptPanes()` tells the code inventory
// ============================================================================

/**
 * One row per open pane — the answer to "what is holding a surface, and how
 * hard is it working?". Declared HERE, in the leaf module, so the code
 * inventory (`codeInventory.ts`) can type its held-state rows without
 * importing the registry that owns the sessions.
 *
 * Every number is READ off the session's own records, never re-derived: the
 * bound-cell count is the session's cell-binding record, and the update count
 * is the registry's own tally of updates it ADMITTED (a refused update repainted
 * nothing, so it is not counted — the panel reports what reached the screen).
 */
export interface ScriptPaneSummary {
  paneId: string;
  scriptId: string;
  scriptName: string;
  docked: boolean;
  /** On screen right now — the only state in which its bound cells are watched. */
  visible: boolean;
  placement: PanePlacement | null;
  /**
   * For an "embedded" placement, the sheet placement it paints into; null for a
   * docked task pane. The transparency panel needs it to answer "WHERE is this
   * surface?" for a form that is not in the panel list at all — a surface a user
   * cannot find from the panel that reports it is the failure this section
   * exists to prevent.
   */
  embedPlacementId: string | null;
  badge: string | null;
  /**
   * Cells this pane is bound to (widgets whose cell the host reads for it and
   * writes on each committed change). Control bindings are read-only values,
   * not cells, and are not counted.
   */
  boundCells: number;
  /** `pane.update` / `pane.setBadge` calls admitted in the last PANE_UPDATE_WINDOW_MS. */
  updatesLastMinute: number;
}
