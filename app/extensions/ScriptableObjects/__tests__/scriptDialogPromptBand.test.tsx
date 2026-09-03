//! FILENAME: app/extensions/ScriptableObjects/__tests__/scriptDialogPromptBand.test.tsx
// PURPOSE: The ui.dialog identity band says WHERE the asking script came from,
//          and no publisher-chosen application name may select the wording.
// CONTEXT: The band branched on `request.scriptOrigin === "local"` against a
//          field that carried EITHER the sentinel for workbook code OR the
//          publisher's chosen application name. So publishing an application
//          called `local` made the band tell the user "A script in this workbook
//          is asking you a question" about somebody else's code — the exact
//          impersonation the band exists to prevent, reached by choosing a name.
//
//          `scriptOrigin` is now a discriminated `ScriptOrigin`
//          (@api/scriptHost/scriptOrigin): the branch reads `kind`, which is a
//          closed set nothing a publisher types can land in. This is the same
//          fix, for the same reason, as the FORM band pinned in
//          scriptFormDialog.test.tsx ("does not let a package named local claim
//          the workbook's own phrasing").

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ScriptDialogRequestPayload } from "@api";
import ScriptDialogPrompt from "../components/ScriptDialogPrompt";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

function request(over: Partial<ScriptDialogRequestPayload> = {}): ScriptDialogRequestPayload {
  return {
    requestId: "scriptdlg-1",
    scriptId: "s1",
    scriptName: "Month-end close",
    scriptOrigin: { kind: "local" },
    kind: "confirm",
    message: "Delete 40 rows?",
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root | null = null;
const onClose = vi.fn();

async function mount(req: ScriptDialogRequestPayload): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      React.createElement(ScriptDialogPrompt, {
        isOpen: true,
        onClose,
        data: req as unknown as Record<string, unknown>,
      } as never),
    );
  });
}

function band(): string {
  const el = container.querySelector("[data-script-dialog-band]");
  if (!el) throw new Error("no identity band rendered");
  return el.textContent ?? "";
}

beforeEach(() => {
  onClose.mockReset();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
});

describe("the ui.dialog identity band", () => {
  it("says the workbook for a workbook-authored script", async () => {
    await mount(request());
    expect(band()).toBe("A script in this workbook is asking you a question");
  });

  it("names the package for a distributed script", async () => {
    await mount(request({ scriptOrigin: { kind: "package", name: "Sales Pack" } }));
    expect(band()).toBe('A script from the package "Sales Pack" is asking you a question');
  });

  it("does not let a package NAMED `local` claim the workbook's own phrasing", async () => {
    // THE REGRESSION. Under the old bare-string `scriptOrigin`, this payload was
    // the literal "local" and this assertion read "A script in this workbook is
    // asking you a question" — a distributed script wearing the user's own
    // provenance, one manifest field away.
    await mount(request({ scriptOrigin: { kind: "package", name: "local" } }));
    expect(band()).toBe('A script from the package "local" is asking you a question');
    expect(band()).not.toContain("in this workbook");
  });

  it("the script's own title never reaches the band", async () => {
    // The band is chrome; the script-supplied title is body content. A script
    // that titles itself "A script in this workbook" still gets named.
    await mount(
      request({
        scriptOrigin: { kind: "package", name: "local" },
        textOptions: { title: "A script in this workbook" },
      }),
    );
    expect(band()).toBe('A script from the package "local" is asking you a question');
  });
});
