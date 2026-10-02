//! FILENAME: app/extensions/Collaboration/__tests__/checkoutPrivateSheets.test.tsx
// PURPOSE: Phase 3 of BUG-0257, the working-copy private-sheet rule as the
//          developer meets it. A checkout into a workbook that also holds sheets
//          of their own succeeds -- but the Rust run gate then keeps the
//          application's macros and object scripts from running there, because
//          what they write into the application's sheets goes out with the next
//          push. The Checkout dialog SAYS so where the developer lands (naming
//          the sheets, the list Rust computed), not first as a refused click,
//          and offers the remedy the refusal names: open the application for
//          editing in a new workbook. That remedy replaces the open workbook, so
//          it asks first and FAILS CLOSED -- the confirm is doubled in the Tauri
//          shape (a Promise).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ApplicationInfo, CheckoutResponse } from "@api";

const calls: string[] = [];
const listApplicationsInWorkspace = vi.fn();
const checkoutApplication = vi.fn();
const isModified = vi.fn();
const newWorkbook = vi.fn();
const confirmAsync = vi.fn();

vi.mock("@api", () => ({
  listApplicationsInWorkspace: (...a: unknown[]) => listApplicationsInWorkspace(...a),
  checkoutApplication: (...a: unknown[]) => {
    calls.push("checkout");
    return checkoutApplication(...a);
  },
}));
vi.mock("@api/system", () => ({
  workbook: {
    isModified: () => isModified(),
    new: () => {
      calls.push("new");
      return newWorkbook();
    },
  },
}));
vi.mock("@api/dialogs", () => ({ confirmAsync: (...a: unknown[]) => confirmAsync(...a) }));
vi.mock("@api/collaborationWorkspaces", () => ({
  listWorkspaces: vi.fn(async () => []),
  isHttpWorkspace: () => false,
}));
vi.mock("../lib/pickWorkspace", () => ({ pickWorkspaceFile: vi.fn(async () => null) }));

import { CheckoutDialog } from "../components/CheckoutDialog";
import { describePrivateSheets } from "../components/CheckoutSignerPanel";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const APP: ApplicationInfo = {
  name: "sales",
  description: "",
  kind: "report",
  author: "Alice",
  versions: [
    { version: "1.0.0", publishedAt: "2026-09-29T00:00:00Z", publishedBy: "Alice", sheets: [] },
    { version: "1.1.0", publishedAt: "2026-09-30T00:00:00Z", publishedBy: "Alice", sheets: [] },
  ],
  environments: [],
};

function opened(overrides: Partial<CheckoutResponse> = {}): CheckoutResponse {
  return {
    packageName: "sales",
    version: "1.1.0",
    sheetsMaterialized: 1,
    scriptsMaterialized: 1,
    publisherName: "Alice",
    trustStatus: "notPinned",
    cells: [],
    customObjects: [],
    firstSheetIndex: 0,
    signer: {
      name: "Alice",
      key: "a1".repeat(32),
      fingerprint: "a1a1a1a1a1a1a1a1...",
      role: "root",
      listedAs: "",
      rootName: "Alice",
      rootFingerprint: "a1a1a1a1a1a1a1a1...",
      isYourKey: true,
      anchor: {
        status: "firstContact",
        anchoredAt: "2026-09-30T00:00:00Z",
        anchoredBy: "checkout",
        publishersRevision: 0,
      },
    },
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);

/** Mount pre-pointed at the application and open it; the backend answers `first`. */
async function checkedOut(first: CheckoutResponse): Promise<void> {
  listApplicationsInWorkspace.mockResolvedValue([APP]);
  checkoutApplication.mockImplementationOnce(() => Promise.resolve(first));
  await act(async () => {
    root.render(<CheckoutDialog isOpen onClose={vi.fn()} data={{ registryPath: "C:/ws", packageName: "sales" }} />);
  });
  await act(async () => {});
  await act(async () => {
    button("Open for Editing")!.click();
  });
  await act(async () => {});
}

async function pressRemedy(): Promise<void> {
  const remedy = byTestId("checkout-private-sheets-new-workbook");
  expect(remedy, "the private-sheet notice offers no way out").toBeTruthy();
  await act(async () => {
    remedy!.click();
  });
  await act(async () => {});
}

beforeEach(() => {
  calls.length = 0;
  listApplicationsInWorkspace.mockReset();
  checkoutApplication.mockReset();
  isModified.mockReset().mockResolvedValue(true);
  newWorkbook.mockReset().mockResolvedValue(undefined);
  confirmAsync.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe("the private-sheet notice", () => {
  it("names the sheets (three, then a count) and why the application's code will not run", () => {
    const text = describePrivateSheets(["Budget", "Notes", "Scratch", "Q4", "Old"]);
    expect(text).toContain("5 of your own sheets (Budget, Notes, Scratch, +2 more) sit beside the application");
    expect(text).toContain("its macros and object scripts will not run here");
    expect(text).toContain("goes out with your next push");
    expect(describePrivateSheets(["Budget"])).toMatch(/^1 of your own sheet \(Budget\) sits beside/);
    expect(describePrivateSheets([])).toBe("");
  });

  // SABOTAGE: remove the `privateSheets.length > 0 &&` block from CheckoutSignerPanel.
  it("is shown after a checkout that left private sheets beside the application", async () => {
    await checkedOut(opened({ privateSheets: ["Budget", "Notes"] }));
    const notice = byTestId("checkout-private-sheets");
    expect(notice, "the developer learns of the rule only from a refused click").toBeTruthy();
    expect(notice!.textContent).toContain("(Budget, Notes)");
  });

  it("is absent when no sheet of the developer's sits beside the application", async () => {
    await checkedOut(opened({ privateSheets: [] }));
    expect(byTestId("checkout-result")).toBeTruthy();
    expect(byTestId("checkout-private-sheets")).toBeNull();
  });
});

describe("the remedy: open the SAME version in a new workbook", () => {
  // SABOTAGE: in checkoutIntoNewWorkbook, test `if (proceed)` instead of
  // `if (!proceed) return null;` -> a No discards the workbook.
  it("a No (the Tauri-shaped Promise<false>) leaves the workbook and the working copy as they are", async () => {
    await checkedOut(opened({ privateSheets: ["Budget"] }));
    confirmAsync.mockReturnValue(Promise.resolve(false));
    await pressRemedy();
    expect(confirmAsync).toHaveBeenCalledTimes(1);
    expect(calls, "a No must not start a new workbook").toEqual(["checkout"]);
    expect(byTestId("checkout-private-sheets")).toBeTruthy();
  });

  // SABOTAGE: drop `onOpenInNewWorkbook=` from the CheckoutSignerPanel in
  // CheckoutDialog -> the button is never offered.
  it("a Yes starts a new workbook FIRST, then opens the same version there", async () => {
    await checkedOut(opened({ privateSheets: ["Budget"] }));
    confirmAsync.mockReturnValue(Promise.resolve(true));
    checkoutApplication.mockImplementationOnce(() => Promise.resolve(opened({ privateSheets: [] })));
    await pressRemedy();
    expect(calls).toEqual(["checkout", "new", "checkout"]);
    expect(checkoutApplication.mock.calls[1][0]).toEqual({
      registryPath: "C:/ws",
      packageName: "sales",
      version: "1.1.0",
    });
    // The dialog now shows the new working copy: nothing sits beside it.
    expect(byTestId("checkout-result")).toBeTruthy();
    expect(byTestId("checkout-private-sheets")).toBeNull();
  });
});
