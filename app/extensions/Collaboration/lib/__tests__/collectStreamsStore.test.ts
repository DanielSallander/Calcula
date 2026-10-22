//! FILENAME: app/extensions/Collaboration/lib/__tests__/collectStreamsStore.test.ts
// PURPOSE: The client copy of Writeback > Collect From: quick ticks in the
//          stay-open menu never lose an earlier one, the view is re-read after
//          every event that can change it (a first publish creates the link),
//          and a failed read is said as one -- never "publish first".
// CONTEXT: Fixer round 2026-10-22 (critique findings on the envs work). Every
//          backend door is the @api/collaboration wrapper, doubled here with
//          promises the test resolves by hand, so the in-flight window is real.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CollectionStreamsView, CollectStreamsChoice, StreamChoice } from "@api/collaboration";

const h = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock("@api/collaboration", () => ({
  getCollectionStreams: () => h.get(),
  setCollectionStreams: (c: unknown) => h.set(c),
  ENVIRONMENTS_CHANGED_EVENT: "collaboration:environments-changed",
}));
vi.mock("@api/events", () => ({
  emitAppEvent: vi.fn(),
  AppEvents: { AFTER_OPEN: "app:after-open", AFTER_NEW: "app:after-new" },
}));
vi.mock("@api/notifications", () => ({ showToast: vi.fn() }));

import {
  COLLECT_STREAMS_REFRESH_EVENTS,
  getCollectStreamsError,
  getCollectStreamsView,
  refreshCollectStreams,
  resetCollectStreams,
  toggleCollectStream,
  wireCollectStreamsRefresh,
} from "../collectStreamsStore";
import { heroBadge, heroTooltip, NOT_PUBLISHED_TOOLTIP } from "../collectStreamsModel";

function choice(stream: string, included: boolean): StreamChoice {
  return {
    stream,
    label: stream === "" ? "Development line" : stream,
    kind: stream === "" ? "developmentLine" : "environment",
    included,
    version: null,
    hint: "",
  };
}

/** The view Rust returns for an explicit set. */
function viewOf(selection: string[]): CollectionStreamsView {
  return {
    linked: true,
    packageName: "app",
    registryUrl: "C:\\ws",
    mode: "only",
    selection,
    collecting: selection,
    defaultStream: "prod",
    choices: ["", "test", "prod", "dev"].map((s) => choice(s, selection.includes(s))),
    notCollected: [],
    environmentsError: null,
    summary: selection.join(", "),
    canChange: true,
    changeRefusal: null,
  };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  resetCollectStreams();
  h.get.mockReset();
  h.set.mockReset();
});

describe("toggleCollectStream: quick ticks in the stay-open menu", () => {
  /**
   * From {prod, test}: untick test, then -- before Rust has answered -- tick
   * dev. The second request must be computed from the view the FIRST returned,
   * so the result is {prod, dev}; computed from the rendered view it was
   * {prod, test, dev} and the untick of test was lost.
   *
   * SABOTAGE: compute the next choice from the view captured when the click
   * was made (outside the write chain).
   */
  it("computes each request from the latest view, so a second tick never undoes the first", async () => {
    h.get.mockResolvedValue(viewOf(["prod", "test"]));
    await refreshCollectStreams();
    const asked: CollectStreamsChoice[] = [];
    const answers: Array<(v: CollectionStreamsView) => void> = [];
    h.set.mockImplementation(
      (c: CollectStreamsChoice) =>
        new Promise<CollectionStreamsView>((resolve) => {
          asked.push(c);
          answers.push(resolve);
        }),
    );
    const first = toggleCollectStream("test");
    const second = toggleCollectStream("dev");
    await flush();
    expect(asked).toEqual([{ only: ["prod"] }]);
    answers[0](viewOf(["prod"]));
    await flush();
    expect(asked[1]).toEqual({ only: ["dev", "prod"] });
    answers[1](viewOf(["dev", "prod"]));
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(getCollectStreamsView()?.selection).toEqual(["dev", "prod"]);
  });

  it("refuses to leave nothing collected without asking Rust", async () => {
    h.get.mockResolvedValue(viewOf(["prod"]));
    await refreshCollectStreams();
    expect(await toggleCollectStream("prod")).toBe(false);
    expect(h.set).not.toHaveBeenCalled();
  });
});

describe("what re-reads the view", () => {
  /**
   * A FIRST PUBLISH creates the link, and announces only
   * ENVIRONMENTS_CHANGED_EVENT (so do a pipeline edit and a promotion, which
   * move the default): the control left "Publish first" disabled until the
   * file was reopened.
   *
   * SABOTAGE: drop ENVIRONMENTS_CHANGED_EVENT from COLLECT_STREAMS_REFRESH_EVENTS.
   */
  it("a publish (environments changed) moves the view from unlinked to linked", async () => {
    h.get.mockResolvedValue({ ...viewOf([]), linked: false });
    await refreshCollectStreams();
    expect(getCollectStreamsView()?.linked).toBe(false);
    const handlers = new Map<string, () => void>();
    wireCollectStreamsRefresh((name, cb) => {
      handlers.set(name, cb);
      return () => handlers.delete(name);
    });
    expect([...handlers.keys()]).toEqual([...COLLECT_STREAMS_REFRESH_EVENTS]);
    h.get.mockResolvedValue(viewOf(["prod"]));
    handlers.get("collaboration:environments-changed")?.();
    await flush();
    expect(getCollectStreamsView()?.linked).toBe(true);
  });
});

describe("a failed read", () => {
  /**
   * A published application whose Collect From read FAILS was told to
   * "publish first", and a failed re-read kept showing a stale view as
   * current. The error is said, and badged.
   *
   * SABOTAGE: ignore the error in `heroTooltip`.
   */
  it("is said as a failure, never 'publish first', and a stale view says so", async () => {
    h.get.mockRejectedValue(new Error("the share is offline"));
    await refreshCollectStreams();
    const error = getCollectStreamsError();
    expect(error).toBe("the share is offline");
    expect(heroTooltip(getCollectStreamsView(), error)).toBe(
      "Could not read which streams this workbook collects: the share is offline",
    );
    expect(heroTooltip(null, error)).not.toBe(NOT_PUBLISHED_TOOLTIP);
    expect(heroBadge(null, error)).toBe("!");
    const stale = heroTooltip(viewOf(["prod"]), error);
    expect(stale).toContain("Collecting from: prod.");
    expect(stale).toContain("may be out of date");
    expect(heroTooltip(null, null)).toBe(NOT_PUBLISHED_TOOLTIP);
  });
});
