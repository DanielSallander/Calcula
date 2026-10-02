//! FILENAME: app/extensions/Collaboration/__tests__/buttonCellActionsDisclosure.test.tsx
// PURPOSE: BUG-0260, the disclosure half. Whatever the admission did to an
//          application's button CELLS is said where the subscribe, refresh,
//          checkout and push report their results -- and the Subscribe
//          dialog's review no longer promises that every button arrives
//          disarmed.
// CONTEXT: Rust keeps a button cell's action only when it names a macro the
//          pull applied for the application; every other action is removed
//          (subscribe, refresh) or held (checkout), and the backend returns one
//          sentence per action (app/src-tauri/src/button_cells.rs). A button
//          that silently does nothing -- or a push that silently republishes
//          it -- is the failure being closed.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import fs from "node:fs";
import path from "node:path";
import { createRoot, type Root } from "react-dom/client";
import type { ButtonCodeItem, CheckoutResponse } from "@api";

import {
  ButtonActionsNotice,
  ButtonLinksNotice,
  InlineButtonCodeNotice,
  describeButtonActions,
  describeButtonLinksHeld,
  describeInlineButtonCodeHeld,
  describeInlineButtonCodeRemoved,
} from "../components/ButtonActionsNotice";
import { ButtonCodeReview, describeCellAction } from "../components/ButtonCodeReview";
import { CheckoutSignerPanel } from "../components/CheckoutSignerPanel";
import { ObjectsSection } from "../components/inspector/ObjectsSection";
import type { InspectorOverview } from "@api/collaboration";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const APP_ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(APP_ROOT, rel), "utf8");

/** Comments stripped, whitespace collapsed: the prose a user can read. */
function prose(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/\s+/g, " ");
}

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

const REMOVED = [
  "Dashboard!C3: runs the macro 'macro-report', which the application 'sales' did not bring into this workbook -- a button from an application runs only that application's own macros, never one of yours or another application's with the same id",
  // Rust's notice since plan_M8 S1 (button_cells.rs `Disallowed::Command`).
  "Dashboard!D4: runs the command 'format.bold', which is not on Calcula's list of commands a button from an application may run",
];

describe("the notice that lists the button-cell actions a door did not keep", () => {
  it("names every removed action, cell first", async () => {
    await act(async () => {
      root.render(<ButtonActionsNotice actions={REMOVED} mode="removed" testId="n" />);
    });
    const notice = host.querySelector("[data-testid='n']")!;
    expect(notice.textContent).toContain("2 button cells came with actions this workbook will not run");
    expect(notice.textContent).toContain("Dashboard!C3: runs the macro 'macro-report'");
    expect(notice.textContent).toContain("Dashboard!D4: runs the command 'format.bold'");
    // The heading states the rule the list now decides (plan_M8 S2), never
    // "never a command".
    expect(notice.textContent).toContain("a command only when it is on Calcula's list of commands such buttons may run");
    expect(notice.textContent).not.toContain("never a command");
  });

  it("says a held action does not run and is published unchanged", () => {
    expect(describeButtonActions(1, "held")).toMatch(/It does not run in this working copy; your next push publishes it unchanged/);
  });

  it("says nothing when every action was kept", async () => {
    await act(async () => {
      root.render(<ButtonActionsNotice actions={[]} mode="removed" testId="n" />);
    });
    expect(host.querySelector("[data-testid='n']")).toBeNull();
  });
});

describe("the checkout lists the button-cell actions it held", () => {
  // SABOTAGE: drop the ButtonActionsNotice from CheckoutSignerPanel.
  it("shows each held action", async () => {
    const response: CheckoutResponse = {
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
      buttonActionsHeld: [REMOVED[0]],
    };
    await act(async () => {
      root.render(<CheckoutSignerPanel result={response} />);
    });
    const held = host.querySelector("[data-testid='checkout-button-actions-held']")!;
    expect(held.textContent).toContain("Dashboard!C3");
    expect(held.textContent).toContain("does not run in this working copy");
  });
});

describe("the push dialog names a button cell's held action", () => {
  const cellItem: ButtonCodeItem = {
    sheetId: "s",
    sheetName: "Dashboard",
    row: 2,
    col: 2,
    cell: "Dashboard!C3",
    slot: "action",
    valueType: "cellButtonAction",
    code: '{"functionName":"Exfiltrate","kind":"script","scriptId":"macro-steal"}',
    hash: "h",
    application: "sales",
    reason: "it does not match any button code in the signed v1.0.0 of 'sales'",
  };

  it("in words, not as JSON", async () => {
    expect(describeCellAction(cellItem.code)).toBe("Runs the macro macro-steal and calls Exfiltrate()");
    expect(describeCellAction('{"commandId":"format.bold","kind":"command"}')).toBe("Runs the command format.bold");
    await act(async () => {
      root.render(
        <ButtonCodeReview
          release={{ restored: [], refused: [cellItem], unreviewed: [] }}
          acknowledged={new Set()}
          onAcknowledge={() => undefined}
        />,
      );
    });
    const refused = host.querySelector("[data-testid='push-button-code-refused']")!;
    expect(refused.textContent).toContain("Dashboard!C3 (button cell action)");
    expect(refused.textContent).toContain("Runs the macro macro-steal and calls Exfiltrate()");
  });
});

describe("the Subscribe dialog tells the truth about buttons", () => {
  const src = read("extensions/Collaboration/components/SubscribeDialog.tsx");
  const text = prose(src);

  it("no longer claims every button arrives disarmed", () => {
    expect(text).not.toContain("arrive with their click actions disarmed");
    // Positive control for the stripper: the comment that explains the change
    // still quotes the old claim.
    expect(src).toContain('button "arrives with its click actions disarmed"');
  });

  // Phase 3 of BUG-0257: a button CONTROL's link to the application's own macro
  // is no longer removed -- it is kept like a button cell's action, and runs
  // after approval. Phase 4: its inline code is no longer removed either -- it
  // arrives held and runs after the approval screen has shown it.
  //
  // SABOTAGE: put back "A button control's own code is removed on the way in."
  it("says what a button control and a button cell each keep", () => {
    expect(text).not.toContain("macro link are removed on the way in");
    expect(text, "the review still says a button's own code is removed").not.toContain(
      "control&apos;s own code is removed on the way in.",
    );
    expect(text).toContain(
      "A button control&apos;s own code arrives held and runs only after you approve it; the " +
        "approval screen shows that code with every place it sits.",
    );
    expect(text).toContain(
      "A button control keeps its link, and a button cell its action, only when it runs one " +
        "of this application&apos;s own macros, which run only once you approve the " +
        "application&apos;s code.",
    );
    expect(text).toContain("other button action, link or code is removed and listed after you subscribe.");
  });

  it("and shows the removed lists after the pull, and counts the kept links and the held code", () => {
    expect(src).toContain("result.buttonActionsRemoved ?? []");
    expect(src).toContain('testId="subscribe-button-actions-removed"');
    expect(src).toContain("result.buttonLinksRemoved ?? []");
    expect(src).toContain('testId="subscribe-button-links-removed"');
    expect(src).toContain("describeButtonLinksHeld(result.buttonLinksHeld ?? 0)");
    // Phase 4 of BUG-0257.
    expect(src).toContain("const removedInline = result.inlineButtonCodeRemoved ?? [];");
    expect(src).toContain("setRemovedInlineButtonCode(removedInline);");
    expect(src).toContain(
      '<InlineButtonCodeNotice removed={removedInlineButtonCode} testId="subscribe-inline-button-code-removed" />',
    );
    expect(src).toContain("describeInlineButtonCodeHeld(result.inlineButtonCodeHeld ?? 0)");
    expect(src, "the status line no longer counts the held inline code").toContain(
      '(inlineHeld ? `, ${inlineHeld}` : "")',
    );
    expect(src).toContain("removedInline.length > 0;");
  });
});

// ============================================================================
// Phase 4 of BUG-0257: button CONTROLS' inline code a subscribe or refresh
// removed (written as a formula), and the code it held.
// ============================================================================

const INLINE_REMOVED = [
  "Dashboard!B2: its action is a formula, which Calcula does not run as button code; it was removed",
];

describe("the notice that lists the inline button code a door removed", () => {
  // SABOTAGE: return null unconditionally from InlineButtonCodeNotice.
  it("names every removed action, with why", async () => {
    await act(async () => {
      root.render(<InlineButtonCodeNotice removed={INLINE_REMOVED} testId="i" />);
    });
    const notice = host.querySelector("[data-testid='i']")!;
    expect(notice.textContent).toContain(
      "1 button came with code written as a formula, which Calcula does not run as button code, and it was removed",
    );
    expect(notice.textContent).toContain("only when you can approve its exact text");
    expect(notice.textContent).toContain("Dashboard!B2: its action is a formula");
    expect(describeInlineButtonCodeRemoved(2)).toMatch(/^2 buttons came with code .* and they were removed/);
  });

  it("says nothing when none was removed", async () => {
    await act(async () => {
      root.render(<InlineButtonCodeNotice removed={[]} testId="i" />);
    });
    expect(host.querySelector("[data-testid='i']")).toBeNull();
  });

  it("counts the held code as runnable after approval -- never as inert", () => {
    expect(describeInlineButtonCodeHeld(0)).toBe("");
    expect(describeInlineButtonCodeHeld(1)).toBe(
      "1 button with code of its own (it runs only after you approve that code; the approval screen shows it)",
    );
    expect(describeInlineButtonCodeHeld(3)).toBe(
      "3 buttons with code of their own (they run only after you approve that code; the approval screen shows it)",
    );
  });

  // SABOTAGE: drop the InlineButtonCodeNotice from RefreshPreviewDialog.
  it("the refresh dialog lists them after the refresh, and a reset clears the list", () => {
    const refresh = read("extensions/Collaboration/components/RefreshPreviewDialog.tsx");
    expect(refresh).toContain("setRemovedInlineButtonCode(r.inlineButtonCodeRemoved ?? []);");
    expect(refresh).toContain("<InlineButtonCodeNotice");
    expect(refresh).toContain('testId="refresh-inline-button-code-removed"');
    const reset = refresh.slice(refresh.indexOf("const handleReset = async"));
    expect(reset.slice(0, reset.indexOf("try {"))).toContain("setRemovedInlineButtonCode([]);");
  });
});

// ============================================================================
// Phase 3 of BUG-0257: button CONTROLS' macro links a subscribe or refresh
// removed, and the ones it kept.
// ============================================================================

const LINKS_REMOVED = [
  'Dashboard!C3: links the macro "macro-report", which the application \'sales\' did not bring into this workbook; the link was removed',
];

describe("the notice that lists the macro links a door removed", () => {
  // SABOTAGE: return null unconditionally from ButtonLinksNotice.
  it("names every removed link, with why", async () => {
    await act(async () => {
      root.render(<ButtonLinksNotice links={LINKS_REMOVED} testId="l" />);
    });
    const notice = host.querySelector("[data-testid='l']")!;
    expect(notice.textContent).toContain(
      "1 button linked a macro this application did not bring into this workbook, and the link was removed",
    );
    expect(notice.textContent).toContain("never one of yours with the same name");
    expect(notice.textContent).toContain('Dashboard!C3: links the macro "macro-report"');
  });

  it("says nothing when no link was removed", async () => {
    await act(async () => {
      root.render(<ButtonLinksNotice links={[]} testId="l" />);
    });
    expect(host.querySelector("[data-testid='l']")).toBeNull();
  });

  it("counts the kept links as armed after approval -- never as inert", () => {
    expect(describeButtonLinksHeld(0)).toBe("");
    expect(describeButtonLinksHeld(2)).toBe(
      "2 buttons linked to its macros (they run after you approve the application's code)",
    );
  });

  // SABOTAGE: drop the ButtonLinksNotice from RefreshPreviewDialog.
  it("the refresh dialog lists them after the refresh, and a reset clears the list", () => {
    const refresh = read("extensions/Collaboration/components/RefreshPreviewDialog.tsx");
    expect(refresh).toContain("setRemovedButtonLinks(r.buttonLinksRemoved ?? []);");
    expect(refresh).toContain('<ButtonLinksNotice links={removedButtonLinks} testId="refresh-button-links-removed" />');
    const reset = refresh.slice(refresh.indexOf("const handleReset = async"));
    expect(reset.slice(0, reset.indexOf("try {"))).toContain("setRemovedButtonLinks([]);");
  });
});

// ============================================================================
// Phase 4 of BUG-0257, the wording: a button control's inline code TRAVELS
// with its application and runs only after approval -- in a working copy too.
// No screen may still call it inert, disarmed or "does not run".
// ============================================================================

describe("the checkout says held button code runs after approval -- inline code included", () => {
  const response = (buttonCodeHeld: number): CheckoutResponse => ({
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
    buttonCodeHeld,
  });

  // SABOTAGE: put back "Inline button code does not run in this working copy"
  // in CheckoutSignerPanel -> red.
  it("names the slots, says they run only after the approval, and where to make them yours", async () => {
    await act(async () => {
      root.render(<CheckoutSignerPanel result={response(2)} />);
    });
    const box = host.querySelector("[data-testid='checkout-button-code-held']")!.textContent!.replace(/\s+/g, " ");
    // The journey (owner-followups.spec.ts BUG-0257) reads this prefix.
    expect(box).toMatch(/^Button code ?2 button code slots came with this application and stay the application’s:/);
    expect(box).toContain(
      "a button runs its code, or the application’s macro it links, only after you approve the " +
        "application’s code, which the approval screen shows.",
    );
    expect(box).toContain("Your next push publishes them unchanged, after checking against this signed version.");
    expect(box).toContain("“Make this my own” there makes a button’s code yours.");
    expect(box, "the checkout still calls inline button code inert").not.toMatch(/does not run|inert/);

    await act(async () => {
      root.render(<CheckoutSignerPanel result={response(1)} />);
    });
    const one = host.querySelector("[data-testid='checkout-button-code-held']")!.textContent!.replace(/\s+/g, " ");
    expect(one).toContain("1 button code slot came with this application and stays the application’s:");
    expect(one).toContain("Your next push publishes it unchanged");
  });
});

describe("the Application Inspector no longer says controls arrive disarmed", () => {
  const overview = {
    tables: [],
    namedRanges: [],
    charts: [],
    sparklineSheets: [],
    pivots: [],
    slicers: [],
    paneControls: [],
    ribbonFilters: [],
    pivotLayouts: [],
    conditionalFormatSheets: [],
    dataValidationSheets: [],
    controlSheets: ["Dashboard"],
    commentSheets: [],
    scenarioSheets: [],
    outlineSheets: [],
    hasTheme: false,
    themeName: null,
    extensionDataKeys: [],
    customObjects: [],
  } as unknown as InspectorOverview;

  // SABOTAGE: put back the label "Cell-anchored controls (disarmed at pull)"
  // in inspector/ObjectsSection.tsx -> red.
  it("labels the sheets with controls by what their button code does", async () => {
    await act(async () => {
      root.render(<ObjectsSection overview={overview} />);
    });
    const text = host.textContent ?? "";
    expect(text).toContain("Cell-anchored controls (button code runs after approval)");
    expect(text).toContain("Dashboard");
    expect(text).not.toMatch(/disarmed/i);
  });
});
