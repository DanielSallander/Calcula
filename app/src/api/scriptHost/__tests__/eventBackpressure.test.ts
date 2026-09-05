//! FILENAME: app/src/api/scriptHost/__tests__/eventBackpressure.test.ts
// PURPOSE: The host stops feeding a realm that has stopped keeping up, resumes
//          only once it has drained, and gives up on one that never answers.
// CONTEXT: `EVENT_QUEUE_HIGH_WATER` was declared in protocol.ts and read
//          NOWHERE in app/src. The realm has always acknowledged every dispatch
//          with `{t:"eventDone"}` (worker/bootstrap.ts), and the production
//          message loop ignored it — only the preview runner counted acks. So a
//          hook that stopped returning (an infinite loop, a promise that never
//          settles) let the host keep posting for as long as the workbook stayed
//          open: an unbounded queue behind a wedged consumer, and nothing that
//          would ever notice.
//
//          Three rules, each pinned here:
//            * HOLD at high water: past 256 unacknowledged dispatches the host
//              posts nothing more; discrete hooks queue in order, coalesced
//              hooks keep merging.
//            * RELEASE with hysteresis: posting resumes only once the realm has
//              drained below 64, not at 255 — one threshold flaps on every ack.
//            * A STALL is a crash: a held realm that acknowledges nothing for
//              `EVENT_STALL_MS` is respawned exactly as a crashed one is.
//
//          Same FakeWorker harness as hookEventDelivery.test.ts; the worker here
//          deliberately never acknowledges on its own, so the test decides when
//          the realm "drains".

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { H2W, W2H } from "../protocol";
import { EVENT_QUEUE_HIGH_WATER, EVENT_QUEUE_LOW_WATER, EVENT_STALL_MS } from "../protocol";
import { AppEvents, emitAppEvent } from "../../events";

vi.mock("../../backend", () => ({
  invokeBackend: vi.fn().mockResolvedValue(null),
  getWorkbookProperties: vi.fn().mockRejectedValue(new Error("no backend in test")),
  emitTauriEvent: vi.fn().mockResolvedValue(undefined),
  listenTauriEvent: vi.fn().mockResolvedValue(() => undefined),
}));
vi.mock("../capabilities", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  restoreAndSyncGrants: vi.fn().mockResolvedValue(undefined),
  revokeBackendCapabilities: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../mountGate", () => ({
  assertMountAllowed: vi.fn().mockResolvedValue(undefined),
}));

class FakeWorker {
  static instances: FakeWorker[] = [];
  static last: FakeWorker | null = null;
  onmessage: ((e: MessageEvent<W2H>) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  received: H2W[] = [];
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
    FakeWorker.last = this;
  }

  postMessage(msg: H2W): void {
    this.received.push(msg);
    if (msg.t === "mount") this.emit({ t: "mounted", ok: true });
    // NO automatic eventDone: this realm acknowledges only when the test says.
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(data: W2H): void {
    this.onmessage?.({ data } as MessageEvent<W2H>);
  }

  declareHook(hook: string): void {
    this.emit({ t: "hookRegistered", hook });
  }

  /** The realm reports `n` dispatches of `hook` complete. */
  ack(hook: string, n: number): void {
    for (let i = 0; i < n; i++) this.emit({ t: "eventDone", hook });
  }

  events(hook: string): unknown[] {
    return this.received
      .filter((m): m is Extract<H2W, { t: "event" }> => m.t === "event" && m.hook === hook)
      .map((m) => m.payload);
  }
}

const globalScope = globalThis as unknown as Record<string, unknown>;
const originalWorker = globalScope.Worker;

type HostModule = typeof import("../host");
let host: HostModule;

const DEFINITION = {
  id: "script-backpressure",
  name: "Sheet watcher",
  objectType: "workbook",
  instanceId: null,
  source: "function setup(context) { context.onSheetAdd(() => {}); }",
  accessLevel: "restricted" as const,
  apiVersion: "1.0.0",
};

// A DISCRETE hook whose forwarder passes the app event's detail through RAW
// (the after-save forwarder thins its payload, which would hide the ordering
// marker below). Its workbook-mirror push ahead of the forward is an unawaited
// backend call, harmless under the mocked backend. Declared and posted by its
// BARE name, exactly as the realm declares it.
const HOOK = "onSheetAdd";

async function mountWatcher(): Promise<FakeWorker> {
  await host.hostMountScript({ ...DEFINITION });
  const worker = FakeWorker.last!;
  worker.declareHook(HOOK);
  return worker;
}

/** Fire `n` distinct sheet-added events; each is one discrete dispatch. */
function addSheets(n: number, from = 0): void {
  for (let i = 0; i < n; i++) {
    emitAppEvent(AppEvents.SHEET_ADDED, { index: from + i, name: `Sheet${from + i}` });
  }
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  FakeWorker.instances = [];
  FakeWorker.last = null;
  globalScope.Worker = FakeWorker as unknown as typeof Worker;
  // NO `vi.resetModules()`: `emitAppEvent` above is a static import, and a
  // reset would give the freshly imported host a DIFFERENT events instance to
  // subscribe on — every emit here would then land on the stale one and nothing
  // would ever reach the worker. Same shape as hookEventDelivery.test.ts.
  host = await import("../host");
});

afterEach(() => {
  vi.useRealTimers();
  host.hostUnmountScript(DEFINITION.id);
  globalScope.Worker = originalWorker;
});

describe("hold at high water", () => {
  it("posts no more than HIGH_WATER unacknowledged dispatches, and queues the rest in order", async () => {
    const worker = await mountWatcher();
    addSheets(EVENT_QUEUE_HIGH_WATER + 44);

    const posted = worker.events(HOOK);
    expect(posted).toHaveLength(EVENT_QUEUE_HIGH_WATER);
    // ...and it is the FIRST 256, in order — nothing was reordered or dropped.
    expect((posted[0] as { index: number }).index).toBe(0);
    expect((posted[posted.length - 1] as { index: number }).index).toBe(EVENT_QUEUE_HIGH_WATER - 1);
  });
});

describe("release with hysteresis", () => {
  it("does NOT resume at one ack below high water", async () => {
    const worker = await mountWatcher();
    addSheets(EVENT_QUEUE_HIGH_WATER + 10);
    worker.ack(HOOK, 1);
    expect(worker.events(HOOK)).toHaveLength(EVENT_QUEUE_HIGH_WATER);
  });

  it("resumes once the realm has drained below LOW_WATER, delivering the backlog in order", async () => {
    const worker = await mountWatcher();
    const total = EVENT_QUEUE_HIGH_WATER + 44;
    addSheets(total);
    // Drain to just above low water: still held.
    worker.ack(HOOK, EVENT_QUEUE_HIGH_WATER - EVENT_QUEUE_LOW_WATER - 1);
    expect(worker.events(HOOK)).toHaveLength(EVENT_QUEUE_HIGH_WATER);
    // One more ack crosses low water: the whole backlog goes out.
    worker.ack(HOOK, 1);
    const posted = worker.events(HOOK) as Array<{ index: number }>;
    expect(posted).toHaveLength(total);
    expect(posted.map((p) => p.index)).toEqual([...Array(total).keys()]);
  });

  it("keeps a coalesced hook merging while held and flushes it on release", async () => {
    const worker = await mountWatcher();
    // A coalesced hook a WORKBOOK script has (onDataChange is a sheet hook).
    worker.declareHook("onThemeChange");
    addSheets(EVENT_QUEUE_HIGH_WATER + 5);
    // Fired twice while held: coalesced to the latest, and NOT posted — even
    // after the animation frame that would normally flush it.
    emitAppEvent(AppEvents.THEME_CHANGED, { theme: "one" });
    emitAppEvent(AppEvents.THEME_CHANGED, { theme: "two" });
    await settle();
    expect(worker.events("onThemeChange")).toHaveLength(0);
    // Release: ONE coalesced payload follows the discrete backlog.
    worker.ack(HOOK, EVENT_QUEUE_HIGH_WATER);
    expect(worker.events("onThemeChange")).toHaveLength(1);
  });
});

describe("a stall is a crash", () => {
  it("respawns a held realm that acknowledges nothing for EVENT_STALL_MS", async () => {
    // Fake timers BEFORE the hold engages: the stall watchdog's setTimeout is
    // created when the queue crosses high water, and a timer created under
    // real time is invisible to a clock faked afterwards.
    vi.useFakeTimers();
    const worker = await mountWatcher();
    addSheets(EVENT_QUEUE_HIGH_WATER + 1);
    await vi.advanceTimersByTimeAsync(EVENT_STALL_MS + 1);

    expect(worker.terminated, "the wedged realm was left running").toBe(true);
    // One free respawn, exactly as a crash gets.
    expect(FakeWorker.instances).toHaveLength(2);
    expect(FakeWorker.instances[1].terminated).toBe(false);
    expect(host.hostIsMounted(DEFINITION.id)).toBe(true);
  });

  it("does not fire while the realm keeps acknowledging", async () => {
    // Fake timers BEFORE the hold engages: the stall watchdog's setTimeout is
    // created when the queue crosses high water, and a timer created under
    // real time is invisible to a clock faked afterwards.
    vi.useFakeTimers();
    const worker = await mountWatcher();
    addSheets(EVENT_QUEUE_HIGH_WATER + 1);
    await vi.advanceTimersByTimeAsync(EVENT_STALL_MS - 1000);
    worker.ack(HOOK, 1); // proof of life re-arms the watchdog
    await vi.advanceTimersByTimeAsync(2000);
    expect(worker.terminated).toBe(false);
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it("never fires below high water — an ordinary backlog is not a stall", async () => {
    vi.useFakeTimers();
    const worker = await mountWatcher();
    addSheets(EVENT_QUEUE_LOW_WATER);
    await vi.advanceTimersByTimeAsync(EVENT_STALL_MS * 2);
    expect(worker.terminated).toBe(false);
  });
});
