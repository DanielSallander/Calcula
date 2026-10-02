//! FILENAME: app/extensions/Collaboration/__tests__/checkoutSignerDisclosure.test.tsx
// PURPOSE: The Checkout dialog SHOWS who signed the version it opened — name,
//          key fingerprint, "your key", authority and trust status — instead of
//          closing and discarding the response (BUG-0262).
// CONTEXT: `handleCheckout` ended in `onClose(); void result;`. The trust status
//          the backend reported (a checkout is `VerifyOnly`, so first contact is
//          `notPinned`) went nowhere, and a developer edited — then re-signed
//          under their own key — a version whose signer they were never shown.
//
//          The backend now refuses an unauthorised signer outright (Rust tests:
//          core/calp/src/checkout.rs, app/src-tauri/src/calp_signer_trust_tests.rs),
//          so this surface is disclosure, not a gate. Two things about it are
//          pinned because they are easy to get subtly wrong:
//            * "your key" is display only, and says so;
//            * the trust status is a TABLE with a row for every state Rust can
//              emit, read out of the one Rust map, never a ternary.

import fs from "fs";
import path from "path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ApplicationInfo, CheckoutResponse } from "@api";

const listApplicationsInWorkspace = vi.fn();
const checkoutApplication = vi.fn();

vi.mock("@api", () => ({
  listApplicationsInWorkspace: (...a: unknown[]) => listApplicationsInWorkspace(...a),
  checkoutApplication: (...a: unknown[]) => checkoutApplication(...a),
}));

vi.mock("@api/collaborationWorkspaces", () => ({
  listWorkspaces: vi.fn(async () => []),
  isHttpWorkspace: () => false,
}));

vi.mock("../lib/pickWorkspace", () => ({ pickWorkspaceFile: vi.fn(async () => null) }));

import { CheckoutDialog } from "../components/CheckoutDialog";
import { ANCHORED_BY, CHECKOUT_ANCHOR, CHECKOUT_TRUST } from "../components/CheckoutSignerPanel";

const ALICE_KEY = "a1b2c3d4e5f6a7b8".repeat(4);
const BOB_KEY = "0f1e2d3c4b5a6978".repeat(4);

const APP: ApplicationInfo = {
  name: "sales",
  description: "",
  kind: "report",
  author: "Alice",
  versions: [{ version: "1.0.0", publishedAt: "2026-09-29T00:00:00Z", publishedBy: "Alice", sheets: [] }],
  environments: [],
};

function response(overrides: Partial<CheckoutResponse> = {}): CheckoutResponse {
  return {
    packageName: "sales",
    version: "1.0.0",
    sheetsMaterialized: 2,
    scriptsMaterialized: 1,
    publisherName: "Alice",
    trustStatus: "notPinned",
    cells: [],
    customObjects: [],
    firstSheetIndex: 1,
    signer: {
      name: "Alice",
      key: ALICE_KEY,
      fingerprint: "a1b2c3d4e5f6a7b8...",
      role: "root",
      listedAs: "",
      rootName: "Alice",
      rootFingerprint: "a1b2c3d4e5f6a7b8...",
      isYourKey: true,
      anchor: {
        status: "firstContact",
        anchoredAt: "2026-09-30T10:00:00Z",
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

/** Mount pre-pointed at a workspace + application (the Publish dialog's route
 *  in), let the listing land, and press Open for Editing. */
async function openFor(result: () => Promise<CheckoutResponse>, onClose: () => void): Promise<void> {
  listApplicationsInWorkspace.mockResolvedValue([APP]);
  // Lazily, so a refusal is created only when the dialog awaits it.
  checkoutApplication.mockImplementation(() => result());
  await act(async () => {
    root.render(
      <CheckoutDialog isOpen onClose={onClose} data={{ registryPath: "C:/ws", packageName: "sales" }} />,
    );
  });
  await act(async () => {});
  const open = button("Open for Editing");
  expect(open, "the Open for Editing button moved or was renamed").toBeTruthy();
  expect(open!.disabled, "the dialog did not select the pre-pointed application").toBe(false);
  await act(async () => {
    open!.click();
  });
  await act(async () => {});
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  listApplicationsInWorkspace.mockReset();
  checkoutApplication.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Checkout shows who signed the version it opened (BUG-0262)", () => {
  // SABOTAGE: put `onClose(); void result;` back in handleCheckout.
  it("stays open on the result and names the signer, fingerprint, your key and trust", async () => {
    const onClose = vi.fn();
    await openFor(() => Promise.resolve(response()), onClose);

    expect(checkoutApplication).toHaveBeenCalledWith({
      registryPath: "C:/ws",
      packageName: "sales",
      version: "1.0.0",
    });
    expect(onClose, "the dialog closed and discarded the result").not.toHaveBeenCalled();
    expect(byTestId("checkout-result"), "no result panel").toBeTruthy();
    expect(byTestId("checkout-signer-name")!.textContent).toBe("Alice");
    const fp = byTestId("checkout-signer-fingerprint")!;
    expect(fp.textContent).toBe("a1b2c3d4e5f6a7b8...");
    expect(fp.title, "the full key is one hover away").toBe(ALICE_KEY);
    expect(byTestId("checkout-signer-yours")?.textContent).toBe("your key");
    expect(byTestId("checkout-signer-authority")!.textContent).toMatch(
      /the publisher who created this application/,
    );
    expect(byTestId("checkout-trust-label")!.textContent).toBe(CHECKOUT_TRUST.notPinned.label);
    expect(byTestId("checkout-trust-label")!.textContent).toMatch(/not trusted/i);

    // Leaving is the user's act, after they have seen it.
    const done = button("Done");
    expect(done, "no way out of the result").toBeTruthy();
    await act(async () => {
      done!.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("says what 'your key' does NOT mean", async () => {
    await openFor(() => Promise.resolve(response()), vi.fn());
    const signer = byTestId("checkout-signer")!.textContent ?? "";
    // Signed by you is not written by you after a merge or a co-publisher's push.
    expect(signer).toMatch(/not who wrote every change in it/);
  });

  it("names a co-publisher by the root that listed them, and claims no 'your key'", async () => {
    await openFor(
      () =>
        Promise.resolve(
          response({
            trustStatus: "trustedDelegate",
            signer: {
              name: "bob-laptop",
              key: BOB_KEY,
              fingerprint: "0f1e2d3c4b5a6978...",
              role: "coPublisher",
              listedAs: "Bob",
              rootName: "Alice",
              rootFingerprint: "a1b2c3d4e5f6a7b8...",
              isYourKey: false,
              anchor: {
                status: "matches",
                anchoredAt: "2026-09-01T08:00:00Z",
                anchoredBy: "publish",
                publishersRevision: 3,
              },
            },
          }),
        ),
      vi.fn(),
    );
    expect(byTestId("checkout-signer-name")!.textContent).toBe("bob-laptop");
    expect(byTestId("checkout-signer-yours"), "not this computer's key").toBeNull();
    const authority = byTestId("checkout-signer-authority")!.textContent ?? "";
    expect(authority).toContain('Alice (key a1b2c3d4e5f6a7b8...)');
    expect(authority).toContain('"Bob"');
    expect(byTestId("checkout-trust-label")!.textContent).toBe(CHECKOUT_TRUST.trustedDelegate.label);
  });

  it("keeps the form and shows the backend's refusal when the signer is not authorised", async () => {
    const onClose = vi.fn();
    const refusal =
      "sales@1.1.0 is signed by mallory (key 99aa88bb77cc66dd...), who is not an authorised " +
      "publisher of 'sales'.";
    await openFor(() => Promise.reject(refusal), onClose);
    expect(onClose).not.toHaveBeenCalled();
    expect(byTestId("checkout-result"), "a refused checkout must not show a result").toBeNull();
    expect(container.textContent).toContain("mallory (key 99aa88bb77cc66dd...)");
    expect(button("Open for Editing"), "the form is still there to try again").toBeTruthy();
  });
});

describe("what this computer remembers about the creator (the developer anchor)", () => {
  // SABOTAGE: drop the anchor box from CheckoutSignerPanel, or map both states
  // to one line.
  it("says the creator is remembered from now on, at first contact", async () => {
    await openFor(() => Promise.resolve(response()), vi.fn());
    const line = byTestId("checkout-anchor-line")!.textContent ?? "";
    expect(line).toMatch(/^First time on this computer/);
    expect(line, "the key that is remembered is named").toContain("a1b2c3d4e5f6a7b8...");
    expect(line).toMatch(/a checkout naming a different creator will be refused/);
  });

  it("says when and how it was remembered, when it matches", async () => {
    await openFor(
      () =>
        Promise.resolve(
          response({
            signer: {
              ...response().signer,
              anchor: {
                status: "matches",
                anchoredAt: "2026-09-01T08:00:00Z",
                anchoredBy: "publish",
                publishersRevision: 3,
              },
            },
          }),
        ),
      vi.fn(),
    );
    const line = byTestId("checkout-anchor-line")!.textContent ?? "";
    expect(line).toBe(
      "Matches the creator this computer first saw on 2026-09-01 " +
        `(${ANCHORED_BY.publish}).`,
    );
  });

  const APP_ROOT = path.resolve(__dirname, "../../..");
  const CMDS_RS = fs.readFileSync(path.join(APP_ROOT, "src-tauri/src/calp_commands.rs"), "utf8");
  const ANCHOR_RS = fs.readFileSync(
    path.join(APP_ROOT, "../core/calp/src/developer_anchor.rs"),
    "utf8",
  );

  // THE DRIFT this closes: a new anchor state (or a new way of recording one)
  // reaching the panel with no row, and rendering as the fallback.
  it("has a row for every anchor status and every anchoredBy Rust can emit", () => {
    const fromStatus = CMDS_RS.match(/pub\(crate\) fn from_status\([\s\S]*?\n {4}\}\n/);
    expect(fromStatus, "CheckoutAnchorInfo::from_status moved or was renamed").toBeTruthy();
    const statuses = [...fromStatus![0].matchAll(/status: "(\w+)"\.to_string\(\)/g)].map((m) => m[1]);
    expect(statuses).toEqual(["firstContact", "matches", "notAnchored"]);
    for (const s of statuses) {
      expect(Object.keys(CHECKOUT_ANCHOR), `anchor status "${s}" has no row`).toContain(s);
    }
    const asStr = ANCHOR_RS.match(/impl AnchoredBy \{[\s\S]*?\n\}/);
    expect(asStr, "AnchoredBy::as_str moved or was renamed").toBeTruthy();
    const via = [...asStr![0].matchAll(/AnchoredBy::\w+ => "(\w+)"/g)].map((m) => m[1]);
    expect(via.length).toBe(3);
    for (const v of via) {
      expect(Object.keys(ANCHORED_BY), `anchoredBy "${v}" has no row`).toContain(v);
    }
  });
});

describe("the checkout trust table", () => {
  const APP_ROOT = path.resolve(__dirname, "../../..");
  const INSPECTOR_RS = fs.readFileSync(path.join(APP_ROOT, "src-tauri/src/calp_inspector.rs"), "utf8");
  const statuses = (() => {
    const fn = INSPECTOR_RS.match(/fn trust_status_str\(trust: TrustStatus\) -> String \{[\s\S]*?\n\}/);
    expect(fn, "trust_status_str moved or was renamed").toBeTruthy();
    return [...fn![0].matchAll(/TrustStatus::\w+ => "([^"]+)"/g)].map((m) => m[1]);
  })();

  it("has a row for every status Rust can emit", () => {
    expect(statuses.length).toBeGreaterThan(0);
    for (const status of statuses) {
      expect(
        Object.keys(CHECKOUT_TRUST),
        `trustStatus "${status}" has no row in CHECKOUT_TRUST — it would render with the fallback`,
      ).toContain(status);
    }
  });

  it("never calls an unpinned or conflicting state trusted", () => {
    expect(CHECKOUT_TRUST.notPinned.label).toMatch(/not trusted/i);
    expect(CHECKOUT_TRUST.notPinned.color).not.toBe(CHECKOUT_TRUST.verified.color);
    expect(CHECKOUT_TRUST.notPinnedNameConflict.label).toMatch(/NAME CONFLICT/);
    expect(CHECKOUT_TRUST.notPinnedNameConflict.color).toBe("#c5221f");
  });

  it("the dialog no longer discards the result", () => {
    const dialog = fs.readFileSync(
      path.join(APP_ROOT, "extensions/Collaboration/components/CheckoutDialog.tsx"),
      "utf8",
    );
    const code = dialog.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/void result;/);
    expect(code).toMatch(/setOpened\(result\)/);
  });
});
