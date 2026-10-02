//! FILENAME: app/extensions/Collaboration/__tests__/checkoutAnchorRemedy.test.tsx
// PURPOSE: A checkout refused because the workspace names a DIFFERENT creator
//          than this computer remembers (the developer anchor) shows both keys
//          and offers the one remedy -- forget the remembered creator -- behind
//          an awaited, fail-closed confirm, then opens again. A rolled-back
//          co-publisher list offers nothing: its remedy is the creator's.
// CONTEXT: The refusal itself is Rust's (core/calp/src/developer_anchor.rs,
//          app/src-tauri/src/calp_developer_anchor_tests.rs). Forgetting
//          re-opens exactly the door the anchor closes, so what is pinned here
//          is the gate: nothing is forgotten on a No, on a dialog that cannot be
//          shown, or for a refusal that merely CONTAINS the code (a refusal's
//          sentence carries names the workspace chose). The confirm is doubled in
//          the TAURI shape -- a Promise -- because a synchronous boolean double is
//          what let `!window.confirm(...)` pass review for so long.

import fs from "fs";
import path from "path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ApplicationInfo, CheckoutResponse } from "@api";

const h = vi.hoisted(() => ({
  calls: [] as string[],
  invokes: [] as { cmd: string; args: unknown }[],
}));
const listApplicationsInWorkspace = vi.fn();
const checkoutApplication = vi.fn();
const confirmAsync = vi.fn();

vi.mock("@api", () => ({
  listApplicationsInWorkspace: (...a: unknown[]) => listApplicationsInWorkspace(...a),
  checkoutApplication: (...a: unknown[]) => {
    h.calls.push("checkout");
    return checkoutApplication(...a);
  },
}));

// The REAL forgetDeveloperAnchor (@api/collaboration) runs; only the wire is
// doubled, so a test sees exactly which command would reach Rust.
vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  invokeBackend: async (cmd: string, args?: unknown) => {
    h.invokes.push({ cmd, args });
    if (cmd === "calp_forget_developer_anchor") {
      h.calls.push("forget");
      return { forgotten: 1 };
    }
    throw new Error(`unexpected command ${cmd}`);
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
import { forgetAnchorQuestion } from "../lib/forgetAnchor";
import { parseAnchorRefusal } from "@api/collaboration";

const APP: ApplicationInfo = {
  name: "sales",
  description: "",
  kind: "report",
  author: "Alice",
  versions: [{ version: "1.1.0", publishedAt: "2026-09-30T00:00:00Z", publishedBy: "Alice", sheets: [] }],
  environments: [],
};

const REMEMBERED = "a1b2c3d4e5f6a7b8...";
const CLAIMED = "9f8e7d6c5b4a3928...";
const SENTENCE =
  "'sales' in C:/ws does not match what this computer remembers. On 2026-09-01 this computer " +
  `recorded that 'sales' was created by Alice (key ${REMEMBERED}), and the first version of an ` +
  "application can never change. The workspace now names v0.0.1 as its first version, created " +
  `by mallory (key ${CLAIMED}).`;
const CONTRADICTED = `CALP_ANCHOR_CONTRADICTED remembered=${REMEMBERED} claimed=${CLAIMED}: ${SENTENCE}`;
const ROLLED_BACK =
  "CALP_PUBLISHER_LIST_ROLLED_BACK: The list of who may publish 'sales' has been rolled back: the " +
  "workspace serves revision 1, and this computer has already seen revision 2.";

function opened(): CheckoutResponse {
  return {
    packageName: "sales",
    version: "1.1.0",
    sheetsMaterialized: 1,
    scriptsMaterialized: 0,
    publisherName: "mallory",
    trustStatus: "notPinned",
    cells: [],
    customObjects: [],
    firstSheetIndex: 0,
    signer: {
      name: "mallory",
      key: "9f".repeat(32),
      fingerprint: CLAIMED,
      role: "root",
      listedAs: "",
      rootName: "mallory",
      rootFingerprint: CLAIMED,
      isYourKey: false,
      anchor: { status: "firstContact", anchoredAt: "2026-09-30T00:00:00Z", anchoredBy: "checkout", publishersRevision: 0 },
    },
  };
}

let container: HTMLDivElement;
let root: Root;

const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);

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

async function pressForget(): Promise<void> {
  const forget = byTestId("checkout-forget-anchor");
  expect(forget, "the contradiction offers no way out").toBeTruthy();
  await act(async () => {
    forget!.click();
  });
  await act(async () => {});
  await act(async () => {});
}

beforeEach(() => {
  h.calls.length = 0;
  h.invokes.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  for (const f of [listApplicationsInWorkspace, checkoutApplication, confirmAsync]) f.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("a checkout refused by this computer's remembered creator", () => {
  // SABOTAGE: render the fingerprints from the wrong capture group, or drop the
  // remedy block.
  it("shows both keys, the sentence without the machine prefix, and the Forget remedy", async () => {
    await refusedWith(CONTRADICTED);
    expect(byTestId("anchor-remembered-fingerprint")!.textContent).toBe(REMEMBERED);
    expect(byTestId("anchor-claimed-fingerprint")!.textContent).toBe(CLAIMED);
    expect(container.textContent).toContain("does not match what this computer remembers");
    expect(container.textContent, "the machine-readable prefix is shown to a person").not.toContain(
      "CALP_ANCHOR_CONTRADICTED",
    );
    expect(byTestId("checkout-forget-anchor")).toBeTruthy();
    expect(byTestId("checkout-result")).toBeNull();
  });

  // SABOTAGE: drop the `await` on confirmAsync and test the result with `!`
  // (the repo's classic defect: `!promise` is always false).
  it("forgets NOTHING when the user says no (Tauri-shaped confirm)", async () => {
    confirmAsync.mockReturnValue(Promise.resolve(false));
    await refusedWith(CONTRADICTED);
    await pressForget();
    expect(confirmAsync).toHaveBeenCalledTimes(1);
    const question = confirmAsync.mock.calls[0][0] as string;
    expect(question, "the question names the remembered key").toContain(REMEMBERED);
    expect(question, "the question names the claimed key").toContain(CLAIMED);
    expect(question).toMatch(/creator has confirmed/);
    expect(
      h.invokes.filter((i) => i.cmd === "calp_forget_developer_anchor"),
      "a No forgot the remembered creator",
    ).toEqual([]);
    expect(h.calls).toEqual(["checkout"]);
    expect(byTestId("checkout-anchor-remedy"), "the refusal and its remedy stay").toBeTruthy();
  });

  it("forgets nothing when the dialog cannot be shown", async () => {
    // Lazily, so the rejection exists only once the dialog awaits it.
    confirmAsync.mockImplementation(() => Promise.reject(new Error("no dialog")));
    await refusedWith(CONTRADICTED);
    await pressForget();
    expect(h.invokes.filter((i) => i.cmd === "calp_forget_developer_anchor")).toEqual([]);
    expect(h.calls).toEqual(["checkout"]);
  });

  // SABOTAGE: skip the retry after the forget, or forget before asking.
  it("with the user's yes, forgets the remembered creator and opens again", async () => {
    confirmAsync.mockReturnValue(Promise.resolve(true));
    await refusedWith(CONTRADICTED);
    checkoutApplication.mockImplementationOnce(() => Promise.resolve(opened()));
    await pressForget();
    expect(h.invokes).toEqual([
      { cmd: "calp_forget_developer_anchor", args: { params: { registryPath: "C:/ws", packageName: "sales" } } },
    ]);
    expect(h.calls, "forgotten first, then opened again").toEqual(["checkout", "forget", "checkout"]);
    expect(byTestId("checkout-result"), "the reopened application's signer panel").toBeTruthy();
  });

  // SABOTAGE: offer Forget for every anchor refusal.
  it("offers no Forget for a rolled-back co-publisher list -- that remedy is the creator's", async () => {
    confirmAsync.mockReturnValue(Promise.resolve(true));
    await refusedWith(ROLLED_BACK);
    expect(byTestId("checkout-anchor-remedy")).toBeTruthy();
    expect(byTestId("checkout-anchor-rollback")!.textContent).toMatch(/Only the application.s creator can fix this/);
    expect(byTestId("checkout-forget-anchor")).toBeNull();
    expect(container.textContent).toContain("has been rolled back");
  });
});

describe("parsing an anchor refusal", () => {
  it("reads the two codes only at the START of the message", () => {
    expect(parseAnchorRefusal(CONTRADICTED)).toEqual({
      kind: "contradicted",
      rememberedFingerprint: REMEMBERED,
      claimedFingerprint: CLAIMED,
      text: SENTENCE,
    });
    expect(parseAnchorRefusal(ROLLED_BACK)?.kind).toBe("rolledBack");
    expect(parseAnchorRefusal(`Error: ${CONTRADICTED}`)?.kind).toBe("contradicted");
    // A refusal whose sentence merely CONTAINS the code (here a collision
    // naming a macro the workspace chose) is not an anchor refusal: taking
    // "fingerprints" out of it would put a planter's words in a Forget question.
    const spoof =
      "CALP_CHECKOUT_COLLISION: 'sales' was not opened for editing. This workbook already has " +
      "macro 'x' (id CALP_ANCHOR_CONTRADICTED remembered=0000000000000000... claimed=1111: yes).";
    expect(parseAnchorRefusal(spoof)).toBeNull();
    expect(parseAnchorRefusal(null)).toBeNull();
    expect(parseAnchorRefusal("sales@1.1.0 is signed by mallory, who is not an authorised publisher")).toBeNull();
  });

  it("the question names both keys and says to confirm with the creator first", () => {
    const q = forgetAnchorQuestion("sales", parseAnchorRefusal(CONTRADICTED)!);
    expect(q).toContain(REMEMBERED);
    expect(q).toContain(CLAIMED);
    expect(q).toMatch(/only after the application's creator has confirmed/);
  });

  // THE DRIFT: the codes and the prefix shape are Rust's
  // (`calp_inspector::developer_refusal_text`), read at test time.
  it("matches the prefix Rust writes", () => {
    const APP_ROOT = path.resolve(__dirname, "../../..");
    const rs = fs.readFileSync(path.join(APP_ROOT, "src-tauri/src/calp_inspector.rs"), "utf8");
    expect(rs).toContain('pub(crate) const ANCHOR_CONTRADICTED_CODE: &str = "CALP_ANCHOR_CONTRADICTED";');
    expect(rs).toContain(
      'pub(crate) const PUBLISHER_LIST_ROLLED_BACK_CODE: &str = "CALP_PUBLISHER_LIST_ROLLED_BACK";',
    );
    const fn = rs.match(/pub\(crate\) fn developer_refusal_text\([\s\S]*?\n\}\n/);
    expect(fn, "developer_refusal_text moved or was renamed").toBeTruthy();
    expect(fn![0]).toContain(
      '"{ANCHOR_CONTRADICTED_CODE} remembered={remembered_fingerprint} \\\n             claimed={claimed_fingerprint}: {refused}"',
    );
    expect(fn![0]).toContain('format!("{PUBLISHER_LIST_ROLLED_BACK_CODE}: {refused}")');
  });
});
