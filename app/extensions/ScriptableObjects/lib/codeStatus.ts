//! FILENAME: app/extensions/ScriptableObjects/lib/codeStatus.ts
// PURPOSE: What the status bar's code-and-scripts indicator says, and the
//          source that keeps it true while nothing else is open.
// CONTEXT: "Code in This File" and "Script Permissions" used to be two
//          activity-bar icons that looked the same whether the file held no
//          code at all or code that came with an application and reaches the
//          network. An icon that never changes tells the user where to look,
//          never WHETHER there is anything to see -- the T1 spec asked for a
//          count badge (docs/design/vision-gap-review.md, T1) and none was ever
//          built. This is that signal, moved to where the user already looks.
//
//          TWO HALVES, deliberately apart:
//          - deriveCodeStatus is PURE: a snapshot in, the words and the state
//            out. Every sentence the indicator can say is decided here, so the
//            unit tier pins all of it without a DOM or a backend.
//          - CodeStatusSource does the reading: it re-reads on the events that
//            mean code changed, polls what changes with no event (scheduled
//            jobs, what scripts hold, a notebook edit), and starts over when the
//            document is replaced. The Code in This File panel only polls while
//            it is OPEN; an indicator that is always visible cannot borrow that.
//
//          THE RULES IT KEEPS (the transparency pillar's own):
//          1. The SAME numbers and the SAME warnings as Code in This File. The
//             count is summarizeCodeInventory's `total`, the panel's first chip;
//             "worth a look" is codeInventoryWarnings (@api/codeInventory) --
//             the one list the panel paints its warning chips from -- plus
//             refused script calls (@api isAuditRefusal), which Script
//             Permissions paints red. The refusals counted are THIS document's
//             (reset on File > New / Open); Script Permissions' Activity list
//             is the whole session's.
//          2. NEVER WRONG IN THE REASSURING DIRECTION. The reads report every
//             failure that makes the answer smaller (a population that could
//             not be listed, a script that could not be read): the count then
//             becomes "at least N" behind a "?", and the failure is SAID. It
//             never turns into "no code". Before the first read of a document
//             lands, the state is "checking", not "none".
//          3. A replaced document starts from nothing. File > New / Open resets
//             the refusal count and the snapshot, and a read that was still in
//             flight for the previous document is discarded when it lands.

import type { AuditEntry, CodeUnit } from "@api";
import { isAuditRefusal } from "@api";
import type {
  CodeInventorySummary,
  ScheduledJobSummary,
  ScriptHeldStateSummary,
} from "@api/codeInventory";
// The real rule from its import-free home (re-exported by @api/codeInventory).
import { codeInventoryWarnings } from "@api/codeWarnings";

// ============================================================================
// Snapshot -> view (pure)
// ============================================================================

/** The inventory roll-up the indicator needs (a subset of the panel's). */
export type CodeStatusInventory = Pick<
  CodeInventorySummary,
  "total" | "local" | "distributed" | "libraries" | "beyondGrid" | "mounted"
>;

/** Everything the indicator knows, as last read. `null` = could not read. */
export interface CodeStatusSnapshot {
  /** "loading" until the first read of THIS document lands. */
  phase: "loading" | "ready";
  /** What the file holds, as far as it could be read; null when nothing could be. */
  inventory: CodeStatusInventory | null;
  /** Why the inventory could not be read at all; null when it was read. */
  inventoryError: string | null;
  /**
   * What could NOT be read, in a way that makes `inventory` smaller than the
   * truth ("notebooks", 'object script "Refresh"'). Non-empty: the count is a
   * floor, not the answer.
   */
  inventoryGaps: string[];
  jobs: ScheduledJobSummary | null;
  held: ScriptHeldStateSummary | null;
  /** Buttons holding an application's code (Code in This File's held section). */
  heldButtons: number | null;
  /** Buttons an application brought that run a Calcula command. */
  commandButtons: number | null;
  /** Script calls the sandbox refused since this document was opened. */
  refusals: number;
}

export const LOADING_SNAPSHOT: CodeStatusSnapshot = Object.freeze({
  phase: "loading",
  inventory: null,
  inventoryError: null,
  inventoryGaps: [],
  jobs: null,
  held: null,
  heldButtons: null,
  commandButtons: null,
  refusals: 0,
}) as CodeStatusSnapshot;

/**
 * - loading: no read of this document has landed yet.
 * - none:    no code, nothing held, nothing refused.
 * - present: code (or application buttons) in the file; nothing worth a look.
 * - notice:  at least one thing worth a look.
 * - unknown: the code in the file could not be fully read.
 */
export type CodeStatusLevel = "loading" | "none" | "present" | "notice" | "unknown";

export interface CodeStatusFact {
  /** Stable id (tests and data attributes key on it). */
  id: string;
  text: string;
  detail?: string;
  /** Worth a look: drawn with the attention mark, and counted. */
  notice: boolean;
}

export interface CodeStatusView {
  level: CodeStatusLevel;
  /** The number on the chip -- the panel's "code units" -- or null when not known. */
  count: number | null;
  facts: CodeStatusFact[];
  /** How many facts are worth a look. */
  noticeCount: number;
  /** One line for the pointer's tooltip. */
  title: string;
  /** The trigger's accessible name: the headline and every fact worth a look.
   *  (The popover's facts, details included, are the menu's DESCRIPTION.) */
  ariaLabel: string;
}

const s = (n: number): string => (n === 1 ? "" : "s");

/** "1 piece of code" / "3 pieces of code". */
function piecesOfCode(n: number): string {
  return n === 1 ? "1 piece of code" : `${n} pieces of code`;
}

/** Whether the count cannot be trusted as the whole answer. */
function incomplete(snap: CodeStatusSnapshot): boolean {
  return snap.inventoryError !== null || snap.inventoryGaps.length > 0;
}

/** The facts, in the panel's own order: what the file holds, then what runs
 *  or holds without being asked, then what the sandbox refused. */
function factsOf(snap: CodeStatusSnapshot): CodeStatusFact[] {
  const facts: CodeStatusFact[] = [];
  const inv = snap.inventory;
  const ready = snap.phase === "ready";

  if (snap.inventoryError !== null) {
    facts.push({
      id: "inventory-error",
      text: "Could not read the code in this file",
      detail: snap.inventoryError,
      notice: true,
    });
  } else if (inv) {
    const floor = snap.inventoryGaps.length > 0;
    if (inv.total === 0 && !floor) {
      facts.push({ id: "code", text: "No code in this file", notice: false });
    } else if (inv.total > 0) {
      const parts: string[] = [];
      const fromApplications = inv.distributed - inv.libraries;
      if (inv.distributed === 0) parts.push("all written here");
      else {
        if (inv.local > 0) parts.push(`${inv.local} written here`);
        if (fromApplications > 0) parts.push(`${fromApplications} came with an application`);
        if (inv.libraries > 0) parts.push(`${inv.libraries} from a script library`);
      }
      if (inv.mounted > 0) parts.push(`${inv.mounted} running now`);
      facts.push({
        id: "code",
        text: `${floor ? "At least " : ""}${piecesOfCode(inv.total)} in this file`,
        detail: parts.join(" · "),
        notice: false,
      });
    }
    if (floor) {
      facts.push({
        id: "inventory-gaps",
        text: "Could not read some of the code in this file",
        detail: snap.inventoryGaps.join(", "),
        notice: true,
      });
    }
  }

  if (snap.heldButtons === null && ready) {
    facts.push({ id: "buttons-error", text: "Could not read the buttons in this file", notice: true });
  } else if ((snap.heldButtons ?? 0) > 0) {
    const n = snap.heldButtons!;
    facts.push({
      id: "held-buttons",
      text: `${n} button${s(n)} hold${n === 1 ? "s" : ""} an application's code`,
      notice: false,
    });
  }
  if (snap.commandButtons === null && ready) {
    facts.push({
      id: "command-buttons-error",
      text: "Could not read the application buttons in this file",
      notice: true,
    });
  } else if ((snap.commandButtons ?? 0) > 0) {
    const n = snap.commandButtons!;
    facts.push({
      id: "command-buttons",
      text: `${n} application button${s(n)} run${n === 1 ? "s" : ""} a Calcula command`,
      notice: false,
    });
  }

  // THE panel's warning chips, from the one list both read.
  for (const w of codeInventoryWarnings(inv, snap.jobs, snap.held)) {
    facts.push({
      id: w.id,
      text: w.text,
      detail: [w.why, w.note].filter(Boolean).join(" · "),
      notice: true,
    });
  }
  if (snap.jobs === null && ready) {
    facts.push({ id: "jobs-error", text: "Could not read the scheduled jobs", notice: true });
  }
  if (snap.held === null && ready) {
    facts.push({ id: "held-error", text: "Could not read what scripts are holding", notice: true });
  }

  if (snap.refusals > 0) {
    facts.push({
      id: "refusals",
      text: `${snap.refusals} script call${s(snap.refusals)} refused`,
      detail: "Since this file was opened, by any script or add-in · see Script Permissions",
      notice: true,
    });
  }

  return facts;
}

/** "2 things worth a look: a; b." for every notice except the headline's own. */
function worthALook(facts: CodeStatusFact[], headlineId: string | null): { count: number; sentence: string } {
  const others = facts.filter((f) => f.notice && f.id !== headlineId);
  return {
    count: others.length,
    sentence:
      others.length === 0
        ? ""
        : `${others.length} thing${s(others.length)} worth a look: ${others.map((f) => f.text).join("; ")}.`,
  };
}

/** The indicator's whole state, from one snapshot. */
export function deriveCodeStatus(snap: CodeStatusSnapshot): CodeStatusView {
  const facts = factsOf(snap);
  const noticeCount = facts.filter((f) => f.notice).length;

  if (snap.phase === "loading") {
    // Refusals are counted live, so they can arrive before the first read
    // lands. They are worth a look already, and the words say so as well as
    // the dot does.
    const worth = worthALook(facts, null);
    return {
      level: noticeCount > 0 ? "notice" : "loading",
      count: null,
      facts,
      noticeCount,
      title:
        worth.count === 0
          ? "Checking the code in this file…"
          : `Checking the code in this file… · ${worth.count} worth a look`,
      ariaLabel: `Code and scripts: checking the code in this file.${worth.sentence ? ` ${worth.sentence}` : ""} Show details.`,
    };
  }

  const inv = snap.inventory;
  let level: CodeStatusLevel;
  if (incomplete(snap) || inv === null) level = "unknown";
  else if (noticeCount > 0) level = "notice";
  else if (
    inv.total > 0 ||
    (snap.heldButtons ?? 0) > 0 ||
    (snap.commandButtons ?? 0) > 0 ||
    snap.held?.any === true
  ) {
    level = "present";
  } else level = "none";

  // The headline says what is (or cannot be) known about the file's code; the
  // "worth a look" list then names the rest without repeating it.
  let headline: string;
  let headlineId: string | null = null;
  if (snap.inventoryError !== null || inv === null) {
    headline = "Could not read the code in this file";
    headlineId = "inventory-error";
  } else if (snap.inventoryGaps.length > 0) {
    headline =
      inv.total > 0
        ? `At least ${piecesOfCode(inv.total)} in this file; some could not be read`
        : "Could not read some of the code in this file";
    headlineId = "inventory-gaps";
  } else {
    headline = inv.total === 0 ? "No code in this file" : `${piecesOfCode(inv.total)} in this file`;
  }
  const worth = worthALook(facts, headlineId);

  return {
    level,
    count: level === "unknown" ? null : inv!.total,
    facts,
    noticeCount,
    title: worth.count === 0 ? headline : `${headline} · ${worth.count} worth a look`,
    ariaLabel: `Code and scripts: ${headline}.${worth.sentence ? ` ${worth.sentence}` : ""} Show details.`,
  };
}

// ============================================================================
// The source
// ============================================================================

/** One read of what the FILE holds. */
export interface CodeStatusFileRead {
  units: CodeUnit[];
  inventory: CodeStatusInventory;
  /** What could not be read, making `inventory` smaller than the truth. */
  gaps: string[];
  heldButtons: number | null;
  commandButtons: number | null;
}

/** The reads. A rejection is SAID ("Could not read ..."), never read as empty. */
export interface CodeStatusReaders {
  /** The inventory and the application buttons, from one walk of the file. */
  readFile(): Promise<CodeStatusFileRead>;
  /** Rejects when the schedule could not be listed. */
  readJobs(units: CodeUnit[]): Promise<ScheduledJobSummary>;
  /** Rejects when what scripts hold could not be read. */
  readHeld(units: CodeUnit[]): Promise<ScriptHeldStateSummary>;
  /** Refusals already recorded when the source starts (the launch document's). */
  refusalsSoFar(): number;
}

/** The signals. Each subscription returns its own unsubscribe. */
export interface CodeStatusSignals {
  /** File > New / Open: a different document is now the open one. */
  onDocumentReplaced(cb: () => void): () => void;
  /** Something that may have changed the code in the file (re-read, debounced). */
  onCodeMayHaveChanged(cb: () => void): () => void;
  /** The user came back to the window (re-read, unless a read just finished). */
  onUserReturned(cb: () => void): () => void;
  onAudit(cb: (entry: AuditEntry) => void): () => void;
}

export interface CodeStatusTiming {
  /** The one poll's tick: jobs + held state (cheap; reuse the last inventory). */
  lightPollMs: number;
  /** Every Nth tick reads the whole file instead -- for code no event
   *  announces (a notebook edit, a custom function). */
  fullEveryTicks: number;
  /** Coalesces a burst of change events into one read. */
  debounceMs: number;
  /** Refusal bursts (a script hammering a denied call) repaint at most this often. */
  notifyThrottleMs: number;
  /** Coming back to the window re-reads only if the last full read is older than this. */
  returnRefreshAfterMs: number;
  /** A hidden window does not poll. */
  isHidden(): boolean;
  now(): number;
}

export const DEFAULT_CODE_STATUS_TIMING: CodeStatusTiming = {
  lightPollMs: 15_000,
  fullEveryTicks: 4,
  debounceMs: 250,
  notifyThrottleMs: 250,
  returnRefreshAfterMs: 5_000,
  isHidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
  now: () => Date.now(),
};

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** `p` settled to its value, or `null` when it rejected. */
async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

/**
 * Keeps a CodeStatusSnapshot current. `subscribe`/`getSnapshot` are shaped for
 * React's useSyncExternalStore: the snapshot object only changes when its
 * contents do.
 */
export class CodeStatusSource {
  private snapshot: CodeStatusSnapshot = LOADING_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private readonly offs: Array<() => void> = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private ticks = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  /** Bumped when the document is replaced; a read of an older one is dropped. */
  private generation = 0;
  /** Monotonic read stamp: an OLDER read never overwrites a newer one's jobs/held. */
  private readSeq = 0;
  private appliedLiveSeq = 0;
  private units: CodeUnit[] = [];
  private inFlight: Promise<void> | null = null;
  private rerun = false;
  private lastFullReadAt = Number.NEGATIVE_INFINITY;
  private refusals = 0;

  constructor(
    private readonly readers: CodeStatusReaders,
    private readonly signals: CodeStatusSignals,
    private readonly timing: CodeStatusTiming = DEFAULT_CODE_STATUS_TIMING,
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): CodeStatusSnapshot => this.snapshot;

  /**
   * Start listening and reading. Start it BEFORE the launch document's scripts
   * mount: a refusal made while they load must be counted, and the refusals
   * already in the ring (made before this extension activated) are seeded once
   * here -- for the launch document only, since the ring is never cleared per
   * document and a later File > Open starts from zero.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.refusals = this.readers.refusalsSoFar();
    if (this.refusals > 0) this.setSnapshot({ ...this.snapshot, refusals: this.refusals });
    this.offs.push(this.signals.onDocumentReplaced(() => this.documentReplaced()));
    this.offs.push(this.signals.onCodeMayHaveChanged(() => this.scheduleFull()));
    this.offs.push(
      this.signals.onUserReturned(() => {
        if (this.timing.now() - this.lastFullReadAt >= this.timing.returnRefreshAfterMs) this.scheduleFull();
      }),
    );
    this.offs.push(
      this.signals.onAudit((entry) => {
        if (!isAuditRefusal(entry)) return;
        this.refusals += 1;
        this.patch({ refusals: this.refusals }, true);
      }),
    );
    // ONE timer: a tick reads jobs + held, every Nth tick reads the whole file
    // instead (which brings jobs + held too) -- never both at once.
    this.pollTimer = setInterval(() => {
      if (this.timing.isHidden()) return;
      this.ticks += 1;
      if (this.ticks % this.timing.fullEveryTicks === 0) void this.refreshNow();
      else void this.refreshLive();
    }, this.timing.lightPollMs);
    void this.refreshNow();
  }

  stop(): void {
    this.running = false;
    for (const off of this.offs.splice(0)) off();
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    if (this.notifyTimer !== null) clearTimeout(this.notifyTimer);
    this.pollTimer = null;
    this.debounceTimer = null;
    this.notifyTimer = null;
    // Anything still in flight lands on a generation nobody reads.
    this.generation += 1;
  }

  /**
   * Re-read everything now. Calls made while a read is in flight coalesce into
   * ONE more read after it (never a second concurrent one), so the result is
   * always at least as new as the call.
   */
  refreshNow(): Promise<void> {
    if (!this.running) return Promise.resolve();
    if (this.inFlight) {
      this.rerun = true;
      return this.inFlight;
    }
    this.inFlight = (async () => {
      do {
        this.rerun = false;
        await this.readEverything();
      } while (this.rerun && this.running);
    })().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private scheduleFull(): void {
    if (!this.running) return;
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.refreshNow();
    }, this.timing.debounceMs);
  }

  private documentReplaced(): void {
    if (!this.running) return;
    this.generation += 1;
    this.units = [];
    this.refusals = 0;
    this.setSnapshot(LOADING_SNAPSHOT);
    void this.refreshNow();
  }

  private async readEverything(): Promise<void> {
    const generation = this.generation;
    const seq = ++this.readSeq;
    let file: CodeStatusFileRead | null = null;
    let inventoryError: string | null = null;
    try {
      file = await this.readers.readFile();
    } catch (e) {
      inventoryError = message(e) || "unknown error";
    }
    const units = file?.units ?? [];
    const [jobs, held] = await Promise.all([
      orNull(this.readers.readJobs(units)),
      orNull(this.readers.readHeld(units)),
    ]);
    if (generation !== this.generation || !this.running) return;
    this.units = units;
    this.lastFullReadAt = this.timing.now();
    const live = seq > this.appliedLiveSeq;
    if (live) this.appliedLiveSeq = seq;
    this.patch({
      phase: "ready",
      inventory: file?.inventory ?? null,
      inventoryError,
      inventoryGaps: file?.gaps ?? [],
      heldButtons: file ? file.heldButtons : null,
      commandButtons: file ? file.commandButtons : null,
      // A slower full read must not overwrite a NEWER poll's jobs/held.
      ...(live ? { jobs, held } : {}),
    });
  }

  /** Jobs + held state only, against the last inventory. */
  private async refreshLive(): Promise<void> {
    // Before the first read there is no inventory to reuse, and a full read
    // in flight will bring both anyway.
    if (!this.running || this.inFlight || this.snapshot.phase === "loading") return;
    const generation = this.generation;
    const seq = ++this.readSeq;
    const [jobs, held] = await Promise.all([
      orNull(this.readers.readJobs(this.units)),
      orNull(this.readers.readHeld(this.units)),
    ]);
    if (generation !== this.generation || !this.running || seq <= this.appliedLiveSeq) return;
    this.appliedLiveSeq = seq;
    this.patch({ jobs, held });
  }

  private patch(changes: Partial<CodeStatusSnapshot>, throttled = false): void {
    const next = { ...this.snapshot, ...changes };
    const keys = Object.keys(changes) as Array<keyof CodeStatusSnapshot>;
    if (keys.every((k) => sameValue(this.snapshot[k], next[k]))) return;
    this.snapshot = next;
    if (throttled) this.notifySoon();
    else this.notifyNow();
  }

  private setSnapshot(next: CodeStatusSnapshot): void {
    if (next === this.snapshot) return;
    this.snapshot = next;
    this.notifyNow();
  }

  private notifyNow(): void {
    if (this.notifyTimer !== null) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
    for (const l of [...this.listeners]) l();
  }

  private notifySoon(): void {
    if (this.notifyTimer !== null) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      for (const l of [...this.listeners]) l();
    }, this.timing.notifyThrottleMs);
  }
}

/** Shallow structural equality for the snapshot's fields (numbers, strings,
 *  null, string arrays, and the flat summary objects). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
}
