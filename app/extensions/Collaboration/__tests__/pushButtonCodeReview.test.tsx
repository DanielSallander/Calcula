//! FILENAME: app/extensions/Collaboration/__tests__/pushButtonCodeReview.test.tsx
// PURPOSE: The push dialog SHOWS the buttons' code a push carries and asks for
//          each piece the signed base does not have to be read and ticked
//          (BUG-0257); the checkout says how much button code it held.
// CONTEXT: The backend restores a working copy's held code only when the signed
//          base carries those bytes, refuses the push otherwise, and refuses
//          code the base lacks unless the request acknowledges it by hash
//          (app/src-tauri/src/held_button_code.rs). This is the surface that
//          makes those acknowledgements mean "I read it".

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ButtonCodeItem, ButtonCodeRelease, CheckoutResponse } from "@api";

import { ButtonCodeReview, unacknowledgedButtonCode } from "../components/ButtonCodeReview";
import { CheckoutSignerPanel } from "../components/CheckoutSignerPanel";
import { pushBlockingReason } from "../lib/pushReadiness";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const item = (cell: string, code: string, hash: string, extra: Partial<ButtonCodeItem> = {}): ButtonCodeItem => ({
  sheetId: "s",
  sheetName: "Dashboard",
  row: 1,
  col: 1,
  cell,
  slot: "onSelect",
  valueType: "static",
  code,
  hash,
  application: "",
  reason: "the signed v1.0.0 of 'sales' does not have this code here or on any other button",
  ...extra,
});

const release: ButtonCodeRelease = {
  restored: [item("Dashboard!C3", "Report();", "h-restored", { application: "sales", reason: "" })],
  refused: [item("Dashboard!B2", "Exfiltrate();", "h-refused", { application: "sales", reason: "it does not match" })],
  unreviewed: [
    item("Dashboard!D4", "Mine();", "h-mine"),
    item("Dashboard!E5", "macro-new", "h-macro", { slot: "macroRef" }),
  ],
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

describe("the push dialog's button code review", () => {
  // SABOTAGE: drop `<CodeText item={item} />` from the unreviewed rows.
  it("shows every piece of code the push would carry, with the code", async () => {
    await act(async () => {
      root.render(<ButtonCodeReview release={release} acknowledged={new Set()} onAcknowledge={() => undefined} />);
    });
    const refused = host.querySelector("[data-testid='push-button-code-refused']")!;
    expect(refused.textContent).toContain("This push will be refused");
    expect(refused.textContent).toContain("Dashboard!B2");
    expect(refused.textContent).toContain("Exfiltrate();");
    const unreviewed = host.querySelector("[data-testid='push-button-code-unreviewed']")!;
    expect(unreviewed.textContent).toContain("Mine();");
    expect(unreviewed.textContent).toContain("Runs the macro macro-new");
    expect(unreviewed.textContent).toMatch(/under YOUR key/);
    expect(host.querySelector("[data-testid='push-button-code-restored']")!.textContent).toMatch(
      /1 button code slot\(s\) of the application are\s+published unchanged/,
    );
  });

  it("each tick acknowledges exactly one piece, by hash", async () => {
    const onAcknowledge = vi.fn();
    await act(async () => {
      root.render(<ButtonCodeReview release={release} acknowledged={new Set(["h-macro"])} onAcknowledge={onAcknowledge} />);
    });
    const mine = host.querySelector<HTMLInputElement>("[data-button-code-ack='h-mine']")!;
    expect(mine.checked).toBe(false);
    expect(host.querySelector<HTMLInputElement>("[data-button-code-ack='h-macro']")!.checked).toBe(true);
    await act(async () => {
      mine.click();
    });
    expect(onAcknowledge).toHaveBeenCalledWith("h-mine", true);
  });

  it("renders nothing when the push carries no button code", async () => {
    await act(async () => {
      root.render(
        <ButtonCodeReview release={{ restored: [], refused: [], unreviewed: [] }} acknowledged={new Set()} onAcknowledge={() => undefined} />,
      );
    });
    expect(host.querySelector("[data-testid='push-button-code']")).toBeNull();
  });

  // SABOTAGE: make `unacknowledgedButtonCode` return 0.
  it("the Push button names unticked code and refused held code before it is pressed", () => {
    expect(unacknowledgedButtonCode(release, new Set(["h-macro"]))).toBe(1);
    expect(unacknowledgedButtonCode(release, new Set(["h-macro", "h-mine"]))).toBe(0);
    expect(unacknowledgedButtonCode(null, new Set())).toBe(0);
    const ready = {
      mode: "push" as const,
      registryPath: "C:/ws",
      packageName: "sales",
      version: "1.0.1",
      changeSummary: "Fix",
      pushed: false,
      sheetsSelected: 1,
      sheetsAvailable: 1,
      kind: "report",
      nameAlreadyTaken: false,
    };
    expect(pushBlockingReason(ready)).toBeNull();
    expect(pushBlockingReason({ ...ready, buttonCodeRefused: 1 })).toMatch(/push would be refused/);
    expect(pushBlockingReason({ ...ready, buttonCodeUnacknowledged: 2 })).toMatch(/Read and tick the 2/);
  });

  // A push that is NOT of the working copy's application (publish as new, a
  // scripted publish) leaves held code OUT, by name -- it used to refuse every
  // such push with a remedy that did not apply. Shown, never blocking.
  //
  // SABOTAGE: drop the `withheld` block from ButtonCodeReview.
  it("names the held code a push leaves out, with the code, without blocking it", async () => {
    const leftOut: ButtonCodeRelease = {
      restored: [],
      refused: [],
      unreviewed: [],
      withheld: [
        item("Dashboard!B2", "Report();", "h-held", {
          application: "sales",
          reason: "this is not a push of 'sales' from its working copy",
        }),
      ],
    };
    await act(async () => {
      root.render(<ButtonCodeReview release={leftOut} acknowledged={new Set()} onAcknowledge={() => undefined} />);
    });
    const withheld = host.querySelector("[data-testid='push-button-code-withheld']")!;
    expect(withheld.textContent).toContain("LEFT OUT of this");
    expect(withheld.textContent).toContain("Dashboard!B2");
    expect(withheld.textContent).toContain("Report();");
    expect(withheld.textContent).toContain("'sales'");
    expect(host.querySelector("[data-button-code-ack]"), "nothing to tick").toBeNull();
    expect(unacknowledgedButtonCode(leftOut, new Set())).toBe(0);
  });
});

describe("the checkout says how much button code it held", () => {
  const response = (overrides: Partial<CheckoutResponse>): CheckoutResponse => ({
    packageName: "sales",
    version: "1.0.0",
    sheetsMaterialized: 1,
    scriptsMaterialized: 0,
    publisherName: "Alice",
    trustStatus: "notPinned",
    cells: [],
    customObjects: [],
    firstSheetIndex: 1,
    signer: {
      name: "Alice",
      key: "ab".repeat(32),
      fingerprint: "abababababababab...",
      role: "root",
      listedAs: "",
      rootName: "Alice",
      rootFingerprint: "abababababababab...",
      isYourKey: false,
    },
    ...overrides,
  });

  it("names the held slots and the values the admission cleared", async () => {
    await act(async () => {
      root.render(<CheckoutSignerPanel result={response({ buttonCodeHeld: 2, oversizedValuesCleared: 1 })} />);
    });
    expect(host.querySelector("[data-testid='checkout-button-code-held']")!.textContent).toMatch(
      /2 button code slots came\s+with this application/,
    );
    expect(host.querySelector("[data-testid='checkout-oversized-cleared']")!.textContent).toMatch(/1 control value was cleared/);
  });

  it("says nothing when there was nothing to hold", async () => {
    await act(async () => {
      root.render(<CheckoutSignerPanel result={response({})} />);
    });
    expect(host.querySelector("[data-testid='checkout-button-code-held']")).toBeNull();
    expect(host.querySelector("[data-testid='checkout-oversized-cleared']")).toBeNull();
  });
});
