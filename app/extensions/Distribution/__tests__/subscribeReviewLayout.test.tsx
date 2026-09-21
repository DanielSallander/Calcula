//! FILENAME: app/extensions/Distribution/__tests__/subscribeReviewLayout.test.tsx
// PURPOSE: The pre-pull review must show the executable-code group as ONE
//          block, beside the contents rather than below them.
// CONTEXT: Rendering module scripts and notebooks at all was the first half of
//          the fix (subscribeReviewDisclosure.test.ts pins that half). The
//          second half is that three amber cards stacked down a 460px column
//          span ~430px of scroll, against a body of ~525px on a 1366x768
//          laptop — so the Notebooks card sat entirely below the fold and the
//          screen still read as "Scripts (2), that is the code".
//
//          The layout that fixes it is specific, which is why it is pinned:
//          DialogFieldGrid uses `auto-fit`, so handing it the six review
//          sections FLAT would flow them row-major into as many tracks as fit —
//          Sheets | Scripts | Module scripts / Notebooks | Data sources |
//          Inventory — splitting the code group across two rows and three
//          columns, the exact opposite of the intent. The grid therefore takes
//          EXACTLY TWO children, each an explicit column stack, and the three
//          amber cards are siblings inside one of them.
//
//          jsdom performs no grid layout, so this asserts the DOM SHAPE that
//          the CSS depends on — which is the part a refactor breaks.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ApplicationInspection } from "@api/distribution";

const inspectApplication = vi.fn();

vi.mock("@api/distribution", () => ({
  inspectApplication: (...a: unknown[]) => inspectApplication(...a),
  listApplicationsInWorkspace: vi.fn(async () => []),
}));

vi.mock("@api", () => ({
  subscribeToApplication: vi.fn(),
  emitAppEvent: vi.fn(),
  AppEvents: { SHEET_CHANGED: "app:sheet-changed", PACKAGE_UPDATED: "app:package-updated" },
  getSheets: vi.fn(async () => ({ sheets: [] })),
  setActiveSheetApi: vi.fn(),
}));

vi.mock("@api/distributionWorkspaces", () => ({
  listWorkspaces: vi.fn(async () => []),
  addWorkspace: vi.fn(async () => []),
  isHttpWorkspace: () => false,
}));

vi.mock("@api/pivot", () => ({
  pivot: { getAll: vi.fn(async () => []), refreshCache: vi.fn() },
}));

vi.mock("@api/dialogs", () => ({ promptAsync: vi.fn(async () => null) }));

vi.mock("../lib/pickWorkspace", () => ({ pickWorkspaceFile: vi.fn(async () => null) }));

vi.mock("../lib/openApplicationInspectorWindow", () => ({
  openApplicationInspectorWindow: vi.fn(),
}));

vi.mock("../../_shared/lib/bi-api", () => ({
  getConnections: vi.fn(async () => []),
  connect: vi.fn(),
  updateConnection: vi.fn(),
}));

vi.mock("../../_shared/components/ConnectSourceDialog", () => ({
  ConnectSourceDialog: () => null,
}));

import { SubscribeDialog } from "../components/SubscribeDialog";

/** A report with code AND contents — the ordinary distributed-report shape. */
function inspection(overrides: Partial<ApplicationInspection> = {}): ApplicationInspection {
  return {
    packageName: "sales-report",
    resolvedVersion: "1.2.0",
    sheets: [
      { name: "Summary", description: "" },
      { name: "Detail", description: "by region" },
    ],
    scripts: [
      { name: "Refresh button", objectType: "button", description: null, requestedCapabilities: ["grid.read"] },
    ],
    moduleScripts: [
      { id: "mod-1", name: "Helpers", scope: "workbook", description: null },
    ],
    notebooks: [{ name: "Monthly close", cellCount: 7 }],
    dataSources: [
      { name: "Warehouse", connectionType: "postgres", server: "db", database: "sales" },
    ],
    writebackRegionCount: 1,
    tableCount: 1,
    namedRangeCount: 0,
    tableNames: ["Orders"],
    namedRangeNames: [],
    chartCount: 2,
    sparklineCount: 0,
    pivotCount: 1,
    controlSheetCount: 0,
    paneControlCount: 0,
    paneControlNames: [],
    slicerCount: 0,
    ribbonFilterCount: 0,
    pivotLayoutCount: 0,
    hasDocumentTheme: false,
    extensionDataCount: 0,
    extensionDataKeys: [],
    commentSheetCount: 0,
    publisherName: "Contoso Finance",
    publisherKey: "a".repeat(64),
    otherScopePins: [],
    trustStatus: "notPinned",
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

/** Mount the dialog and drive it to the REVIEW step. */
async function openReview(data: ApplicationInspection): Promise<void> {
  inspectApplication.mockResolvedValue(data);
  await act(async () => {
    root.render(<SubscribeDialog isOpen onClose={() => {}} />);
  });
  const review = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === "Review Contents...",
  );
  expect(review, "the Review Contents... button moved or was renamed").toBeTruthy();
  await act(async () => {
    review!.click();
  });
}

const codeColumn = () =>
  container.querySelector<HTMLElement>('[data-testid="subscribe-review-code"]');
const contentsColumn = () =>
  container.querySelector<HTMLElement>('[data-testid="subscribe-review-contents"]');

/** The heading text of each card that is a DIRECT child of an element. */
const childHeadings = (el: HTMLElement): string[] =>
  [...el.children].map((c) => c.querySelector("strong")?.textContent ?? "");

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  inspectApplication.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Subscribe review lays the contents out in two columns", () => {
  it("gives the grid exactly two children, and they are the two columns", async () => {
    await openReview(inspection());

    const code = codeColumn();
    const contents = contentsColumn();
    expect(code, "no code column").toBeTruthy();
    expect(contents, "no contents column").toBeTruthy();

    // Same parent, and that parent is the grid itself.
    const grid = code!.parentElement!;
    expect(contents!.parentElement).toBe(grid);
    expect(grid.style.display).toBe("grid");

    // THE ASSERTION THAT CATCHES THE FLAT VERSION. Six sections handed to the
    // grid directly would be six children, and `auto-fit` would flow them
    // row-major into three tracks.
    expect(grid.children.length).toBe(2);

    // Each child must be a real STACK. A wrapper that lays its cards out any
    // other way — `display: contents` most of all — is the flat version
    // wearing a test hook: the DOM shape passes and the layout is unchanged.
    expect(code!.style.display).toBe("flex");
    expect(code!.style.flexDirection).toBe("column");
    expect(contents!.style.display).toBe("flex");
    expect(contents!.style.flexDirection).toBe("column");
  });

  it("keeps Scripts, Module scripts and Notebooks as siblings in ONE column", async () => {
    await openReview(inspection());

    const headings = childHeadings(codeColumn()!);
    expect(headings).toEqual(["Scripts (1)", "Module scripts (1)", "Notebooks (1)"]);

    // ...and the code group is not mixed in with what the report IS.
    const contents = contentsColumn()!.textContent ?? "";
    expect(contents).toContain("Sheets (2)");
    expect(contents).toContain("Data sources (1)");
    expect(contents).not.toContain("Notebooks (");
  });

  it("puts the code column FIRST, where the reader starts", async () => {
    await openReview(inspection());
    const grid = codeColumn()!.parentElement!;
    expect(grid.children[0]).toBe(codeColumn());
    expect(grid.children[1]).toBe(contentsColumn());
  });

  it("leaves no stranded gutter for an application with no code at all", async () => {
    await openReview(inspection({ scripts: [], moduleScripts: [], notebooks: [] }));

    expect(codeColumn()).toBeNull();
    const contents = contentsColumn();
    expect(contents).toBeTruthy();
    // One child, not an empty div holding a column open.
    expect(contents!.parentElement!.children.length).toBe(1);
  });

  it("still shows WHO signed it above the columns, full width", async () => {
    await openReview(inspection());

    const grid = codeColumn()!.parentElement!;
    const banner = grid.previousElementSibling as HTMLElement | null;
    expect(banner, "the trust banner is no longer the sibling above the grid").toBeTruthy();
    expect(banner!.textContent).toContain("Contoso Finance");
    expect(banner!.textContent).toContain("not yet trusted on this computer");
    // Not a grid child — it must span the whole width, before anything else.
    expect(banner!.parentElement).toBe(grid.parentElement);
  });
});
