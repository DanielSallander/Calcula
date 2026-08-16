//! FILENAME: app/e2e/startupBarrier.ts
// PURPOSE: The CDP half of the startup guard -- read the page under test over
//          the same connection the fixtures use, feed `waitForMount`, and either
//          let the run proceed or THROW a message that names itself.
// CONTEXT: BUG-0082 / open-decisions §32. The decision logic and every sentence
//          live in `startupGuard.ts`, which imports nothing from Playwright and
//          is unit-tested; this file is the glue that turns a live WebView2 into
//          the `StartupProbe` that logic consumes. Splitting them is what gives
//          the guard a unit tier: the arms that matter (stalled vs slow, wrong
//          origin, missing bridge) are decided by a pure function over readings,
//          so they can be exercised without launching anything.
//
// WHY IT INSTRUMENTS THE NETWORK. BUG-0082's own note records the gap: "the
// trace's network log is empty because tracing starts after load, so this is
// UNRESOLVED rather than excluded". The barrier attaches `Network.enable`
// BEFORE it starts waiting, so the response counter is the one signal that can
// tell a cold Vite transform (thousands of module responses, still arriving)
// from a stall (silence) -- which is exactly what decides whether waiting longer
// is reasonable or futile.

import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import {
  describeMountSuccess,
  describeStartupFailure,
  isExpectedOrigin,
  mountBounds,
  recordMountTiming,
  recordStartupFailure,
  startupGuardDisabled,
  waitForMount,
  type MountFailure,
  type StartupProbe,
  type StartupSurvey,
} from "./startupGuard";
import { BOOT_ERROR_SIGNALS, readPageState, UNREADABLE_PAGE_STATE } from "./pageState";

/**
 * What one page reports about itself, read in ONE round trip.
 *
 * The reading -- and in particular HOW a rendered root error boundary is
 * recognised -- lives in `pageState.ts`, shared with `fixtures.ts`. It used to
 * be inlined here and separately (differently) in the fixture, which is two
 * sources of truth for the one question the guard turns on. See that file for
 * why the boundary is no longer identified by `data-testid` alone.
 */
const PAGE_STATE = readPageState;

const UNREADABLE = UNREADABLE_PAGE_STATE;

/**
 * Count responses per page, attaching one CDP session per page the first time
 * it is seen. The count is monotonic for the life of the barrier, which is what
 * `progressKey` needs: a number that only ever goes up while the launch works.
 */
class NetworkActivity {
  private counts = new Map<Page, number>();
  private attaching = new Set<Page>();

  constructor(private context: BrowserContext) {}

  /** Attach lazily; a page that cannot be instrumented reports -1 forever. */
  async ensure(page: Page): Promise<void> {
    if (this.counts.has(page) || this.attaching.has(page)) return;
    this.attaching.add(page);
    try {
      const session = await this.context.newCDPSession(page);
      await session.send("Network.enable");
      this.counts.set(page, 0);
      session.on("Network.responseReceived", () => {
        this.counts.set(page, (this.counts.get(page) ?? 0) + 1);
      });
    } catch {
      this.counts.set(page, -1);
    } finally {
      this.attaching.delete(page);
    }
  }

  get(page: Page): number {
    return this.counts.get(page) ?? -1;
  }
}

/**
 * The page the barrier should judge, out of everything the context holds.
 *
 * A run can legitimately have more than one page (a Script Editor window left
 * open by a previous manual session is a separate Tauri WebviewWindow), so
 * picking `pages()[0]` and calling it "the app" would report the wrong page's
 * state. Preference order: something that mounted > something on the app's own
 * origin > the first page. Exported for the unit tier.
 */
export function pickAppPage<T>(
  pages: T[],
  read: (p: T) => { rootChildCount: number; url: string },
  vitePort: number,
): T | null {
  if (pages.length === 0) return null;
  const mounted = pages.find((p) => read(p).rootChildCount > 0);
  if (mounted) return mounted;
  const onOrigin = pages.find((p) => isExpectedOrigin(read(p).url, vitePort));
  if (onOrigin) return onOrigin;
  return pages[0];
}

export interface BarrierOptions {
  cdpPort: number;
  vitePort: number;
  /** Printed with every notice so a log says WHICH barrier spoke. */
  label?: string;
}

/**
 * Connect, wait for the frontend to mount, and THROW if it does not.
 *
 * Called from `global-setup.ts`, so the failure lands before the first test is
 * attempted: Playwright reports the global-setup error and runs NOTHING, which
 * is the whole point -- BUG-0082 produced 12 and 18 product-looking failures for
 * a fact that has nothing to do with the product.
 */
export async function assertAppMounted(opts: BarrierOptions): Promise<void> {
  if (startupGuardDisabled()) return;

  const { capMs, stallMs, serverSilentMs, pollMs } = mountBounds();
  const label = opts.label ?? "startup-guard";

  // THE CONSOLE IS WHERE THE ANSWER WAS, both times this state was captured
  // live. Collected from the moment the barrier attaches and carried into the
  // failure message, so the next occurrence arrives with its own attribution
  // instead of a blank white screenshot.
  const consoleTail: string[] = [];
  const record = (line: string): void => {
    consoleTail.push(line);
    if (consoleTail.length > 12) consoleTail.shift();
  };

  let browser: Browser | null = null;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${opts.cdpPort}`);
  } catch (cause) {
    fail({
      ok: false,
      kind: "cdp-unreachable",
      elapsedMs: 0,
      quietMs: 0,
      samples: 0,
      probe: null,
      survey: null,
      cause,
    });
  }
  // `fail` throws; this is for the type checker, not for control flow.
  if (!browser) throw new Error("[startup-guard] unreachable");

  try {
    const context = browser.contexts()[0];
    if (!context) {
      fail({
        ok: false,
        kind: "no-page",
        elapsedMs: 0,
        quietMs: 0,
        samples: 0,
        probe: null,
        survey: { pageCount: 0, urls: [] },
        cause: new Error("the CDP connection exposed no browser context"),
      });
    }
    const network = new NetworkActivity(context);

    // Listen on every page the context has now and any it opens later. The
    // listeners are removed with the connection when the barrier disconnects.
    const listen = (page: Page): void => {
      page.on("console", (m) => record(`${m.type()}: ${m.text().slice(0, 300)}`));
      page.on("pageerror", (e) => record(`pageerror: ${String(e).slice(0, 300)}`));
    };
    for (const p of context.pages()) listen(p);
    context.on("page", listen);

    const readProbe = async (): Promise<{
      probe: StartupProbe | null;
      survey: StartupSurvey | null;
    }> => {
      const pages = context.pages().slice(0, 8);
      if (pages.length === 0) return { probe: null, survey: { pageCount: 0, urls: [] } };
      await Promise.all(pages.map((p) => network.ensure(p)));
      const states = await Promise.all(
        pages.map(async (p) => ({
          page: p,
          state: await p.evaluate(PAGE_STATE, BOOT_ERROR_SIGNALS).catch(() => UNREADABLE),
        })),
      );
      const chosen = pickAppPage(states, (s) => s.state, opts.vitePort);
      const survey: StartupSurvey = {
        pageCount: pages.length,
        urls: states.map((s) => s.state.url),
      };
      if (!chosen) return { probe: null, survey };
      return {
        probe: { ...chosen.state, networkResponses: network.get(chosen.page) },
        survey,
      };
    };

    let lastNotice = 0;
    const outcome = await waitForMount({
      readProbe,
      capMs,
      stallMs,
      serverSilentMs,
      pollMs,
      vitePort: opts.vitePort,
      onSample: (probe, elapsedMs) => {
        // A long wait must not be a silent one -- a reader watching the log has
        // to be able to tell "still loading" from "finished and empty", live.
        // That is the same distinction the verdict turns on, so it is the one
        // the progress line reports.
        if (elapsedMs - lastNotice < 5_000) return;
        lastNotice = elapsedMs;
        console.log(
          `[${label}] waiting for the frontend to mount: ${(elapsedMs / 1000).toFixed(0)}s` +
            ` -- #root ${probe ? probe.rootChildCount : "(no page)"} child(ren),` +
            ` readyState ${probe ? probe.readyState : "(none)"},` +
            ` ${probe ? probe.resourceCount : -1} resource(s), url ${
              probe ? probe.url : "(none)"
            }`,
        );
      },
    });

    if (!outcome.ok) fail({ ...outcome, consoleTail: [...consoleTail] });

    recordMountTiming(
      outcome.elapsedMs,
      true,
      `responses=${outcome.probe.networkResponses} samples=${outcome.samples}`,
    );
    console.log(describeMountSuccess(outcome));
  } finally {
    // Disconnect, do NOT close: the app under test must survive the barrier.
    // (`browser.close()` on a connectOverCDP browser disconnects the CDP client;
    // this is the same call `fixtures.ts` makes at the end of a worker.)
    try {
      await browser.close();
    } catch {
      /* the barrier's verdict outranks its cleanup */
    }
  }
}

/** One place that records the marker, prints the banner and throws. */
function fail(f: MountFailure): never {
  const message = describeStartupFailure(f);
  recordStartupFailure(message);
  recordMountTiming(f.elapsedMs, false, f.kind);
  console.error(message);
  throw new Error(message);
}
