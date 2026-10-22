//! FILENAME: app/extensions/Collaboration/lib/__tests__/publisherDashboard.test.tsx
// PURPOSE: Collected Responses (PublisherDashboardPane), rendered: it lists the
//          workbook's OWN designated regions from the publisher-side list and
//          shows their answers; a region that cannot be read yet says why
//          instead of an empty inbox; an empty workbook says what to do; a
//          review names the ROW's stream; WHICH streams are shown is the
//          workbook's one Writeback > Collect From choice -- the pane shows the
//          same control as the tab and has no picker of its own.
// CONTEXT: BUG-0553 (owner, 2026-10-21): the pane took its regions from the
//          SUBSCRIBER index (getWritebackRegions), where an author's region
//          never is, and printed "No writeback regions in this workbook." to the
//          person who designated B3:B5 while answers waited in the workspace.
//          Owner decision 2026-10-22: the pane's own stream picker is replaced
//          by Collect From (one source of truth).
//          Owner review 2026-10-22 ("the sheet selector and the environment
//          filter seem a bit squeezed"): the header is THREE ROWS -- Region over
//          its select, Collect from over a dropdown that names the choice (never
//          the ribbon hero), then the actions as a wrapping toolbar -- and the
//          pane paints with skin tokens only.
//          @testing-library/react is not installed; react-dom + `act`. Every
//          backend door is the @api/collaboration wrapper, doubled here.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CollectionRegion, CollectionStreamsView, RegionSubmission } from "@api/collaboration";

const h = vi.hoisted(() => ({
  regions: [] as unknown[],
  subscriberIndex: [] as unknown[],
  inbox: [] as unknown[],
  streams: null as unknown,
  handlers: new Map<string, Set<(p: unknown) => void>>(),
  listCollectionRegions: vi.fn(),
  getWritebackRegions: vi.fn(),
  loadRegionSubmissions: vi.fn(),
  regionResponseStatus: vi.fn(),
  getWritebackRollup: vi.fn(),
  setSubmissionState: vi.fn(),
  getCollectionStreams: vi.fn(),
  setCollectionStreams: vi.fn(),
}));

vi.mock("@api/collaboration", () => ({
  acquireSubmissionWatch: () => () => {},
  listCollectionRegions: () => h.listCollectionRegions(),
  // The SUBSCRIBER index: empty for an author. The pane must not read it.
  getWritebackRegions: () => h.getWritebackRegions(),
  // Forwarded with their real arity, so a stale stream argument is visible.
  loadRegionSubmissions: (...a: unknown[]) => h.loadRegionSubmissions(...a),
  regionResponseStatus: (...a: unknown[]) => h.regionResponseStatus(...a),
  getWritebackRollup: (id: string) => h.getWritebackRollup(id),
  setWritebackRollup: vi.fn(async () => {}),
  setSubmissionState: (...a: unknown[]) => h.setSubmissionState(...a),
  exportRegionSubmissionsCsv: vi.fn(async () => ""),
  exportRegionSubmissionsParquet: vi.fn(async () => []),
  getCollectionStreams: () => h.getCollectionStreams(),
  setCollectionStreams: (c: unknown) => h.setCollectionStreams(c),
  ENVIRONMENTS_CHANGED_EVENT: "collaboration:environments-changed",
}));
const onAppEvent = (name: string, cb: (p: unknown) => void) => {
  if (!h.handlers.has(name)) h.handlers.set(name, new Set());
  h.handlers.get(name)!.add(cb);
  return () => h.handlers.get(name)?.delete(cb);
};
vi.mock("@api", () => ({
  onAppEvent: (name: string, cb: (p: unknown) => void) => onAppEvent(name, cb),
  AppEvents: { SHEET_CHANGED: "app:sheet-changed", WRITEBACK_SUBMISSION_RECEIVED: "app:writeback-submission-received" },
}));
vi.mock("@api/events", () => ({
  emitAppEvent: (name: string, p: unknown) => h.handlers.get(name)?.forEach((cb) => cb(p)),
  onAppEvent: (name: string, cb: (p: unknown) => void) => onAppEvent(name, cb),
  AppEvents: {},
}));
vi.mock("@api/notifications", () => ({ showToast: vi.fn() }));
vi.mock("@api/dialogs", () => ({ promptAsync: vi.fn(async () => "") }));
vi.mock("../reportExport", () => ({ saveCsvReport: vi.fn(), saveParquetReport: vi.fn() }));

import { findHardcodedColours } from "@api/layout";
import { PublisherDashboardPane, NO_REGIONS_TEXT, inPipelineOrder } from "../../components/PublisherDashboardPane";
import { focusCollectedResponsesRegion } from "../collectedResponsesFocus";
import { resetCollectStreams } from "../collectStreamsStore";
import { WRITEBACK_COLLECTION_STREAMS_CHANGED_EVENT } from "../writebackIds";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const OWN: CollectionRegion = {
  regionId: "f55af308-ce25-405a-ac01-4610a115a926",
  role: "author",
  sheetId: "01a15d70-b30a-7e15-800c-62a1c4efa4d7",
  sheetIndex: 0,
  sheetName: "Report",
  rowStart: 2,
  rowEnd: 4,
  colStart: 1,
  colEnd: 1,
  packageName: "writeback-test",
  registryUrl: "C:\\writeback-test",
  version: "1.0.0",
  environments: [],
  collecting: null,
  designated: true,
  status: "ready",
  detail: "",
  note: "",
};

const VIEW: CollectionStreamsView = {
  linked: true,
  packageName: "writeback-test",
  registryUrl: "C:\\writeback-test",
  mode: "default",
  selection: null,
  collecting: ["prod"],
  defaultStream: "prod",
  choices: [
    { stream: "", label: "Development line", kind: "developmentLine", included: false, version: null, hint: "" },
    { stream: "test", label: "test", kind: "environment", included: false, version: "1.0.0", hint: "v1.0.0" },
    { stream: "prod", label: "prod", kind: "environment", included: true, version: "1.0.0", hint: "v1.0.0 · the default" },
  ],
  notCollected: [],
  environmentsError: null,
  summary: "prod (the last environment)",
  canChange: true,
  changeRefusal: null,
};

function row(over: Partial<RegionSubmission> = {}): RegionSubmission {
  return {
    submissionId: "s1",
    environment: "",
    regionId: OWN.regionId,
    cellRow: 2,
    cellCol: 1,
    submitterId: "01a087b6-3308-79f7-8002-aa29c40418ce",
    submitterName: "Salle",
    // The owner's real answers predate sign-in (identity phase 1).
    submitterPrincipal: "",
    sender: "beforeSignIn",
    origin: null,
    identity: { status: "beforeSignIn", reason: "beforeSignIn", writtenBy: "" },
    identityLabel: "Sent before sign-in (not signed)",
    counted: true,
    valueDisplay: "1",
    valueKind: "number",
    state: "submitted",
    submittedAt: "2026-10-21T09:00:00Z",
    updatedAt: "2026-10-21T09:00:00Z",
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(<PublisherDashboardPane />);
  });
  await settle();
}

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);
const rows = () => Array.from(container.querySelectorAll('[data-testid="publisher-dashboard-row"]'));

beforeEach(() => {
  resetCollectStreams();
  h.handlers.clear();
  h.regions = [OWN];
  h.subscriberIndex = [];
  h.streams = { ...VIEW, mode: "all", collecting: null, summary: "All streams" };
  h.inbox = [row(), row({ submissionId: "s2", cellRow: 3, valueDisplay: "2" })];
  h.listCollectionRegions.mockReset().mockImplementation(async () => h.regions);
  h.getWritebackRegions.mockReset().mockImplementation(async () => h.subscriberIndex);
  h.loadRegionSubmissions.mockReset().mockImplementation(async () => h.inbox);
  h.regionResponseStatus.mockReset().mockImplementation(async () => ({ expected: [], responded: [], missing: [] }));
  h.getWritebackRollup.mockReset().mockImplementation(async () => false);
  h.setSubmissionState.mockReset().mockImplementation(async () => {});
  h.getCollectionStreams.mockReset().mockImplementation(async () => h.streams);
  h.setCollectionStreams.mockReset().mockImplementation(async () => h.streams);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("Collected Responses for the AUTHOR of a region (BUG-0553)", () => {
  it("lists the workbook's own region and shows the answers sent to it", async () => {
    await mount();
    expect(container.textContent).not.toContain("No writeback regions");
    const select = q("publisher-dashboard-region") as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(select.options[0].textContent).toBe("Report!B3:B5");
    expect(rows()).toHaveLength(2);
    expect(q("publisher-dashboard-respondents")?.textContent).toBe("1 respondent");
    expect(h.getWritebackRegions).not.toHaveBeenCalled();
  });

  it("each row says WHO sent it: a signed claim, or sent before sign-in (identity phase 1)", async () => {
    h.inbox = [
      row(),
      row({
        submissionId: "s2",
        cellRow: 3,
        submitterId: "win-S-1-5-21-1-2-3-1001-0123456789abcdef0123456789abcdef",
        submitterName: "Alice",
        submitterPrincipal: "CORP\\alice",
        sender: "signed",
        origin: "script",
      }),
    ];
    await mount();
    const senders = Array.from(container.querySelectorAll('[data-testid="publisher-dashboard-sender"]'));
    expect(senders.map((e) => e.getAttribute("data-sender"))).toEqual(["beforeSignIn", "signed"]);
    expect(senders[0].textContent).toBe("Sent before sign-in (not signed)");
    // Unverified: the name is the sender's own CLAIM, never "Signed as".
    expect(senders[1].textContent).toBe("Signed; the sender says they are CORP\\alice, sent by a script");
  });

  /**
   * THE HEADER COUNTS WHAT THE RULE COUNTS. The strip says answers whose sender
   * could not be verified are "left out of every total"; the header totals
   * beside it must not count them (they stay listed and marked below).
   *
   * SABOTAGE: compute the header counts over `submissions` instead of
   * `headerRows(...)`.
   */
  it("under the rule, the header totals leave the uncounted answers out", async () => {
    h.inbox = [
      row({ submissionId: "s1", submitterId: "id-a", counted: true }),
      row({ submissionId: "s2", cellRow: 3, submitterId: "id-b", counted: false }),
      row({ submissionId: "s3", cellRow: 4, submitterId: "id-c", counted: false }),
    ];
    h.regionResponseStatus.mockImplementation(async () => ({
      expected: [],
      responded: [],
      missing: [],
      beforeSignIn: [],
      notCounted: [],
      requireVerified: true,
    }));
    await mount();
    expect(rows()).toHaveLength(3);
    expect(q("publisher-dashboard-respondents")?.textContent).toBe("1 respondent");
    expect(container.textContent).toContain("1 pending");
    expect(q("publisher-dashboard-not-counted")?.textContent).toBe("2 not counted (sender not verified)");
  });

  /**
   * A PUBLISH OR A PIPELINE EDIT RELOADS THE LIST: the first publish links the
   * workbook, and the default stream is the pipeline's last environment.
   *
   * SABOTAGE: drop the ENVIRONMENTS_CHANGED_EVENT subscription from the pane.
   */
  it("reloads its regions when the application's environments change", async () => {
    await mount();
    const before = h.listCollectionRegions.mock.calls.length;
    await act(async () => {
      h.handlers.get("collaboration:environments-changed")?.forEach((cb) => cb({}));
    });
    await settle();
    expect(h.listCollectionRegions.mock.calls.length).toBeGreaterThan(before);
  });

  /**
   * THE IDENTITY COLUMN (identity phase 1, read side): each row shows Rust's
   * verdict and whether the application's rule counts it; an uncounted answer
   * is SHOWN, marked, and counted in a chip -- and the roster names the
   * senders it left out.
   *
   * SABOTAGE: remove <IdentityRow row={s} /> from the row -- no identity lines.
   */
  it("each row shows the identity verdict, and what the rule does not count is marked", async () => {
    h.inbox = [
      row({
        submissionId: "s1",
        submitterName: "Alice",
        sender: "signed",
        identity: { status: "verified", reason: "ownerMatches", writtenBy: "CORP\alice" },
        identityLabel: "Verified: Windows account, checked against the file's writer",
        counted: true,
        submitterPrincipal: "CORP\alice",
      }),
      row({
        submissionId: "s2",
        cellRow: 3,
        valueDisplay: "500",
        submitterName: "Alice",
        sender: "signed",
        identity: { status: "notVerified", reason: "ownerMismatch", writtenBy: "CORP\bob" },
        identityLabel: "Not verified: written by CORP\bob",
        counted: false,
      }),
    ];
    h.regionResponseStatus.mockImplementation(async () => ({
      expected: ["CORP\alice"],
      responded: ["Alice"],
      missing: [],
      beforeSignIn: [],
      notCounted: ["Bob"],
      requireVerified: true,
    }));
    await mount();
    const ids = Array.from(container.querySelectorAll('[data-testid="publisher-dashboard-identity"]'));
    expect(ids.map((e) => e.getAttribute("data-identity"))).toEqual(["verified", "notVerified"]);
    expect(ids.map((e) => e.getAttribute("data-counted"))).toEqual(["true", "false"]);
    expect(ids[0].textContent).toBe("Identity: Verified: Windows account, checked against the file's writer");
    expect(ids[1].textContent).toBe("Identity: Not verified: written by CORP\bob — not counted");
    expect(q("publisher-dashboard-not-counted")?.textContent).toBe("1 not counted (sender not verified)");
    expect(q("publisher-dashboard-rule")?.textContent).toContain("counts only answers from verified senders");
    expect(q("publisher-dashboard-roster-not-counted")?.textContent).toBe("not counted (not verified): Bob");
  });

  it("an application that counts every answer shows no not-counted marks", async () => {
    await mount();
    expect(q("publisher-dashboard-not-counted")).toBeNull();
    expect(q("publisher-dashboard-rule")).toBeNull();
    const ids = Array.from(container.querySelectorAll('[data-testid="publisher-dashboard-identity"]'));
    expect(ids.every((e) => e.getAttribute("data-counted") === "true")).toBe(true);
  });

  it("a region that cannot be read yet says WHY, and reads nothing", async () => {
    h.regions = [
      {
        ...OWN,
        status: "notInPushedVersion",
        version: null,
        detail: "B3:B5 was designated after the last push of 'writeback-test' (v1.0.0). Push the application to start collecting responses for it; nothing has been collected yet.",
      },
    ];
    await mount();
    const note = q("publisher-dashboard-not-ready");
    expect(note?.getAttribute("data-status")).toBe("notInPushedVersion");
    expect(note?.textContent).toContain("designated after the last push");
    expect(h.loadRegionSubmissions).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
  });

  it("a workbook with no regions says what to do", async () => {
    h.regions = [];
    await mount();
    expect(q("publisher-dashboard-empty")?.textContent).toBe(NO_REGIONS_TEXT);
  });

  it("a review names the ROW's own stream", async () => {
    h.inbox = [row({ submissionId: "t1", environment: "test", valueDisplay: "7" })];
    await mount();
    const approve = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Approve");
    expect(approve).toBeTruthy();
    await act(async () => {
      approve!.click();
    });
    await settle();
    expect(h.setSubmissionState).toHaveBeenCalledTimes(1);
    const args = h.setSubmissionState.mock.calls[0];
    expect(args[0]).toBe(OWN.regionId);
    expect(args[4]).toBe("approved");
    expect(args[6]).toBe("t1");
    expect(args[7]).toBe("test");
  });

  it("a FAILED region list is said as a failure -- never 'this workbook has no writeback regions'", async () => {
    h.listCollectionRegions.mockReset().mockImplementation(async () => {
      throw new Error("the workspace share is offline");
    });
    await mount();
    expect(q("publisher-dashboard-empty")).toBeNull();
    expect(container.textContent).not.toContain(NO_REGIONS_TEXT);
    expect(q("publisher-dashboard-regions-error")?.textContent).toContain(
      "Could not read this workbook's writeback regions",
    );
    expect(q("publisher-dashboard-regions-error")?.textContent).toContain("offline");
  });

  it("a ready region's caveat is shown (a region no longer designated here)", async () => {
    h.regions = [
      {
        ...OWN,
        designated: false,
        note: "B3:B5 is no longer designated in this workbook, but v1.0.0 of 'writeback-test' still declares it.",
      },
    ];
    await mount();
    expect(q("publisher-dashboard-note")?.textContent).toContain("no longer designated");
    expect(rows()).toHaveLength(2);
  });

  it("opened FOR a region, it shows that region rather than the first", async () => {
    const second: CollectionRegion = { ...OWN, regionId: "second-region", rowStart: 6, rowEnd: 8, colStart: 3, colEnd: 3 };
    h.regions = [OWN, second];
    focusCollectedResponsesRegion("second-region");
    await mount();
    expect((q("publisher-dashboard-region") as HTMLSelectElement).value).toBe("second-region");
    expect(h.loadRegionSubmissions).toHaveBeenLastCalledWith("second-region");
  });
});

describe("Writeback > Collect From in the pane (owner decision 2026-10-22)", () => {
  // SABOTAGE: pass a pane-local stream to loadRegionSubmissions again -- the
  // one-argument expectation fails.
  it("reads with NO stream argument: Rust applies the workbook's one choice", async () => {
    await mount();
    expect(h.loadRegionSubmissions).toHaveBeenCalled();
    for (const call of h.loadRegionSubmissions.mock.calls) expect(call).toEqual([OWN.regionId]);
    for (const call of h.regionResponseStatus.mock.calls) expect(call).toEqual([OWN.regionId]);
  });

  it("has no stream picker of its own; an author region shows the Collect From control", async () => {
    await mount();
    expect(q("publisher-dashboard-stream")).toBeNull();
    const control = q("publisher-dashboard-collect-from") as HTMLButtonElement | null;
    expect(control).toBeTruthy();
    expect(control!.disabled).toBe(false);
    expect(control!.getAttribute("aria-haspopup")).toBe("menu");
    expect(control!.getAttribute("title")).toContain("Collecting from: All streams.");
  });

  it("names the collected streams, and labels each row with its stream when several can appear", async () => {
    h.regions = [{ ...OWN, collecting: ["", "prod"] }];
    h.inbox = [row({ environment: "prod", submissionId: "p" }), row({ environment: "", submissionId: "l", cellRow: 3 })];
    await mount();
    expect(q("publisher-dashboard-streams")?.textContent).toBe("from development line, prod");
    expect(rows().map((r) => r.getAttribute("data-stream"))).toEqual(["prod", ""]);
    expect(rows()[0].textContent).toContain("prod");
  });

  it("one collected stream: the strip names it and rows need no label", async () => {
    h.regions = [{ ...OWN, collecting: ["prod"] }];
    h.inbox = [row({ environment: "prod" })];
    await mount();
    expect(q("publisher-dashboard-streams")?.textContent).toBe("from prod");
    expect(rows()[0].getAttribute("data-stream")).toBe("prod");
  });

  it("warns when an explicit choice leaves an environment out", async () => {
    h.streams = { ...VIEW, mode: "only", selection: ["prod"], notCollected: ["staging"], summary: "prod" };
    await mount();
    expect(q("publisher-dashboard-not-collected")?.textContent).toContain("Not collected: staging.");
  });

  // SABOTAGE: drop the WRITEBACK_COLLECTION_STREAMS_CHANGED_EVENT handler -- the
  // re-read never happens.
  it("re-reads the list and the inbox when the choice changes (here or on the tab)", async () => {
    await mount();
    const lists = h.listCollectionRegions.mock.calls.length;
    const loads = h.loadRegionSubmissions.mock.calls.length;
    await act(async () => {
      h.handlers.get(WRITEBACK_COLLECTION_STREAMS_CHANGED_EVENT)?.forEach((cb) => cb({ summary: "prod" }));
    });
    await settle();
    expect(h.listCollectionRegions.mock.calls.length).toBeGreaterThan(lists);
    expect(h.loadRegionSubmissions.mock.calls.length).toBeGreaterThan(loads);
  });

  it("a SUBSCRIBED region shows its fixed stream and no Collect From control", async () => {
    h.regions = [{ ...OWN, role: "subscriber", collecting: ["test"] }];
    h.inbox = [row({ environment: "test" })];
    await mount();
    expect(q("publisher-dashboard-collect-from")).toBeNull();
    expect(q("publisher-dashboard-streams")?.textContent).toBe("in test (this workbook's stream)");
  });
});

// ============================================================================
// The header (owner review 2026-10-22: "the sheet selector and the
// environment filter seem a bit squeezed")
// ============================================================================

/** The header's rows, top to bottom, by name. */
const headerRows = () =>
  Array.from(container.querySelectorAll('[data-testid="publisher-dashboard-header"] [data-testid="publisher-dashboard-header-row"]'));
const headerRowNames = () => headerRows().map((r) => r.getAttribute("data-row"));
/** The text the Collect From dropdown SHOWS. */
const collectFromText = () =>
  container.querySelector('[data-testid="publisher-dashboard-collect-from"] [data-collect-from-text]')?.textContent ?? null;

const SEVERAL: CollectionStreamsView = {
  ...VIEW,
  mode: "only",
  selection: ["prod", "test"],
  collecting: ["prod", "test"],
  choices: VIEW.choices.map((c) => ({ ...c, included: c.stream !== "" })),
  summary: "prod, test",
};

describe("the header: Region, Collect from, then the actions -- three rows", () => {
  // SABOTAGE: put the select, the Collect From control and the buttons back in
  // ONE flex row -- there is one row, not three.
  it("an author region gets three rows, top to bottom, each holding its own controls", async () => {
    await mount();
    expect(headerRowNames()).toEqual(["region", "collectFrom", "actions"]);
    const [region, collectFrom, actions] = headerRows();

    const select = region.querySelector('[data-testid="publisher-dashboard-region"]') as HTMLSelectElement | null;
    expect(select?.tagName).toBe("SELECT");
    const regionLabel = region.querySelector("label");
    expect(regionLabel?.textContent).toBe("Region");
    // The label names the select (a click on "Region" focuses it).
    expect(regionLabel?.htmlFor).toBe(select!.id);
    expect(select!.id).not.toBe("");

    const collectFromLabel = collectFrom.querySelector("label");
    expect(collectFromLabel?.textContent).toBe("Collect from");
    const trigger = collectFrom.querySelector('[data-testid="publisher-dashboard-collect-from"]');
    expect(trigger?.tagName).toBe("BUTTON");
    // The label names the dropdown too (a click on "Collect from" reaches it),
    // as "Region" names its select.
    expect(collectFromLabel?.htmlFor).toBe(trigger!.id);
    expect(trigger!.id).not.toBe("");
    expect(collectFromLabel?.control).toBe(trigger);

    const ids = Array.from(actions.querySelectorAll("button")).map((b) => b.getAttribute("data-testid"));
    expect(ids).toEqual(["publisher-dashboard-refresh", "publisher-dashboard-export-csv", "publisher-dashboard-export-parquet"]);
    expect(Array.from(actions.querySelectorAll("button")).map((b) => b.textContent)).toEqual([
      "Refresh",
      "Export CSV",
      "Export Parquet",
    ]);

    // Every control sits in its own row and nowhere else.
    expect(region.querySelector('[data-testid="publisher-dashboard-collect-from"]')).toBeNull();
    expect(region.querySelector("button")).toBeNull();
    expect(collectFrom.querySelector("select")).toBeNull();
    expect(actions.querySelector("select")).toBeNull();
    expect(actions.querySelector('[data-testid="publisher-dashboard-collect-from"]')).toBeNull();
  });

  it("each field's label is ABOVE its control, the controls take the full width, and the toolbar wraps", async () => {
    await mount();
    const [region, collectFrom, actions] = headerRows();
    // Field in a panel: a column, label first.
    for (const rowEl of [region, collectFrom]) {
      const field = rowEl.firstElementChild as HTMLElement;
      expect(field.style.flexDirection).toBe("column");
      expect(field.firstElementChild?.tagName).toBe("LABEL");
    }
    // The select's box spans the row (the Select wrapper), as does the
    // dropdown: the @api field trigger sets its width -- 100% in a panel -- on
    // the element itself.
    // SABOTAGE: give FieldTrigger a fixed width in a panel -- this fails.
    const select = region.querySelector("select")!;
    expect((select.parentElement as HTMLElement).style.width).toBe("100%");
    expect((collectFrom.querySelector("button") as HTMLElement).style.width).toBe("100%");
    // A narrow pane (300px) wraps the three buttons instead of squeezing them.
    expect((actions.firstElementChild as HTMLElement).style.flexWrap).toBe("wrap");
  });

  it.each([
    ["All", { ...VIEW, mode: "all", collecting: null, summary: "All streams" } as CollectionStreamsView, "All streams"],
    ["one stream", VIEW, "prod"],
    ["several streams", SEVERAL, "test, prod"],
  ])("Collect from names the choice: %s", async (_name, streams, text) => {
    h.streams = streams;
    await mount();
    expect(collectFromText()).toBe(text);
  });

  // SABOTAGE: chip from `current.collecting` as Rust ordered it -- "from prod, test".
  it("the strip names the streams in the pipeline's order, as the dropdown above it does", async () => {
    h.regions = [{ ...OWN, environments: ["test", "prod"], collecting: ["prod", "test"] }];
    h.streams = SEVERAL;
    h.inbox = [row({ environment: "prod" }), row({ environment: "test", submissionId: "t", cellRow: 3 })];
    await mount();
    expect(collectFromText()).toBe("test, prod");
    expect(q("publisher-dashboard-streams")?.textContent).toBe("from test, prod");
    // ...and so does the dropdown's tooltip.
    expect(q("publisher-dashboard-collect-from")?.getAttribute("title")).toContain("Collecting from: test, prod.");
  });

  // An environment the pipeline DEFINES but has not promoted is missing from a
  // region's `environments` (only those with a version), so ranking by that
  // list put a chosen "staging" last: dropdown "staging, prod", strip "from
  // prod, staging". The strip ranks by the menu's own order.
  // SABOTAGE: rank by `current.environments` again -- "from prod, staging".
  it("one order for a stream not promoted yet: the strip, the dropdown and its tooltip agree", async () => {
    const pipeline: CollectionStreamsView = {
      ...VIEW,
      mode: "only",
      selection: ["prod", "staging"],
      collecting: ["prod", "staging"],
      choices: [
        { stream: "", label: "Development line", kind: "developmentLine", included: false, version: null, hint: "" },
        { stream: "test", label: "test", kind: "environment", included: false, version: "1.0.0", hint: "v1.0.0" },
        { stream: "staging", label: "staging", kind: "environment", included: true, version: null, hint: "no version yet" },
        { stream: "prod", label: "prod", kind: "environment", included: true, version: "1.0.0", hint: "v1.0.0" },
      ],
      summary: "prod, staging",
    };
    h.regions = [{ ...OWN, environments: ["test", "prod"], collecting: ["prod", "staging"] }];
    h.streams = pipeline;
    h.inbox = [row({ environment: "prod" })];
    await mount();
    expect(collectFromText()).toBe("staging, prod");
    expect(q("publisher-dashboard-streams")?.textContent).toBe("from staging, prod");
    expect(q("publisher-dashboard-collect-from")?.getAttribute("title")).toContain("Collecting from: staging, prod.");
  });

  it("every stream is 'all streams' in the strip, as the dropdown says it", async () => {
    h.regions = [{ ...OWN, collecting: null }];
    h.streams = { ...VIEW, mode: "all", collecting: null, summary: "All streams" };
    await mount();
    expect(collectFromText()).toBe("All streams");
    expect(q("publisher-dashboard-streams")?.textContent).toBe("from all streams");
  });

  it("inPipelineOrder: the development line, the given order, then any other name", () => {
    expect(inPipelineOrder(["prod", "test", ""], ["test", "prod"])).toEqual(["", "test", "prod"]);
    expect(inPipelineOrder(["zeta", "prod", "alpha"], ["prod"])).toEqual(["prod", "alpha", "zeta"]);
    expect(inPipelineOrder(["prod", "staging"], ["", "test", "staging", "prod"])).toEqual(["staging", "prod"]);
    expect(inPipelineOrder([], ["prod"])).toEqual([]);
  });

  // SABOTAGE: drop `presentation="dropdown"` -- the pane shows the hero again,
  // which outside the band is an icon + "Collect From" button.
  it("the pane never shows the ribbon hero", async () => {
    await mount();
    const trigger = q("publisher-dashboard-collect-from") as HTMLButtonElement;
    expect(trigger.getAttribute("data-presentation")).toBe("dropdown");
    expect(trigger.textContent).not.toContain("Collect From");
    // Only the chevron: no funnel icon to overlap the select.
    expect(trigger.querySelectorAll("svg")).toHaveLength(1);
    expect(container.querySelector("[data-hero-line]")).toBeNull();
  });

  it("a subscribed region has two rows (its stream is fixed: the strip says it)", async () => {
    h.regions = [{ ...OWN, role: "subscriber", collecting: ["test"] }];
    await mount();
    expect(headerRowNames()).toEqual(["region", "actions"]);
  });

  it("a workbook with no regions has no rows, only the sentence", async () => {
    h.regions = [];
    await mount();
    expect(headerRows()).toHaveLength(0);
    expect(q("publisher-dashboard-header")?.textContent).toBe(NO_REGIONS_TEXT);
  });

  it("exports are live only with answers to export; Refresh only for a readable region", async () => {
    await mount();
    expect((q("publisher-dashboard-refresh") as HTMLButtonElement).disabled).toBe(false);
    expect((q("publisher-dashboard-export-csv") as HTMLButtonElement).disabled).toBe(false);
    expect((q("publisher-dashboard-export-parquet") as HTMLButtonElement).disabled).toBe(false);
    const loads = h.loadRegionSubmissions.mock.calls.length;
    await act(async () => {
      (q("publisher-dashboard-refresh") as HTMLButtonElement).click();
    });
    await settle();
    expect(h.loadRegionSubmissions.mock.calls.length).toBe(loads + 1);
  });

  it("with no answers yet the exports are disabled", async () => {
    h.inbox = [];
    await mount();
    expect((q("publisher-dashboard-export-csv") as HTMLButtonElement).disabled).toBe(true);
    expect((q("publisher-dashboard-export-parquet") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the pane follows the skin: no colour literal, rendered or in source", () => {
  it("renders every state with tokens only", async () => {
    h.streams = { ...SEVERAL, notCollected: ["staging"] };
    h.regions = [{ ...OWN, collecting: ["", "prod"], note: "v1.1.0 could not be verified on this computer." }];
    h.inbox = [
      row({ submissionId: "s1", state: "submitted", environment: "prod" }),
      row({ submissionId: "s2", cellRow: 3, state: "approved", environment: "" }),
      row({ submissionId: "s3", cellRow: 4, state: "rejected", reviewReason: "out of range", counted: false }),
      row({ submissionId: "s4", cellRow: 5, state: "draft", valueDisplay: "" }),
      row({
        submissionId: "s5",
        cellRow: 6,
        sender: "signed",
        identity: { status: "notVerified", reason: "ownerMismatch", writtenBy: "CORP\\bob" },
        identityLabel: "Not verified: written by CORP\\bob",
        counted: false,
      }),
    ];
    h.regionResponseStatus.mockImplementation(async () => ({
      expected: ["CORP\\alice", "CORP\\carol"],
      responded: ["Alice"],
      missing: ["CORP\\carol"],
      beforeSignIn: [],
      notCounted: ["Bob"],
      requireVerified: true,
    }));
    await mount();
    // Every strip is on screen, so every tone is scanned.
    expect(q("publisher-dashboard-not-collected")).not.toBeNull();
    expect(q("publisher-dashboard-note")).not.toBeNull();
    expect(q("publisher-dashboard-rule")).not.toBeNull();
    expect(q("publisher-dashboard-roster-not-counted")).not.toBeNull();
    expect(q("publisher-dashboard-not-counted")).not.toBeNull();
    expect(q("publisher-dashboard-rollup")).not.toBeNull();
    expect(rows()).toHaveLength(5);
    expect(findHardcodedColours(container)).toEqual([]);
  });

  it("a region that cannot be read, and a failed list, are on tokens too", async () => {
    h.regions = [{ ...OWN, status: "notInPushedVersion", detail: "Push the application first." }];
    await mount();
    expect(findHardcodedColours(container)).toEqual([]);
    h.listCollectionRegions.mockReset().mockImplementation(async () => {
      throw new Error("the workspace share is offline");
    });
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount();
    expect(q("publisher-dashboard-regions-error")).not.toBeNull();
    expect(findHardcodedColours(container)).toEqual([]);
  });

  // SABOTAGE: put `color: "#888"` back on any style -- this source scan fails
  // (and so does `npm run lint:boundaries`, which now lists both files).
  it.each(["PublisherDashboardPane.tsx", "CollectFromMenuButton.tsx"])("%s carries no colour literal", (file) => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../components", file), "utf8");
    expect(src.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
    expect(src.match(/\b(?:rgba?|hsla?)\(/g)).toBeNull();
    expect(
      src.match(/["'`](?:red|blue|green|orange|yellow|purple|pink|brown|cyan|magenta|white|black|gray|grey|navy|teal|silver)["'`]/gi),
    ).toBeNull();
  });
});
