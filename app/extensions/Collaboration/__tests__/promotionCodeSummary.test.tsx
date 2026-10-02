//! FILENAME: app/extensions/Collaboration/__tests__/promotionCodeSummary.test.tsx
// PURPOSE: The Promote dialog's CODE summary (plan_M8 S5): read first, read on
//          a FIRST promotion too, never swallowed when the read fails, keyed by
//          one exhaustive table per Rust wire value, and named in the confirm.
// CONTEXT: The dialog used to skip the impact read entirely when the
//          environment held no version (an early return), and swallowed a
//          rejected read (`.catch(() => undefined)`), so a promoter could move
//          an entire audience onto new code with nothing on screen saying so.
//          The confirm is doubled in the TAURI shape (`Promise<boolean>`), the
//          shape a synchronous double once hid a dead guard behind.

import fs from "fs";
import path from "path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PromotionCodeChange, PromotionImpact } from "@api/collaboration";

const listEnvironments = vi.fn();
const promotionImpact = vi.fn();
const diffVersions = vi.fn();
const promoteEnvironment = vi.fn();
const confirmAsync = vi.fn();

vi.mock("@api", () => ({
  listEnvironments: (...a: unknown[]) => listEnvironments(...a),
  promotionImpact: (...a: unknown[]) => promotionImpact(...a),
  diffVersions: (...a: unknown[]) => diffVersions(...a),
  diffSheetCells: vi.fn(),
  promoteEnvironment: (...a: unknown[]) => promoteEnvironment(...a),
  emitAppEvent: vi.fn(),
  ENVIRONMENTS_CHANGED_EVENT: "collaboration:environments-changed",
}));
vi.mock("@api/dialogs", () => ({ confirmAsync: (...a: unknown[]) => confirmAsync(...a) }));

import { PromoteDialog } from "../components/PromoteDialog";
import {
  PROMOTION_CODE_CHANGE,
  PROMOTION_CODE_CONSEQUENCE,
  PROMOTION_CODE_KIND,
} from "../lib/promotionCode";

function env(name: string, version: string | null) {
  return {
    name,
    version,
    previousVersion: "",
    promotedAt: "",
    promotedBy: "",
    promoterKey: "",
    isYou: true,
    unauthorizedPointer: false,
    sequence: 1,
    heldVersions: version ? [version] : [],
  };
}

/** test holds 1.1.0; prod holds `prodVersion` (null = a first promotion). */
function pipeline(prodVersion: string | null) {
  return {
    packageName: "sales",
    headVersion: "1.2.0",
    environments: [env("test", "1.1.0"), env("prod", prodVersion)],
    history: [],
    youMayPromote: true,
    writable: true,
    problem: "",
  };
}

function change(overrides: Partial<PromotionCodeChange> = {}): PromotionCodeChange {
  return {
    kind: "macro",
    id: "mod-report",
    name: "Report",
    sheetName: null,
    change: "modified",
    detail: "",
    consequence: "asksApprovalAgain",
    before: "return 1;",
    after: "return 2;",
    beforeTruncated: false,
    afterTruncated: false,
    addedCapabilities: [],
    ...overrides,
  };
}

function impact(overrides: Partial<PromotionImpact> = {}): PromotionImpact {
  return {
    writebackReport: "",
    codeChanges: [
      change(),
      change({
        kind: "objectScript",
        id: "obj-fetch",
        name: "Fetcher",
        change: "added",
        before: null,
        after: "// @capability net.fetch\nfunction setup(c) {}",
        addedCapabilities: ["net.fetch"],
      }),
    ],
    asksApprovalAgain: true,
    codeError: null,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

const q = (sel: string) => container.querySelector<HTMLElement>(sel);
const qa = (sel: string) => [...container.querySelectorAll<HTMLElement>(sel)];
const promoteButton = () =>
  [...container.querySelectorAll("button")].find((b) => /^(Promote|Roll back)…$/.test(b.textContent?.trim() ?? ""));

async function open(prodVersion: string | null): Promise<void> {
  listEnvironments.mockResolvedValue(pipeline(prodVersion));
  await act(async () => {
    root.render(
      <PromoteDialog
        isOpen
        onClose={() => undefined}
        data={{ registryPath: "C:/ws", packageName: "sales", environment: "prod", mode: "promote" }}
      />,
    );
  });
  await act(async () => {});
  await act(async () => {});
}

async function pressPromote(): Promise<string> {
  const b = promoteButton();
  expect(b, "the Promote button moved or was renamed").toBeTruthy();
  expect(b!.disabled, "Promote is disabled").toBe(false);
  await act(async () => {
    b!.click();
  });
  await act(async () => {});
  expect(confirmAsync).toHaveBeenCalledTimes(1);
  return String(confirmAsync.mock.calls[0][0]);
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  for (const f of [listEnvironments, promotionImpact, diffVersions, promoteEnvironment, confirmAsync]) f.mockReset();
  diffVersions.mockResolvedValue({
    packageName: "sales",
    fromVersion: "1.0.0",
    toVersion: "1.1.0",
    artifacts: { added: [], removed: [], changed: [], spuriousHashChanges: 0, unchangedCount: 0 },
    sheets: [],
    objects: [],
    manifestChanges: [],
    totals: {
      objectsAdded: 0,
      objectsRemoved: 0,
      objectsModified: 0,
      sheetsChanged: 0,
      cellsChanged: 0,
      cellsChangedExact: true,
    },
  });
  promoteEnvironment.mockResolvedValue({
    writebackReport: "",
    environment: "prod",
    from: null,
    to: "1.1.0",
    isRollback: false,
    sequence: 2,
    environments: [],
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("the code summary is read first, on a first promotion too", () => {
  // SABOTAGE: restore the early return when the environment has no version
  // (`if (!req || !currentVersion || ...)`).
  it("a FIRST promotion asks for the impact and lists every piece of code as new", async () => {
    promotionImpact.mockResolvedValue(
      impact({
        codeChanges: [change({ change: "added", before: null, after: "return 1;" })],
      }),
    );
    await open(null);
    expect(promotionImpact).toHaveBeenCalledWith({
      registryPath: "C:/ws",
      packageName: "sales",
      environment: "prod",
      version: "1.1.0",
    });
    expect(diffVersions, "a first promotion has no version to diff cells against").not.toHaveBeenCalled();
    expect(q("[data-promotion-code]")?.dataset.promotionCode).toBe("ready");
    expect(q("[data-promotion-code-headline]")!.textContent).toBe(
      "Code: 1 item. Everyone in prod will be asked to approve this application's code before it runs.",
    );
    const row = q('[data-promotion-code-row="mod-report"]');
    expect(row, "the macro has no row").toBeTruthy();
    expect(row!.dataset.promotionCodeChange).toBe("added");
    expect(row!.textContent).toContain("Everyone in prod is asked to approve it before it runs.");
  });

  it("lists the code ABOVE the cell diff, with consequences and gained capabilities", async () => {
    promotionImpact.mockResolvedValue(impact());
    await open("1.0.0");
    expect(diffVersions).toHaveBeenCalledTimes(1);
    expect(q("[data-promotion-code-headline]")!.textContent).toBe(
      "Code: 2 changes. Everyone in prod will be asked to approve this application's code again before it runs.",
    );
    const rows = qa("[data-promotion-code-row]");
    expect(rows.map((r) => r.dataset.promotionCodeRow)).toEqual(["mod-report", "obj-fetch"]);
    expect(q('[data-promotion-code-row="obj-fetch"] [data-promotion-code-capabilities]')!.textContent).toBe(
      "It gains net.fetch.",
    );
    // Before/after are in the row, collapsed.
    const source = q('[data-promotion-code-row="mod-report"] [data-promotion-code-source]')!;
    expect(source.tagName).toBe("DETAILS");
    expect(source.textContent).toContain("return 1;");
    expect(source.textContent).toContain("return 2;");
    // FIRST: the code section precedes the "will see change" heading.
    const html = container.innerHTML;
    expect(html.indexOf("data-promotion-code=")).toBeLessThan(html.indexOf("will see change"));
  });

  it("says plainly when no code changes", async () => {
    promotionImpact.mockResolvedValue(impact({ codeChanges: [], asksApprovalAgain: false }));
    await open("1.0.0");
    expect(q("[data-promotion-code-headline]")!.textContent).toBe("Code: no changes, nobody is asked again.");
    expect(qa("[data-promotion-code-row]")).toHaveLength(0);
  });
});

describe("a failed comparison is said, never swallowed, and never blocks Promote", () => {
  it("a codeError shows the failure, and Promote stays enabled", async () => {
    promotionImpact.mockResolvedValue(
      impact({ codeChanges: [], asksApprovalAgain: false, codeError: "v1.1.0 cannot be shown: signed by mallory" }),
    );
    await open("1.0.0");
    expect(q("[data-promotion-code]")?.dataset.promotionCode).toBe("failed");
    expect(q("[data-promotion-code-headline]")!.textContent).toBe(
      "Code: the comparison failed: v1.1.0 cannot be shown: signed by mallory.",
    );
    expect(promoteButton()!.disabled).toBe(false);
  });

  // SABOTAGE: put the swallowing `.catch(() => undefined)` back on the impact read.
  it("a REJECTED impact read shows the failure, and the confirm names it", async () => {
    promotionImpact.mockRejectedValue("CALP_WORKSPACE_UNREADABLE: the share is gone");
    confirmAsync.mockReturnValue(Promise.resolve(false));
    await open("1.0.0");
    expect(q("[data-promotion-code]")?.dataset.promotionCode, "the rejected read vanished").toBe("failed");
    expect(q("[data-promotion-code-headline]")!.textContent).toContain(
      "Code: the comparison failed: CALP_WORKSPACE_UNREADABLE: the share is gone",
    );
    const message = await pressPromote();
    expect(message).toContain("the comparison of the application's code failed");
    expect(message).toContain("CALP_WORKSPACE_UNREADABLE: the share is gone");
    expect(promoteEnvironment).not.toHaveBeenCalled();
  });
});

describe("the confirm names what code changes, and fails closed", () => {
  // SABOTAGE: drop the `await` on confirmAsync in handlePromote (`!Promise` is
  // always false, so the refusal would promote).
  it("carries the code sentence, and a refusal (Tauri-shaped false) promotes nothing", async () => {
    promotionImpact.mockResolvedValue(impact());
    confirmAsync.mockReturnValue(Promise.resolve(false));
    await open("1.0.0");
    const message = await pressPromote();
    expect(message).toContain('Code that changes: macro "Report" (changed), object script "Fetcher" (new, gains net.fetch).');
    expect(message).toContain(
      "Everyone in prod will be asked to approve this application's code again before it runs.",
    );
    expect(promoteEnvironment, "a refused confirm promoted").not.toHaveBeenCalled();
  });

  it("the positive control: an accepted confirm promotes the version it showed", async () => {
    promotionImpact.mockResolvedValue(impact());
    confirmAsync.mockReturnValue(Promise.resolve(true));
    await open("1.0.0");
    await pressPromote();
    expect(promoteEnvironment).toHaveBeenCalledWith({
      registryPath: "C:/ws",
      packageName: "sales",
      environment: "prod",
      version: "1.1.0",
      expectedCurrent: "1.0.0",
    });
  });
});

describe("a LATE impact read never describes another version", () => {
  /** prod holds 1.2.0 and has held 1.0.0 and 1.1.0 (the rollback candidates). */
  function rollbackPipeline() {
    return {
      packageName: "sales",
      headVersion: "1.2.0",
      environments: [
        env("test", "1.2.0"),
        { ...env("prod", "1.2.0"), heldVersions: ["1.0.0", "1.1.0", "1.2.0"] },
      ],
      history: [],
      youMayPromote: true,
      writable: true,
      problem: "",
    };
  }

  // SABOTAGE: drop `if (cancelled) return;` before `setCode(promotionCodeFromImpact(r))`
  // in PromoteDialog.tsx -> the slower, EARLIER read lands last and the rows
  // and the confirm describe v1.0.0's code while v1.1.0 is promoted, red.
  it("rollback: the version picker moves on, the earlier read lands LAST, and the rows and the confirm still name the chosen version's code", async () => {
    const pending = new Map<string, (impact: PromotionImpact) => void>();
    promotionImpact.mockImplementation(
      (args: { version: string }) =>
        new Promise<PromotionImpact>((resolve) => {
          pending.set(args.version, resolve);
        }),
    );
    confirmAsync.mockReturnValue(Promise.resolve(false));
    listEnvironments.mockResolvedValue(rollbackPipeline());
    await act(async () => {
      root.render(
        <PromoteDialog
          isOpen
          onClose={() => undefined}
          data={{ registryPath: "C:/ws", packageName: "sales", environment: "prod", mode: "rollback" }}
        />,
      );
    });
    await act(async () => {});
    await act(async () => {});
    expect(pending.has("1.0.0"), "the first candidate's impact was never asked for").toBe(true);

    // The promoter picks v1.1.0 while v1.0.0's read is still out.
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select, "the rollback picker moved").toBeTruthy();
    await act(async () => {
      select.value = "1.1.0";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {});
    expect(pending.has("1.1.0"), "choosing v1.1.0 asked for no impact").toBe(true);

    const code = (id: string, name: string) =>
      impact({ codeChanges: [change({ id, name, change: "modified" })], asksApprovalAgain: true });
    // The CHOSEN version's read answers first; the abandoned one LAST.
    await act(async () => {
      pending.get("1.1.0")!(code("for-1-1-0", "Chosen"));
    });
    await act(async () => {
      pending.get("1.0.0")!(code("for-1-0-0", "Abandoned"));
    });
    await act(async () => {});

    const rows = qa("[data-promotion-code-row]").map((r) => r.dataset.promotionCodeRow);
    expect(rows, "a late read for a version no longer chosen replaced the rows").toEqual(["for-1-1-0"]);
    const message = await pressPromote();
    expect(message).toContain('macro "Chosen" (changed)');
    expect(message, "the confirm named the abandoned version's code").not.toContain("Abandoned");
  });
});

/** The Rust enum's variants, camelCased (`the_wire_values_are_the_camel_cased_variant_names` pins that serde does exactly this). */
function rustVariants(src: string, enumName: string): string[] {
  const start = src.indexOf(`pub enum ${enumName} {`);
  expect(start, `Rust enum ${enumName} not found`).toBeGreaterThanOrEqual(0);
  const body = src.slice(start, src.indexOf("\n}\n", start));
  return [...body.matchAll(/^ {4}([A-Z]\w*),?\s*$/gm)].map((m) => m[1][0].toLowerCase() + m[1].slice(1));
}

describe("one exhaustive table per Rust wire value", () => {
  // SABOTAGE: delete one row from PROMOTION_CODE_CONSEQUENCE (or any table).
  it("every kind, change and consequence core can send has a row, and no row is invented", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../../../core/calp/src/code_summary.rs"),
      "utf8",
    );
    const kinds = rustVariants(src, "CodeKind");
    const changes = rustVariants(src, "CodeChangeKind");
    const consequences = rustVariants(src, "SubscriberConsequence");
    expect(kinds.length, "the enum parse found nothing").toBeGreaterThanOrEqual(8);
    expect(consequences.length).toBeGreaterThanOrEqual(7);
    expect(Object.keys(PROMOTION_CODE_KIND).sort()).toEqual([...kinds].sort());
    expect(Object.keys(PROMOTION_CODE_CHANGE).sort()).toEqual([...changes].sort());
    expect(Object.keys(PROMOTION_CODE_CONSEQUENCE).sort()).toEqual([...consequences].sort());
    for (const c of consequences) {
      const sentence = PROMOTION_CODE_CONSEQUENCE[c as keyof typeof PROMOTION_CODE_CONSEQUENCE].sentence("prod");
      expect(sentence.length, `${c} says nothing`).toBeGreaterThan(10);
    }
  });
});
