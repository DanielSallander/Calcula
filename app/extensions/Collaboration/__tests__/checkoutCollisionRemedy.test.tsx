//! FILENAME: app/extensions/Collaboration/__tests__/checkoutCollisionRemedy.test.tsx
// PURPOSE: A checkout refused because the application shares a macro, notebook
//          or name id with the open workbook (BUG-0264) OFFERS the remedy its
//          refusal names -- "check out into a new workbook" -- and that remedy
//          asks before it closes unsaved work, failing closed.
// CONTEXT: The refusal itself is Rust's (app/src-tauri/src/checkout_collisions.rs,
//          tested there). What can go wrong here is the half the user touches:
//          the button must appear for exactly that refusal, start the new
//          workbook BEFORE the checkout (a checkout into the old one is the
//          refusal again), and never discard unsaved changes on a Cancel -- the
//          confirm is doubled in the TAURI shape (a Promise), because a
//          synchronous boolean double is what let `!window.confirm(...)` pass
//          review for so long.

import fs from "fs";
import path from "path";
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

vi.mock("@api/dialogs", () => ({
  confirmAsync: (...a: unknown[]) => confirmAsync(...a),
}));

vi.mock("@api/collaborationWorkspaces", () => ({
  listWorkspaces: vi.fn(async () => []),
  isHttpWorkspace: () => false,
}));

vi.mock("../lib/pickWorkspace", () => ({ pickWorkspaceFile: vi.fn(async () => null) }));

import { CheckoutDialog } from "../components/CheckoutDialog";
import { UNSAVED_CHANGES_QUESTION } from "../lib/checkoutIntoNewWorkbook";

const APP: ApplicationInfo = {
  name: "sales",
  description: "",
  kind: "report",
  author: "Alice",
  versions: [{ version: "1.0.0", publishedAt: "2026-09-30T00:00:00Z", publishedBy: "Alice", sheets: [] }],
  environments: [],
};

const COLLISION =
  "CALP_CHECKOUT_COLLISION: 'sales' was not opened for editing. This workbook already has items " +
  "with the same identity as the application's own: macro 'My report' (id macro-report, yours); " +
  "name 'RATE' (yours). Opened here, the workbook's copy would be kept and the application's " +
  "dropped -- and your next push would publish the workbook's copy as part of 'sales'. Check the " +
  "application out into a new workbook instead (Open Application for Editing offers it), or " +
  "rename or remove them in this workbook first.";

function opened(): CheckoutResponse {
  return {
    packageName: "sales",
    version: "1.0.0",
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
  };
}

let container: HTMLDivElement;
let root: Root;

const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);

/** Mount pre-pointed at the application and press Open for Editing, which the
 *  backend refuses with `refusal`. */
async function refusedWith(refusal: string): Promise<void> {
  listApplicationsInWorkspace.mockResolvedValue([APP]);
  checkoutApplication.mockImplementationOnce(() => Promise.reject(refusal));
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
  const remedy = byTestId("checkout-new-workbook");
  expect(remedy, "the collision refusal offers no way out").toBeTruthy();
  await act(async () => {
    remedy!.click();
  });
  await act(async () => {});
}

beforeEach(() => {
  calls.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  for (const f of [listApplicationsInWorkspace, checkoutApplication, isModified, newWorkbook, confirmAsync]) {
    f.mockReset();
  }
  newWorkbook.mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("a collision refusal offers 'check out into a new workbook' (BUG-0264)", () => {
  // SABOTAGE: render the remedy block for every error, or for none.
  it("appears beside the collision refusal, and only there", async () => {
    await refusedWith(COLLISION);
    expect(container.textContent).toContain("macro 'My report' (id macro-report, yours)");
    expect(byTestId("checkout-collision-remedy")).toBeTruthy();

    act(() => root.unmount());
    root = createRoot(container);
    await refusedWith(
      "CALP_CHECKOUT_ALREADY_LINKED: This workbook is already a working copy of 'finance'.",
    );
    expect(byTestId("checkout-collision-remedy"), "offered for a refusal it does not fix").toBeNull();
  });

  // SABOTAGE: call checkoutApplication before workbook.new in
  // checkoutIntoNewWorkbook.
  it("starts the new workbook FIRST, then opens the application in it and shows the result", async () => {
    isModified.mockResolvedValue(false);
    await refusedWith(COLLISION);
    checkoutApplication.mockImplementationOnce(() => Promise.resolve(opened()));
    await pressRemedy();

    expect(confirmAsync, "nothing to lose, nothing to ask").not.toHaveBeenCalled();
    expect(calls).toEqual(["checkout", "new", "checkout"]);
    expect(checkoutApplication).toHaveBeenLastCalledWith({
      registryPath: "C:/ws",
      packageName: "sales",
      version: "1.0.0",
    });
    expect(byTestId("checkout-result"), "the opened application's signer panel").toBeTruthy();
    expect(container.textContent).not.toContain("CALP_CHECKOUT_COLLISION");
  });

  // SABOTAGE: drop the `if (!proceed) return null;` line (or test the
  // Promise without awaiting it).
  it("asks before closing unsaved work, and a Cancel changes nothing", async () => {
    isModified.mockResolvedValue(true);
    confirmAsync.mockReturnValue(Promise.resolve(false));
    await refusedWith(COLLISION);
    await pressRemedy();

    expect(confirmAsync).toHaveBeenCalledTimes(1);
    expect(confirmAsync.mock.calls[0][0]).toBe(UNSAVED_CHANGES_QUESTION);
    expect(UNSAVED_CHANGES_QUESTION).toMatch(/without saving/);
    expect(newWorkbook, "the open workbook was closed after the user said no").not.toHaveBeenCalled();
    expect(calls).toEqual(["checkout"]);
    expect(byTestId("checkout-collision-remedy"), "the refusal and its remedy stay").toBeTruthy();
    expect(byTestId("checkout-result")).toBeNull();
  });

  it("with the user's yes, closes the unsaved workbook and opens the application", async () => {
    isModified.mockResolvedValue(true);
    confirmAsync.mockReturnValue(Promise.resolve(true));
    await refusedWith(COLLISION);
    checkoutApplication.mockImplementationOnce(() => Promise.resolve(opened()));
    await pressRemedy();
    expect(calls).toEqual(["checkout", "new", "checkout"]);
    expect(byTestId("checkout-result")).toBeTruthy();
  });
});

describe("the audit viewer names every event the backend records", () => {
  // THE DRIFT this closes: `checked_out` had no label and fell through to
  // "other" as a raw id, and a new always-recorded row (`checkout_refused`)
  // would have done the same. Read from the Rust enum, snake_cased the way
  // serde spells it, so a new variant without a label turns this red.
  //
  // SABOTAGE: delete the `checkout_refused` row from EVENT_META.
  it("has a label for every AuditEvent variant", () => {
    const appRoot = path.resolve(__dirname, "../../..");
    const rust = fs.readFileSync(path.resolve(appRoot, "../core/calp/src/audit.rs"), "utf8");
    const body = rust.slice(rust.indexOf("pub enum AuditEvent {"));
    const enumBody = body.slice(0, body.indexOf("\n}"));
    const variants = [...enumBody.matchAll(/^\s{4}([A-Z][A-Za-z]+),/gm)].map((m) => m[1]);
    expect(variants, "the enum parse found nothing").toContain("CheckoutRefused");
    expect(variants.length).toBeGreaterThan(15);
    const pane = fs.readFileSync(path.resolve(__dirname, "../components/AuditLogPane.tsx"), "utf8");
    const snake = (v: string) => v.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
    for (const v of variants) {
      expect(pane, `${v} (${snake(v)}) has no label in the audit viewer`).toMatch(
        new RegExp(`\\n\\s+${snake(v)}: \\{\\s*label:`),
      );
    }
  });
});
