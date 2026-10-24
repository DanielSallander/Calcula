//! FILENAME: app/extensions/AutoRecover/__tests__/autoRecoverRefusalNotice.test.ts
// PURPOSE: AutoRecover tells the user, in a toast, when the backend has refused
//          three recovery copies in a row because the workbook kept changing --
//          keeps that card up for as long as copies are being skipped, and takes
//          it down the moment the streak ends.
// CONTEXT: `auto_recover_save` goes through Rust's `take_consistent_snapshot`
//          (persistence.rs); a sheet renumbering inside all three of its
//          attempts refuses the tick with "WORKBOOK_CHANGED_WHILE_SAVING: ...",
//          and nothing is written. The timer swallowed every error, so a burst
//          of agent deletes or moves could skip copy after copy with nothing on
//          screen -- and a crash then lost everything since the last save.
//
//          Two halves: the streak's rule (lib/refusalStreak.ts), and the REAL
//          extension -- activate, its interval on fake timers, the backend
//          channel bound to a doubled ctx.invokeBackend, and the real
//          @api/notifications with a sink and a dismisser registered the way
//          the Shell does (the sink here keeps each card "on screen" until its
//          own duration runs out -- never, for 0 -- or until it is dismissed).
//
//          THE WHOLE STREAK, AND NOT A TICK LONGER (review round 9, F4). Round 8
//          made the card a 30-second one, shown once per streak: a two-hour
//          streak at the default interval was on screen for half a minute and
//          then skipped copy after copy with nothing to see. Before that it was
//          permanent and nothing took it back, so it went stale and stacked.
//          It is now up for exactly the streak, through the toast's handle.
//
//          AND NOT A TIMER LONGER (review round 10, R10-3). Switching File >
//          AutoRecover off mid-streak stopped the timer and left the duration-0
//          card up for good (still there after 24 h of fake time), describing a
//          timer that no longer ran; switching it on again carried the old
//          count on. The toggle now starts a new streak both ways, and a save
//          that was in flight at the switch neither counts nor shows the card.
//          The File-menu items are captured from the doubled registerMenuItem
//          and pressed the way the menu presses them.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/** A registered File-menu item, as far as these tests press it. */
interface MenuItemLike {
  id: string;
  action?: () => unknown;
  children?: MenuItemLike[];
}

const menu = vi.hoisted(() => ({
  /** The File-menu items AutoRecover registered, by id. */
  items: {} as Record<string, MenuItemLike>,
}));

vi.mock("@api", () => ({
  registerMenuItem: vi.fn((_menu: string, item: MenuItemLike) => {
    menu.items[item.id] = item;
  }),
  unregisterMenuItem: vi.fn(),
  IconAutoRecover: () => null,
  IconClock: () => null,
}));

import { registerToastSink, type ToastPayload } from "@api/notifications";
import extension from "../index";
import {
  SKIPPED_SNAPSHOTS_NOTICE,
  SKIPPED_SNAPSHOTS_NOTICE_AFTER,
  createRefusalStreak,
} from "../lib/refusalStreak";

/** The refusal exactly as Rust formats it for the save door (AutoRecover shares it). */
const REFUSAL =
  "WORKBOOK_CHANGED_WHILE_SAVING: the workbook changed while it was being saved -- a sheet was " +
  "added, deleted or moved during each of 3 attempts to read it. Nothing was written; try again.";
const CODE = "WORKBOOK_CHANGED_WHILE_SAVING";
const INTERVAL_MS = 60_000;
/** The default interval: five minutes. */
const DEFAULT_INTERVAL_MS = 300_000;

/** A notice whose show and withdraw are recorded, in order. */
function recordingNotice() {
  const calls: ("show" | "withdraw")[] = [];
  return {
    calls,
    notice: {
      show: () => calls.push("show"),
      withdraw: () => calls.push("withdraw"),
    },
  };
}

describe("the streak's rule", () => {
  it("is three in a row", () => {
    expect(SKIPPED_SNAPSHOTS_NOTICE_AFTER).toBe(3);
  });

  // SABOTAGE: show on every refusal past the threshold (`>=`), or never.
  it("shows once when the third refusal in a row comes in, and not again for the same streak", () => {
    const { calls, notice } = recordingNotice();
    const streak = createRefusalStreak(notice);
    streak.failed(REFUSAL);
    streak.failed(REFUSAL);
    expect(calls).toEqual([]);
    streak.failed(REFUSAL);
    expect(calls).toEqual(["show"]);
    for (let i = 0; i < 20; i++) streak.failed(REFUSAL);
    expect(calls, "one streak showed twice").toEqual(["show"]);
  });

  // SABOTAGE: drop the withdraw from the streak's end.
  it("a written copy ends the streak AND takes its notice down; the next streak can show again", () => {
    const { calls, notice } = recordingNotice();
    const streak = createRefusalStreak(notice);
    for (let i = 0; i < 3; i++) streak.failed(REFUSAL);
    streak.succeeded();
    expect(streak.count).toBe(0);
    expect(calls).toEqual(["show", "withdraw"]);
    streak.failed(REFUSAL);
    streak.failed(REFUSAL);
    streak.failed(REFUSAL);
    expect(calls).toEqual(["show", "withdraw", "show"]);
  });

  // SABOTAGE: count every failure (drop the recogniser check).
  it("only the retryable refusal counts: not_dirty and any other error end the streak, take the notice down, and never show", () => {
    for (const other of ["not_dirty", "disk full", new Error("access denied")]) {
      const { calls, notice } = recordingNotice();
      const streak = createRefusalStreak(notice);
      for (let i = 0; i < 3; i++) streak.failed(REFUSAL);
      streak.failed(other);
      expect(streak.count, String(other)).toBe(0);
      expect(calls, String(other)).toEqual(["show", "withdraw"]);
    }
    const { calls, notice } = recordingNotice();
    const streak = createRefusalStreak(notice);
    for (let i = 0; i < 5; i++) streak.failed("disk full");
    expect(calls).toEqual([]);
  });

  it("a reset takes a notice that is up down, and a streak that never showed one withdraws nothing", () => {
    const { calls, notice } = recordingNotice();
    const streak = createRefusalStreak(notice);
    streak.failed(REFUSAL);
    streak.reset();
    streak.succeeded();
    expect(calls, "withdrew a notice that was never up").toEqual([]);
    for (let i = 0; i < 3; i++) streak.failed(REFUSAL);
    streak.reset();
    expect(calls).toEqual(["show", "withdraw"]);
    streak.succeeded();
    expect(calls, "withdrew the same notice twice").toEqual(["show", "withdraw"]);
  });

  it("the notice is plain words: no internal code", () => {
    expect(SKIPPED_SNAPSHOTS_NOTICE).not.toContain(CODE);
    expect(SKIPPED_SNAPSHOTS_NOTICE).toMatch(/skipping recovery copies/);
    expect(SKIPPED_SNAPSHOTS_NOTICE).toMatch(/keeps changing/);
  });
});

describe("the AutoRecover timer", () => {
  /** A save the test holds open: it answers when `settle` is called (a string REJECTS with it). */
  interface HeldSave {
    pending: Promise<string | undefined>;
  }
  /** What each coming auto_recover_save answers: a string REJECTS with it (bare, as Tauri does). */
  let answers: (string | undefined | HeldSave)[];
  /** Every card the sink was handed, with its id, when it was shown, and whether it was taken down. */
  let cards: { id: string; payload: ToastPayload; shownAt: number; gone: boolean }[];
  let saves: number;
  /** The interval the doubled settings report; the default is the menu's 1 minute. */
  let intervalMs = INTERVAL_MS;
  /** While set, set_auto_recover_settings waits for it: the switch is still being written. */
  let settingsWrite: Promise<void> | null = null;

  const invokeBackend = vi.fn(async (command: string) => {
    if (command === "get_auto_recover_settings") return { enabled: true, intervalMs };
    if (command === "set_auto_recover_settings") {
      if (settingsWrite) await settingsWrite;
      return { enabled: true, intervalMs };
    }
    if (command === "auto_recover_save") {
      saves += 1;
      let answer = answers.shift();
      if (answer !== undefined && typeof answer === "object") answer = await answer.pending;
      if (typeof answer === "string") throw answer;
      return "C:/Users/me/AppData/Local/Temp/~$calcula_unsaved.cala.recovery";
    }
    throw new Error(`unexpected command ${command}`);
  });

  /** Let `n` intervals elapse, each tick's save settling before the next. */
  async function ticks(n: number): Promise<void> {
    for (let i = 0; i < n; i++) await vi.advanceTimersByTimeAsync(intervalMs);
  }

  /** Let every promise job that is ready run (no time passes). */
  async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }

  /** A save that stays in flight until `answer` is called with what it answers. */
  function heldSave(): { held: HeldSave; answer: (with_: string | undefined) => void } {
    let answer!: (with_: string | undefined) => void;
    const pending = new Promise<string | undefined>((resolve) => (answer = resolve));
    return { held: { pending }, answer };
  }

  /** File > AutoRecover, pressed the way the menu presses it (it switches the setting). */
  function pressAutoRecover(): Promise<unknown> {
    const item = menu.items["file:autoRecover:toggle"];
    expect(item?.action, "File > AutoRecover is not registered").toBeTruthy();
    return Promise.resolve(item!.action!());
  }

  /** File > AutoRecover Interval > the `ms` entry. */
  async function pressInterval(ms: number): Promise<void> {
    const entry = menu.items["file:autoRecover:interval"]?.children?.find(
      (c) => c.id === `file:autoRecover:interval:${ms}`,
    );
    expect(entry?.action, `File > AutoRecover Interval has no ${ms} ms entry`).toBeTruthy();
    await entry!.action!();
  }

  /**
   * The cards ON SCREEN now, the way the Shell's toast store keeps them: from
   * when each was shown until it is dismissed or its own duration runs out --
   * which, for 0, it never does.
   */
  const onScreen = () =>
    cards.filter((c) => !c.gone && (c.payload.duration === 0 || Date.now() < c.shownAt + c.payload.duration));

  /** The user presses OK on every card on screen. */
  const userClicksOk = (): void => {
    for (const c of onScreen()) c.gone = true;
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    answers = [];
    cards = [];
    saves = 0;
    intervalMs = INTERVAL_MS;
    settingsWrite = null;
    for (const id of Object.keys(menu.items)) delete menu.items[id];
    registerToastSink(
      (payload) => {
        const id = `card-${cards.length + 1}`;
        cards.push({ id, payload, shownAt: Date.now(), gone: false });
        return id;
      },
      (id) => {
        const card = cards.find((c) => c.id === id);
        if (card) card.gone = true;
      },
    );
    await extension.activate({ invokeBackend } as never);
  });

  afterEach(() => {
    extension.deactivate?.();
    vi.useRealTimers();
  });

  // SABOTAGE: put the swallow-everything catch back in the timer.
  it("three refused ticks in a row put up ONE warning card, kept up until it is taken back", async () => {
    answers.push(REFUSAL, REFUSAL, REFUSAL, REFUSAL, REFUSAL);
    await ticks(2);
    expect(saves).toBe(2);
    expect(cards, "told before three in a row").toHaveLength(0);
    await ticks(1);
    expect(cards).toHaveLength(1);
    expect(cards[0].payload).toEqual({ message: SKIPPED_SNAPSHOTS_NOTICE, variant: "warning", duration: 0 });
    await ticks(2);
    expect(saves).toBe(5);
    expect(cards, "one streak told twice").toHaveLength(1);
    expect(cards.map((c) => c.payload.message).join(" "), "the raw code reached the screen").not.toContain(CODE);
  });

  // SABOTAGE: drop `skippedCopiesCard?.dismiss()` from the notice's withdraw --
  // the card then outlives the copy that ended its streak. (A 30-second card,
  // `duration: 30_000`, fails the every-tick half instead.)
  it("a long streak at the default interval: the card is on screen at EVERY tick, and gone right after the copy that ends it", async () => {
    extension.deactivate?.();
    intervalMs = DEFAULT_INTERVAL_MS;
    await extension.activate({ invokeBackend } as never);
    // Two hours of an agent moving sheets while the user is away.
    const STREAK = 24;
    for (let i = 0; i < STREAK; i++) answers.push(REFUSAL);
    answers.push(undefined);
    for (let t = 1; t <= STREAK; t++) {
      await ticks(1);
      const expected = t >= SKIPPED_SNAPSHOTS_NOTICE_AFTER ? 1 : 0;
      expect(onScreen().length, `after refusal ${t} of the streak`).toBe(expected);
    }
    expect(cards, "the streak put up more than one card").toHaveLength(1);
    await ticks(1);
    expect(saves).toBe(STREAK + 1);
    expect(onScreen(), "the card outlived the copy that ended its streak").toHaveLength(0);
  });

  it("every outcome that ends the streak takes the card down: not_dirty (the user saved) and another error too", async () => {
    for (const ending of ["not_dirty", "disk full"]) {
      answers.push(REFUSAL, REFUSAL, REFUSAL);
      await ticks(3);
      expect(onScreen(), `no card before ${ending}`).toHaveLength(1);
      answers.push(ending);
      await ticks(1);
      expect(onScreen(), `the card outlived ${ending}`).toHaveLength(0);
    }
    expect(cards).toHaveLength(2);
  });

  // SABOTAGE: show the card on every refusal past the threshold.
  it("a card the user clicked away is not shown again inside the same streak; the next streak shows it again", async () => {
    answers.push(REFUSAL, REFUSAL, REFUSAL);
    await ticks(3);
    expect(onScreen()).toHaveLength(1);
    userClicksOk();
    for (let i = 0; i < 6; i++) answers.push(REFUSAL);
    await ticks(6);
    expect(cards, "the streak showed its card again after the user dismissed it").toHaveLength(1);
    expect(onScreen()).toHaveLength(0);
    answers.push(undefined, REFUSAL, REFUSAL, REFUSAL);
    await ticks(4);
    expect(cards, "the next streak was not told").toHaveLength(2);
    expect(onScreen()).toHaveLength(1);
  });

  // SABOTAGE: drop the reset from deactivate.
  it("a deactivation takes the card down: nothing is skipping copies any more", async () => {
    answers.push(REFUSAL, REFUSAL, REFUSAL);
    await ticks(3);
    expect(onScreen()).toHaveLength(1);
    extension.deactivate?.();
    expect(onScreen(), "the card outlived the extension's timer").toHaveLength(0);
    // ...and the activation in afterEach's place starts clean.
    await extension.activate({ invokeBackend } as never);
    expect(onScreen()).toHaveLength(0);
  });

  it("streak, copy, streak, copy...: never two cards at once, and each streak is told", async () => {
    for (let burst = 0; burst < 6; burst++) {
      answers.push(REFUSAL, REFUSAL, REFUSAL, undefined);
      await ticks(3);
      expect(cards, `burst ${burst} was not told`).toHaveLength(burst + 1);
      expect(onScreen(), "cards stacked up").toHaveLength(1);
      await ticks(1);
      expect(onScreen(), "the notice outlived the copy that ended its streak").toHaveLength(0);
    }
  });

  it("an interval shorter than any card's life still shows one card at a time", async () => {
    extension.deactivate?.();
    intervalMs = 2_000;
    await extension.activate({ invokeBackend } as never);
    for (let i = 0; i < 12; i++) answers.push(REFUSAL, REFUSAL, REFUSAL, undefined);
    for (let t = 0; t < 12 * 4; t++) {
      await ticks(1);
      expect(onScreen().length, `two cards at once after tick ${t + 1}`).toBeLessThanOrEqual(1);
    }
    expect(cards, "a streak after the first was silenced").toHaveLength(12);
  });

  it("not_dirty and other errors stay silent, as before, and break the row", async () => {
    answers.push("not_dirty", "disk full", REFUSAL, REFUSAL, "not_dirty", REFUSAL, REFUSAL, "disk full", "not_dirty");
    await ticks(9);
    expect(saves).toBe(9);
    expect(cards).toHaveLength(0);
  });

  it("a fresh activation starts a fresh count", async () => {
    answers.push(REFUSAL, REFUSAL);
    await ticks(2);
    extension.deactivate?.();
    await extension.activate({ invokeBackend } as never);
    answers.push(REFUSAL);
    await ticks(1);
    expect(cards, "a count carried across activations").toHaveLength(0);
  });

  // ---- File > AutoRecover switched mid-streak (review round 10, R10-3) ----

  // SABOTAGE: drop `refusals.reset()` from the toggle's action.
  it("switching AutoRecover off mid-streak takes the card down; on again, a new streak is told at ITS third refusal", async () => {
    answers.push(REFUSAL, REFUSAL, REFUSAL);
    await ticks(3);
    expect(onScreen(), "the precondition: the card is up").toHaveLength(1);

    await pressAutoRecover(); // off
    expect(onScreen(), "the card outlived the timer it describes").toHaveLength(0);
    // A day later: nothing ticked, nothing came back.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(saves, "the timer still ran after AutoRecover was switched off").toBe(3);
    expect(onScreen()).toHaveLength(0);

    await pressAutoRecover(); // on
    answers.push(REFUSAL, REFUSAL);
    await ticks(2);
    expect(cards, "two refusals after switching on were told").toHaveLength(1);
    expect(onScreen()).toHaveLength(0);
    answers.push(REFUSAL);
    await ticks(1);
    expect(cards, "the new streak was not told").toHaveLength(2);
    expect(onScreen()).toHaveLength(1);
  });

  // SABOTAGE: drop `refusals.reset()` from the toggle's action -- the two
  // refusals before the switch then count toward the streak after it.
  it("off and on again starts a FRESH count: two refusals before the switch and two after show nothing", async () => {
    answers.push(REFUSAL, REFUSAL);
    await ticks(2);
    expect(cards, "the precondition: no card yet").toHaveLength(0);
    await pressAutoRecover(); // off
    await pressAutoRecover(); // on
    answers.push(REFUSAL, REFUSAL);
    await ticks(2);
    expect(cards, "the count from before the switch carried on after it").toHaveLength(0);
    answers.push(REFUSAL);
    await ticks(1);
    expect(onScreen(), "the third refusal of the new streak was not told").toHaveLength(1);
  });

  // SABOTAGE: drop the generation comparison from autoRecoverTick -- the save
  // that was in flight at the switch then counts toward the next streak, which
  // is told one refusal early.
  it("a save in flight at switch-off neither counts nor shows the card, even when it comes back after AutoRecover is on again", async () => {
    answers.push(REFUSAL, REFUSAL);
    await ticks(2);
    const third = heldSave();
    answers.push(third.held);
    await ticks(1);
    expect(saves, "the precondition: the third save is in flight").toBe(3);

    await pressAutoRecover(); // off
    await pressAutoRecover(); // on
    third.answer(REFUSAL);
    await settle();
    expect(cards, "the save from before the switch put the card up").toHaveLength(0);

    answers.push(REFUSAL, REFUSAL);
    await ticks(2);
    expect(cards, "the save from before the switch counted toward the new streak").toHaveLength(0);
    answers.push(REFUSAL);
    await ticks(1);
    expect(onScreen()).toHaveLength(1);
  });

  // SABOTAGE: drop `!currentEnabled` from autoRecoverTick's check -- a refusal
  // that comes back while the switch-off is still being written puts the card
  // up, until the switch's reset takes it down again.
  it("a save that comes back while the switch-off is still being written never puts the card up", async () => {
    answers.push(REFUSAL, REFUSAL);
    await ticks(2);
    const third = heldSave();
    answers.push(third.held);
    await ticks(1);
    let written!: () => void;
    settingsWrite = new Promise<void>((resolve) => (written = resolve));
    const switching = pressAutoRecover(); // off: the setting is being written
    third.answer(REFUSAL);
    await settle();
    expect(cards, "a refusal that came back after the switch-off put the card up").toHaveLength(0);
    written();
    await switching;
    expect(cards).toHaveLength(0);
    expect(saves).toBe(3);
  });

  // SABOTAGE: reset the streak in the interval entries' action too.
  it("an interval change keeps the streak: the card stays up, and once clicked away it is not shown again", async () => {
    answers.push(REFUSAL, REFUSAL, REFUSAL);
    await ticks(3);
    expect(onScreen()).toHaveLength(1);
    await pressInterval(120_000);
    intervalMs = 120_000;
    expect(onScreen(), "an interval change took down a card that is still true").toHaveLength(1);
    userClicksOk();
    answers.push(REFUSAL, REFUSAL, REFUSAL);
    await ticks(3);
    expect(saves).toBe(6);
    expect(cards, "the streak was announced again after an interval change").toHaveLength(1);
    // ...and the copy that ends it still takes everything down.
    answers.push(undefined);
    await ticks(1);
    expect(onScreen()).toHaveLength(0);
  });
});
