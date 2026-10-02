//! FILENAME: app/extensions/Collaboration/__tests__/pushIncludeInApplication.test.tsx
// PURPOSE: M4 -- the push dialog can ADD the author's own new macro, notebook or
//          name to the application ("Include in application"), with the code on
//          screen, and it names every button whose macro the push would leave
//          out, with the remedy that works.
// CONTEXT: The backend is the gate (app/src-tauri/src/calp_include_tests.rs):
//          an item ships only when the request names the hash Rust computed of
//          its code, and a push with a button whose macro it does not publish is
//          refused. What is pinned here is the dialog's half of the promise:
//            * a tick exists only for what Rust offered as includable -- never
//              another application's code;
//            * it stays disabled until the code -- the exact text Rust hashed --
//              has been shown;
//            * the push request carries the Rust-supplied hash, and a tick asks
//              the preview again (what ships, and which buttons still run a
//              macro the push leaves out, changes with it);
//            * the wire names mirror the Rust enums (Rust -> TypeScript).
//          The dialog is MOUNTED for the last two, with only the Tauri boundary
//          (@api) doubled, because a source census of this dialog cannot see a
//          request built from the wrong state.

import fs from "fs";
import path from "path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  IncludedItem,
  PublishReport,
  UnshippedMacroLinkItem,
  WithheldContent,
  WorkingCopyStatus,
} from "@api";

const h = vi.hoisted(() => ({
  previews: [] as unknown[][],
  published: [] as Record<string, unknown>[],
  diffs: [] as Record<string, unknown>[],
  /** When set, the doubled push is refused with this text. */
  publishError: null as string | null,
  /** The new macro has been SHIPPED: it is part of the application now, so
   *  the answer neither withholds nor adds it (Rust refuses a request that
   *  still names it -- "already part of the application"). */
  shipped: false,
}));

// The Rust answer the doubled preview returns: without the inclusion the new
// macro is withheld and the button linked to it cannot ship; with it (the
// hash Rust supplied), the macro is added and the button is fine.
const MACRO: WithheldContent = {
  kind: "moduleScript",
  id: "macro-new",
  name: "New report",
  reason: "notInApplication",
  owner: "",
  includable: true,
  contentHash: "rust-hash-1",
  code: "NewReport();",
  detail: "",
};
const FOREIGN: WithheldContent = {
  kind: "moduleScript",
  id: "macro-fin",
  name: "Close the month",
  reason: "otherApplication",
  owner: "finance",
  includable: false,
  contentHash: "",
  code: "",
  detail: "",
};
const PANE: WithheldContent = {
  kind: "paneControl",
  id: "p1",
  name: "Scratch",
  reason: "notInApplication",
  owner: "",
  includable: false,
  contentHash: "",
  code: "",
  detail: "",
};
const LINK: UnshippedMacroLinkItem = {
  cell: "Dashboard!B5",
  kind: "control",
  macroId: "macro-new",
  macroName: "New report",
  remedy: "include",
  owner: "",
};

function reportFor(including: readonly IncludedItem[]): PublishReport {
  if (h.shipped) {
    return {
      included: [{ category: "sheets", count: 1, detail: "cell data" }],
      excluded: [],
      withheld: [FOREIGN],
      addedToApplication: [],
      buttonCode: { restored: [], refused: [], unreviewed: [], withheld: [] },
      unshippedMacroLinks: [],
    };
  }
  const included = including.some((i) => i.id === "macro-new" && i.hash === "rust-hash-1");
  return {
    included: [{ category: "sheets", count: 1, detail: "cell data" }],
    excluded: [],
    withheld: included ? [FOREIGN] : [MACRO, FOREIGN],
    addedToApplication: included ? [MACRO] : [],
    buttonCode: { restored: [], refused: [], unreviewed: [], withheld: [] },
    unshippedMacroLinks: included ? [] : [LINK],
  };
}

const STATUS: WorkingCopyStatus = {
  registryUrl: "\\\\server\\apps",
  packageName: "sales",
  kind: "report",
  baseVersion: "1.0.0",
  checkedOutAt: "2026-09-30T00:00:00Z",
  lastPushedVersion: "",
  lastPushedAt: "",
  baseSheets: [],
  registryReachable: true,
  headVersion: "1.0.0",
  isStale: false,
  versions: [],
  suggestedNext: { major: "2.0.0", minor: "1.1.0", patch: "1.0.1" },
  holdsPublisherKey: true,
  registryError: "",
  environments: [],
  youMayPromote: true,
  baseIsPromoted: null,
};

vi.mock("@api", () => ({
  publishPreview: vi.fn(async (...args: unknown[]) => {
    h.previews.push(args);
    const including = (args[4] as IncludedItem[] | undefined) ?? [];
    return {
      sheetNames: ["Dashboard"],
      report: reportFor(including),
      warnings: [],
      gates: {
        linkStatus: "linked",
        expectedBase: "1.0.0",
        registryLatest: "1.0.0",
        latestPublishedBy: "",
        baseStale: false,
        keyContinuityOk: true,
        registryWritable: true,
        registryError: "",
      },
      sheets: [
        { index: 1, sheetId: "sheet-dash", name: "Dashboard", subscribedTo: "", defaultSelected: true, kind: "worksheet" },
      ],
      defaultSheetIndices: [1],
    };
  }),
  publishApplication: vi.fn(async (params: Record<string, unknown>) => {
    h.published.push(params);
    if (h.publishError) throw new Error(h.publishError);
    return {
      packageName: "sales",
      version: "1.0.1",
      sheetsPublished: 1,
      tablesPublished: 0,
      namedRangesPublished: 0,
      scriptsPublished: 0,
      modulesPublished: 1,
      notebooksPublished: 0,
      report: reportFor((params.includeInApplication as IncludedItem[]) ?? []),
      warnings: [],
    };
  }),
  diffWorkingCopy: vi.fn(async (params: Record<string, unknown>) => {
    h.diffs.push(params);
    throw new Error("no diff in this test");
  }),
  workingCopyStatus: vi.fn(async () => STATUS),
  pushMergeAnalyze: vi.fn(async () => null),
  pushMergeApply: vi.fn(),
  undo: vi.fn(),
  showDialog: vi.fn(),
  listApplicationsInWorkspace: vi.fn(async () => []),
  emitAppEvent: vi.fn(),
  ENVIRONMENTS_CHANGED_EVENT: "environments-changed",
  openPanel: vi.fn(),
  // PublishReportView's module (ApplicationExplorerPanel)
  getSubscriptions: vi.fn(async () => ({ subscriptions: [] })),
  getApplicationObjects: vi.fn(),
  activateSheet: vi.fn(),
  onAppEvent: vi.fn(() => () => undefined),
  AppEvents: {},
}));
vi.mock("@api/collaboration", () => ({ holdBackCells: vi.fn() }));
vi.mock("@api/collaborationWorkspaces", () => ({ listWorkspaces: vi.fn(async () => []) }));
vi.mock("../manifest", () => ({ CHECKOUT_DIALOG_ID: "checkout", APPLICATION_EXPLORER_PANEL_ID: "explorer" }));
vi.mock("../lib/pickWorkspace", () => ({ pickWorkspaceFile: vi.fn(), pickWorkspaceFolder: vi.fn() }));
vi.mock("../lib/openApplicationInspectorWindow", () => ({ openApplicationInspectorWindow: vi.fn() }));

import { PublishDialog } from "../components/PublishDialog";
import {
  AddedToApplicationList,
  IncludeInApplicationContext,
  WithheldContentList,
  type IncludeControls,
} from "../components/WithheldContentList";
import { UnshippedMacroLinks } from "../components/UnshippedMacroLinks";
import { PublishReportView } from "../components/ApplicationExplorerPanel";
import {
  EMPTY_INCLUDE_STATE,
  isIncluded,
  isReviewed,
  isTickedForOtherCode,
  markReviewed,
  setIncluded,
  type IncludeState,
} from "../lib/includeInApplication";

const APP_ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(APP_ROOT, rel), "utf8");

let container: HTMLDivElement;
let root: Root;
const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const tick = (id: string) => byTestId(id) as HTMLInputElement | null;

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function click(el: HTMLElement | null): Promise<void> {
  expect(el, "the control is not on screen").toBeTruthy();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

async function typeSummary(text: string): Promise<void> {
  const summary = container.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(summary, text);
    summary.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

async function pressPush(): Promise<void> {
  await click([...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Push") ?? null);
}

async function openAndInclude(): Promise<void> {
  await act(async () => {
    root.render(<PublishDialog onClose={vi.fn()} data={{}} />);
  });
  await flush();
  await click(byTestId("include-show-moduleScript-macro-new"));
  await click(tick("include-tick-moduleScript-macro-new"));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  h.previews.length = 0;
  h.published.length = 0;
  h.diffs.length = 0;
  h.publishError = null;
  h.shipped = false;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** The lists under the push dialog's context, driven by the real include rules. */
function Harness({
  items,
  added = [],
  links = [],
  seen,
}: {
  items: WithheldContent[];
  added?: WithheldContent[];
  links?: UnshippedMacroLinkItem[];
  seen?: (s: IncludeState) => void;
}): React.ReactElement {
  const [state, setState] = React.useState<IncludeState>(EMPTY_INCLUDE_STATE);
  seen?.(state);
  const controls: IncludeControls = {
    isIncluded: (i) => isIncluded(state, i),
    isTickedForOtherCode: (i) => isTickedForOtherCode(state, i),
    isReviewed: (i) => isReviewed(state, i),
    review: (i) => setState((p) => markReviewed(p, i)),
    setIncluded: (i, on) => setState((p) => setIncluded(p, i, on)),
  };
  return (
    <IncludeInApplicationContext.Provider value={controls}>
      <WithheldContentList items={items} />
      <AddedToApplicationList items={added} />
      <UnshippedMacroLinks links={links} withheld={items} />
    </IncludeInApplicationContext.Provider>
  );
}

describe("the include tick, in the lists", () => {
  it("renders only for what Rust offered as includable -- never another application's code", async () => {
    await act(async () => {
      root.render(<Harness items={[MACRO, FOREIGN, PANE]} />);
    });
    expect(tick("include-tick-moduleScript-macro-new")).toBeTruthy();
    expect(tick("include-tick-moduleScript-macro-fin"), "another application's macro got a tick").toBeNull();
    expect(tick("include-tick-paneControl-p1"), "a pane control is not includable (yet)").toBeNull();
  });

  // SABOTAGE: drop `disabled={!reviewed}` from IncludeControl.
  it("is disabled until Show code has put the code Rust hashed on screen", async () => {
    let state: IncludeState = EMPTY_INCLUDE_STATE;
    await act(async () => {
      root.render(<Harness items={[MACRO]} seen={(s) => (state = s)} />);
    });
    const box = tick("include-tick-moduleScript-macro-new")!;
    expect(box.disabled, "the tick is live before the code was read").toBe(true);
    expect(byTestId("include-code-moduleScript-macro-new")).toBeNull();

    await click(byTestId("include-show-moduleScript-macro-new"));
    expect(byTestId("include-code-moduleScript-macro-new")!.textContent).toBe("NewReport();");
    expect(tick("include-tick-moduleScript-macro-new")!.disabled).toBe(false);

    await click(tick("include-tick-moduleScript-macro-new"));
    expect(state.ticks[`moduleScript\u0000macro-new`]).toEqual({ kind: "moduleScript", id: "macro-new", hash: "rust-hash-1" });
  });

  it("a notebook is read cell by cell, and a name's caveat is shown", async () => {
    const notebook: WithheldContent = {
      ...MACRO,
      kind: "notebook",
      id: "nb-new",
      name: "Scratch",
      code: JSON.stringify(["let a = 1;", "a + 1"]),
      contentHash: "nb-hash",
    };
    const name: WithheldContent = {
      ...MACRO,
      kind: "namedRange",
      id: "Secret",
      name: "Secret",
      code: "='My notes'!$A$1",
      contentHash: "name-hash",
      detail: "It refers to 'My notes', which this push does not publish.",
    };
    await act(async () => {
      root.render(<Harness items={[notebook, name]} />);
    });
    await click(byTestId("include-show-notebook-nb-new"));
    const cells = byTestId("include-code-notebook-nb-new")!.querySelectorAll("pre");
    expect([...cells].map((c) => c.textContent)).toEqual(["// Cell 1\nlet a = 1;", "// Cell 2\na + 1"]);
    expect(byTestId("include-detail-namedRange-Secret")!.textContent).toMatch(/does not publish/);
  });

  it("outside the push dialog the lists stay read-only", async () => {
    await act(async () => {
      root.render(
        <>
          <WithheldContentList items={[MACRO]} />
          <AddedToApplicationList items={[MACRO]} />
        </>,
      );
    });
    expect(container.querySelector("input[type=checkbox]")).toBeNull();
    expect(byTestId("added-to-application")!.textContent).toMatch(/Added to the application — published under your key \(1\)/);
  });

  it("a link to your own macro offers its tick in place; another application's does not", async () => {
    const theirs: UnshippedMacroLinkItem = { ...LINK, cell: "Dashboard!B9", macroId: "macro-fin", remedy: "otherApplication", owner: "finance" };
    await act(async () => {
      root.render(<Harness items={[MACRO, FOREIGN]} links={[LINK, theirs]} />);
    });
    const panel = byTestId("unshipped-macro-links")!;
    expect(panel.textContent).toMatch(/Buttons that run a macro this push leaves out \(2\)/);
    expect(byTestId("unshipped-Dashboard!B5")!.querySelector('[data-testid="include-tick-link-moduleScript-macro-new"]')).toBeTruthy();
    expect(byTestId("unshipped-Dashboard!B9")!.querySelector("input[type=checkbox]")).toBeNull();
    expect(byTestId("unshipped-Dashboard!B9")!.textContent).toMatch(/belongs to the application "finance"/);
  });
});

describe("the push dialog sends what was read, and asks again when a tick moves", () => {
  // SABOTAGE: drop `includeInApplication: includeList(includeState),` from the
  // dialog's publishApplication call (the payload assertion goes red); or drop
  // `includeState` from the refresh effect's question (no second preview).
  it("sends the Rust-supplied hash with the push, after the code was shown and ticked", async () => {
    await act(async () => {
      root.render(<PublishDialog onClose={vi.fn()} data={{}} />);
    });
    await flush();

    // The button linked to the unincluded macro blocks the push, by name.
    expect(container.textContent).toMatch(/The button at Dashboard!B5 runs the macro "New report", which this push does not publish/);
    expect(byTestId("unshipped-macro-links"), "the dialog does not list the button").toBeTruthy();
    const first = tick("include-tick-moduleScript-macro-new");
    expect(first, "the new macro is offered").toBeTruthy();
    expect(first!.disabled, "offered before its code was read").toBe(true);
    const previewsBefore = h.previews.length;

    await click(byTestId("include-show-moduleScript-macro-new"));
    expect(byTestId("include-code-moduleScript-macro-new")!.textContent).toBe("NewReport();");
    await click(tick("include-tick-moduleScript-macro-new"));

    // The tick asked the preview again, carrying the inclusion.
    const asked = h.previews.slice(previewsBefore).map((args) => args[4]);
    expect(asked, "the tick did not ask the preview again").toContainEqual([
      { kind: "moduleScript", id: "macro-new", hash: "rust-hash-1" },
    ]);
    // ...and the answer landed: the macro is added and the button is fine.
    expect(byTestId("added-to-application")!.textContent).toMatch(/New report/);
    expect(byTestId("unshipped-macro-links")).toBeNull();
    // The working-copy diff describes the push with the macro in it.
    expect(h.diffs[h.diffs.length - 1].includeInApplication).toEqual([
      { kind: "moduleScript", id: "macro-new", hash: "rust-hash-1" },
    ]);

    await typeSummary("Adds the new report.");
    await pressPush();

    expect(h.published, "the push was not sent").toHaveLength(1);
    expect(h.published[0].includeInApplication).toEqual([{ kind: "moduleScript", id: "macro-new", hash: "rust-hash-1" }]);
  });

  it("an untouched dialog sends no inclusion, and pushes nothing while a button's macro is left out", async () => {
    await act(async () => {
      root.render(<PublishDialog onClose={vi.fn()} data={{}} />);
    });
    await flush();
    expect(h.previews.every((args) => Array.isArray(args[4]) && (args[4] as unknown[]).length === 0)).toBe(true);
    // Everything else is ready: the button link is the only thing in the way.
    await typeSummary("Adds the new report.");
    await pressPush();
    expect(h.published, "a push with a dead button link was sent").toHaveLength(0);
    expect(container.textContent).toMatch(/tick Include in application next to it, or unlink the button/);
  });

  // SABOTAGE: drop the CALP_PUSH_(INCLUDED_CHANGED|BUTTON_MACRO_NOT_SHIPPED)
  // re-fetch from handlePublish.
  it("a push refused over what was included asks the preview again", async () => {
    await openAndInclude();
    await typeSummary("Adds the new report.");
    h.publishError =
      "CALP_PUSH_INCLUDED_CHANGED: 1 item(s) you ticked \"Include in application\" for cannot be published as you reviewed them -- 'New report': it changed since you reviewed it.";
    const before = h.previews.length;
    await pressPush();
    expect(h.published).toHaveLength(1);
    expect(container.textContent).toMatch(/it changed since you reviewed it/);
    expect(h.previews.length, "the refusal did not fetch the answer again").toBeGreaterThan(before);
  });

  // THE TICK BELONGS TO ONE PUSH. The dialog is non-modal and re-openable, so
  // "shown again" is the ordinary path. A tick that survived the push that
  // shipped its macro named an item that is part of the application now: the
  // next push asked for it again, Rust refused it (CALP_PUSH_INCLUDED_CHANGED),
  // and with the macro in neither list there was no row to untick it from.
  //
  // SABOTAGE: drop the include reset (`setIncludeState(EMPTY_INCLUDE_STATE)`)
  // from the dialog's openCount effect.
  it("a tick never outlives the push that shipped it: the next show asks for nothing", async () => {
    await act(async () => {
      root.render(<PublishDialog onClose={vi.fn()} data={{ __openCount: 1 }} />);
    });
    await flush();
    await click(byTestId("include-show-moduleScript-macro-new"));
    await click(tick("include-tick-moduleScript-macro-new"));
    await typeSummary("Adds the new report.");
    await pressPush();
    expect(h.published).toHaveLength(1);
    expect(h.published[0].includeInApplication).toEqual([{ kind: "moduleScript", id: "macro-new", hash: "rust-hash-1" }]);

    // The macro is the application's now. The dialog is shown again.
    h.shipped = true;
    await act(async () => {
      root.render(<PublishDialog onClose={vi.fn()} data={{ __openCount: 2 }} />);
    });
    await flush();
    await typeSummary("Another change.");
    await pressPush();
    expect(h.published, "the second push was not sent").toHaveLength(2);
    expect(h.published[1].includeInApplication, "a shipped item was asked for again").toEqual([]);
  });

  // SABOTAGE: drop <AddedToApplicationList .../> from PublishReportView.
  it("the push report names what the push added", async () => {
    await act(async () => {
      root.render(<PublishReportView report={reportFor([{ kind: "moduleScript", id: "macro-new", hash: "rust-hash-1" }])} />);
    });
    expect(byTestId("added-to-application")!.textContent).toMatch(/Script 'New report'/);
  });
});

describe("the wire mirrors Rust", () => {
  const rustEnum = (file: string, name: string): string[] => {
    const src = read(file);
    const m = src.match(new RegExp(`pub enum ${name} \\{([\\s\\S]*?)\\n\\}`));
    expect(m, `${name} moved`).toBeTruthy();
    return m![1]
      .split("\n")
      .map((l) => l.trim().replace(/,$/, ""))
      .filter((l) => /^[A-Z][A-Za-z]*$/.test(l))
      .map((v) => v[0].toLowerCase() + v.slice(1))
      .sort();
  };
  const tsUnion = (name: string): string[] => {
    const ts = read("src/api/collaboration.ts");
    const m = ts.match(new RegExp(`export type ${name} = ([^;]+);`));
    expect(m, `${name} moved`).toBeTruthy();
    return [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
  };

  it("MacroLinkRemedy and MacroLinkKind carry exactly Rust's variants", () => {
    expect(tsUnion("MacroLinkRemedy")).toEqual(rustEnum("src-tauri/src/held_button_code.rs", "MacroLinkRemedy"));
    expect(tsUnion("MacroLinkKind")).toEqual(rustEnum("src-tauri/src/held_button_code.rs", "MacroLinkKind"));
  });

  it("the fields the dialog reads are the ones Rust sends", () => {
    const rust = read("src-tauri/src/calp_push_scope.rs");
    for (const field of ["pub includable: bool", "pub content_hash: String", "pub code: String", "pub detail: String"]) {
      expect(rust, field).toContain(field);
    }
    const params = read("src-tauri/src/calp_commands.rs");
    expect(params).toContain("pub include_in_application: Vec<crate::calp_push_scope::IncludedItem>,");
    expect(params).toContain("pub added_to_application: Vec<crate::calp_push_scope::WithheldContent>,");
    expect(params).toContain("pub unshipped_macro_links: Vec<crate::held_button_code::UnshippedMacroLinkItem>,");
  });
});
