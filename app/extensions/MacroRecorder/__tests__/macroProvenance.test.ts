//! FILENAME: app/extensions/MacroRecorder/__tests__/macroProvenance.test.ts
// PURPOSE: A macro that arrived inside a distributed application is VISIBLY a
//          publisher's, and is RUN as one.
// CONTEXT: A `.calp` may ship MODULE SCRIPTS. `core/calp/src/pull.rs`
//          materializes them into the subscriber's workbook stamped with
//          `source_package`, and `materialize_distributed_scripts`
//          (app/src-tauri/src/calp_commands.rs) writes that stamp into the very
//          map `list_scripts` / `get_script` serve — so this library lists a
//          publisher's macros next to the user's own.
//
//          Two things were missing, and each on its own is enough to break the
//          consent model:
//            1. `listMacroModules` DROPPED `sourcePackage`, so the two were
//               indistinguishable on screen. A user who cannot tell a
//               publisher's macro from their own cannot make the decision the
//               whole model rests on.
//            2. `runMacroModule` asked for the UNLOCKED tier unconditionally,
//               which is the top tier and full cross-sheet reach.
//
//          Two more were found in the follow-up review, and each is worse than
//          a dropped field because the surface was actively saying something
//          untrue:
//            3. RUNNING EDITED TEXT. The Rust consent gate matches by exact
//               source, so a single character typed into the library's textarea
//               made a publisher's macro unrecognisable to it and it ran with
//               no package consent at all. The answer is the fork the gate
//               already documents — see the last describe() block.
//            4. `describeMacroProvenance` promised "it runs at the restricted
//               tier" for macros that take the MODULE runtime, which is a
//               tier-less interpreter. A protection named where none exists is
//               as misleading as a stamp dropped.

import { describe, it, expect, beforeEach, vi } from "vitest";

interface StoredScript {
  id: string;
  name: string;
  description: string | null;
  source: string;
  sourcePackage: string | null;
  /** Workbook-wide, or attached to one sheet. Must survive every write. */
  scope?: { type: string; name?: string };
}

const store = new Map<string, StoredScript>();
const runObjectScriptOnce = vi.fn(async (_o: unknown) => undefined);
const runWorkbookScript = vi.fn(async (_source: string, _file: string) => ({
  type: "success" as const,
  output: [],
  cellsModified: 1,
  durationMs: 1,
  screenUpdating: true,
}));

vi.mock("@api", async () => {
  // The REAL origin rule: a provenance decision in a test must agree with the one
  // definition every gate reads, or the test pins a rule the product does not have.
  const origin = await vi.importActual<typeof import("@api/scriptHost/scriptOrigin")>(
    "@api/scriptHost/scriptOrigin",
  );
  return {
    scriptOriginForStoredRecord: origin.scriptOriginForStoredRecord,
    originTagTitle: origin.originTagTitle,

  listWorkbookScripts: async () =>
    [...store.values()].map((s) => ({ id: s.id, name: s.name })),
  getWorkbookScript: async (id: string) => {
    const found = store.get(id);
    if (!found) throw new Error(`Script '${id}' not found`);
    return found;
  },
  listWorkbookScriptRecords: async () =>
    [...store.values()].map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description ?? null,
      source: s.source,
      sourcePackage: s.sourcePackage,
      loadError: null,
    })),
  parseModuleScriptRuntime: (description: string | null | undefined) => {
    if (typeof description !== "string") return null;
    const match = /\bruntime=(objectScript|notebook)\b/.exec(description);
    return match ? match[1] : null;
  },
  saveWorkbookScript: async (s: StoredScript) => {
    store.set(s.id, { ...s });
  },
  deleteWorkbookScript: async (id: string) => {
    store.delete(id);
  },
  runWorkbookScript: (source: string, file: string) => runWorkbookScript(source, file),
  runObjectScriptOnce: (o: unknown) => runObjectScriptOnce(o),
  };
});

import {
  describeMacroProvenance,
  describeRunRoute,
  forkMacroModule,
  isDistributedMacro,
  listMacroModules,
  macroEditDisposition,
  macroProvenanceTag,
  macroRunAccessLevel,
  runMacroByRef,
  runMacroModule,
  updateMacroModule,
} from "../lib/macroLibrary";

const OBJECT_SCRIPT_DESCRIPTION =
  "Recorded macro · runtime=objectScript · 2 actions · recorded 2026-09-01";

const NOTEBOOK_DESCRIPTION =
  "Recorded macro · runtime=notebook · 2 actions · recorded 2026-09-01";

const PUBLISHER_MACRO: StoredScript = {
  id: "macro-vendor-close",
  name: "Vendor close",
  description: OBJECT_SCRIPT_DESCRIPTION,
  source: "function setup(c){ return c.api.setCellValue(0,0,'owned'); }",
  sourcePackage: "Acme Finance Pack",
};

const MY_MACRO: StoredScript = {
  id: "macro-my-close",
  name: "My close",
  description: OBJECT_SCRIPT_DESCRIPTION,
  source: "function setup(c){ return c.api.setCellValue(1,0,'mine'); }",
  sourcePackage: null,
};

beforeEach(() => {
  store.clear();
  runObjectScriptOnce.mockClear();
  runWorkbookScript.mockClear();
});

// ---------------------------------------------------------------------------
// TRANSPARENCY: the listing says where the code came from
// ---------------------------------------------------------------------------

describe("the library carries each module's origin", () => {
  it("keeps the source package on the listed entry", async () => {
    store.set(PUBLISHER_MACRO.id, PUBLISHER_MACRO);
    store.set(MY_MACRO.id, MY_MACRO);

    const entries = await listMacroModules();
    const theirs = entries.find((e) => e.id === PUBLISHER_MACRO.id)!;
    const mine = entries.find((e) => e.id === MY_MACRO.id)!;

    expect(theirs.sourcePackage).toBe("Acme Finance Pack");
    expect(mine.sourcePackage).toBeNull();
  });

  it("badges the publisher's macro and leaves the user's own unbadged", () => {
    expect(macroProvenanceTag("Acme Finance Pack")).toBe("Acme Finance Pack");
    expect(macroProvenanceTag(null)).toBeNull();
    // A blank stamp is a DISTRIBUTED record with no usable name — the same
    // rule every gate applies — so the chip shows the placeholder the mount
    // gate is asked about, never "local".
    expect(macroProvenanceTag("   ")).toBe("(unknown package)");
    expect(isDistributedMacro("   ")).toBe(true);
    expect(isDistributedMacro("Acme Finance Pack")).toBe(true);
    expect(isDistributedMacro(null)).toBe(false);
  });

  it("says in words that the user did not write it, and names the application", () => {
    const note = describeMacroProvenance("Acme Finance Pack", OBJECT_SCRIPT_DESCRIPTION)!;
    expect(note).toContain("Acme Finance Pack");
    expect(note).toMatch(/you did not write this macro/i);
    expect(note).toMatch(/restricted/i);
    expect(describeMacroProvenance(null, OBJECT_SCRIPT_DESCRIPTION)).toBeNull();
  });

  // §6: the note used to promise "it runs at the restricted tier" for EVERY
  // distributed macro. The module runtime is the Rust QuickJS interpreter: it
  // has no tiers, no `api` object and no capability broker, so there is nothing
  // there to be restricted. Naming a protection that does not exist on the
  // route the user is about to take is the same class of untruth as dropping
  // the stamp — it tells them the code is fenced when the fence is elsewhere.
  it("does not promise a TIER on the route that has none", () => {
    const moduleRoute = describeMacroProvenance("Acme Finance Pack", NOTEBOOK_DESCRIPTION)!;
    expect(moduleRoute).toContain("Acme Finance Pack");
    expect(moduleRoute).toMatch(/you did not write this macro/i);
    // No tier is CLAIMED for it — not "restricted", not any other. (The word
    // "tier" itself may appear: the sentence exists to say the route has none.)
    expect(moduleRoute).not.toMatch(/restricted/i);
    expect(moduleRoute).not.toMatch(/runs at (the )?\w+ tier/i);
    expect(moduleRoute).toMatch(/no tiers at all/i);
    // What IS true there: the Rust consent gate, which refuses the run outright.
    expect(moduleRoute).toMatch(/consent/i);
    expect(moduleRoute).toMatch(/approved/i);

    // ...and an UNMARKED module takes the module runtime too, so it gets the
    // same sentence — "no marker" is not "assume object script".
    expect(describeMacroProvenance("Acme Finance Pack", null)).toBe(moduleRoute);
  });

  it("still names the restricted tier on the route that HAS one", () => {
    const objectRoute = describeMacroProvenance("Acme Finance Pack", OBJECT_SCRIPT_DESCRIPTION)!;
    expect(objectRoute).toMatch(/RESTRICTED object script/i);
    expect(objectRoute).toMatch(/never unlocked/i);
  });

  // OWNER DECISION B (2026-09-30). The sentence must be true on the day it
  // ships: the Macros dialog, a button's click (ownerB follow-ups F1/F6) and
  // the command line's `run` (F2) carry a pass, so they are the doors named as
  // giving cell access. The next test derives both lists from the mint census.
  it("names the cell access a run YOU start gets, the doors that give it, and its limits", () => {
    const objectRoute = describeMacroProvenance("Acme Finance Pack", OBJECT_SCRIPT_DESCRIPTION)!;
    expect(objectRoute).toContain(
      "When you run it yourself from Developer ▸ Macros ▸ Run, by clicking a button that runs it, " +
        "or from the command line, it may also read and change cells on any sheet",
    );
    expect(objectRoute).toContain("read and change cells on any sheet");
    expect(objectRoute).toContain("the same cell access an approved module macro has");
    // A granted fill copies the band's styles (module parity: fill_range clones
    // value + style), so "no formatting" alone would be false; every OTHER
    // formatting route -- api.setRangeFormat and the restricted sheet.* format
    // rows -- is refused to such a run (explicitRunGrant.ts).
    expect(objectRoute).toContain(
      "where filling a range also copies the formatting of the cells it fills from",
    );
    expect(objectRoute).toContain("no other formatting, no sheet structure, no files, no other macros or commands");
    expect(objectRoute).not.toContain("no formatting,");
    // Not "no cell access": every restricted realm reaches the sheet on screen
    // (the restricted sheet.* rows), and so does this one.
    expect(objectRoute).toContain(
      "Started any other way -- by another script, for example -- it has " +
        "only what every restricted script has: the sheet on screen.",
    );
    expect(objectRoute).not.toMatch(/no cell access/);
    // The module route never had a tier to lift.
    expect(describeMacroProvenance("Acme Finance Pack", NOTEBOOK_DESCRIPTION)).not.toMatch(/cell access/);
  });

  // OWNER DECISION B, follow-up F10: the module runtime cannot run an
  // application's macro with less than its full reach, so a run a script
  // starts is REFUSED there (Rust: APPLICATION_MACRO_NOT_STARTED_BY_YOU). The
  // note must say so, and must name every person's act that does run it --
  // the three doors and the user's own view bookmark (Rust `RunDoor`).
  // SABOTAGE: drop the "It also runs only when you start it yourself ..."
  // sentence from describeMacroProvenance's module branch -> red.
  it("the module route says a script cannot start it, and names every person's act that can", () => {
    const moduleRoute = describeMacroProvenance("Acme Finance Pack", NOTEBOOK_DESCRIPTION)!;
    expect(moduleRoute).toContain("It also runs only when you start it yourself");
    expect(moduleRoute).toContain("a run another script starts is refused");
    for (const door of ["Developer ▸ Macros ▸ Run", "a button that runs it", "the command line", "a view bookmark of your own"]) {
      expect(moduleRoute, door).toContain(door);
    }
  });

  // THE SENTENCE NAMES THE DOORS THAT MINT, AND NO OTHERS. Which doors give a
  // run cell access is decided by WHERE a pass is minted (the census in
  // src/api/__tests__/explicitMacroRun.test.ts), so the doors the sentence
  // promises are read from the same production source: a door that mints must
  // be named in "when you run it yourself", every other door in "started any
  // other way". Wiring the command line (F2) turns this red until the
  // sentence moves it.
  // SABOTAGE: put "its button" back into the "Started any other way" clause
  // (macroLibrary.ts) -> the button, which mints, is named as not giving it.
  it("the doors it names are exactly the doors that mint a pass", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const appRoot = path.resolve(__dirname, "..", "..", "..");
    const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const minted = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "__tests__") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) {
          for (const m of strip(fs.readFileSync(full, "utf8")).matchAll(/mintExplicitMacroRun\("(\w+)"/g)) {
            minted.add(m[1]);
          }
        }
      }
    };
    walk(path.join(appRoot, "src"));
    walk(path.join(appRoot, "extensions"));
    // Every door the pass module knows, and how the sentence names it.
    const PHRASE: Record<string, string> = {
      macrosDialog: "Developer ▸ Macros ▸ Run",
      button: "clicking a button that runs it",
      commandLine: "the command line",
    };
    const passModule = fs.readFileSync(path.join(appRoot, "src/api/explicitMacroRun.ts"), "utf8");
    const union = passModule.match(/export type ExplicitMacroRunDoor = ([^;]+);/)?.[1] ?? "";
    const doors = [...union.matchAll(/"(\w+)"/g)].map((m) => m[1]).sort();
    expect(doors, "a door the sentence has no words for").toEqual(Object.keys(PHRASE).sort());
    // Positive control: the census sees the two doors wired today.
    expect([...minted].sort()).toEqual(expect.arrayContaining(["button", "macrosDialog"]));

    const sentence = describeMacroProvenance("Acme Finance Pack", OBJECT_SCRIPT_DESCRIPTION)!;
    const yours = sentence.slice(sentence.indexOf("When you run it yourself"), sentence.indexOf("it may also read"));
    const other = sentence.slice(sentence.indexOf("Started any other way"));
    expect(yours.length, "the 'you run it yourself' clause moved").toBeGreaterThan(0);
    expect(other.length, "the 'started any other way' clause moved").toBeGreaterThan(0);
    for (const door of doors) {
      const phrase = PHRASE[door];
      if (minted.has(door)) {
        expect(yours, `"${door}" mints a pass, so the sentence must say it gives cell access`).toContain(phrase);
        expect(other, `"${door}" mints a pass, yet the sentence says it does not`).not.toContain(phrase);
      } else {
        expect(other, `"${door}" mints no pass, so the sentence must say it does not give cell access`).toContain(phrase);
        expect(yours, `"${door}" mints no pass, yet the sentence promises cell access`).not.toContain(phrase);
      }
    }
  });

  // THE SENTENCE IS BOUND TO THE BROKER. "no other formatting" and "the sheet on
  // screen" are claims about what the broker admits, so they are read from it:
  // a granted run (explicitRun present) reaches no formatting write -- neither
  // an unlocked api.* row nor a restricted sheet.* row -- and an ungranted
  // restricted realm is admitted the sheet on screen.
  // SABOTAGE: delete "sheet.setRangeFormat" from EXPLICIT_RUN_REFUSED_FORMAT_METHODS
  // (explicitRunGrant.ts) -> `reachable` names it and this goes red.
  it("its limits are the broker's: no formatting write for a granted run, the sheet on screen without one", async () => {
    const { ALLOWLIST } = await import("@api/scriptHost/allowlist");
    const { decidePolicy } = await import("@api/scriptHost/brokerPolicy");
    const { explicitRunAdmits, explicitRunRestrictedRefusal } = await import(
      "@api/scriptHost/explicitRunGrant"
    );
    const none = new Set<never>();
    const granted = { tier: "restricted" as const, explicitRun: { cells: true }, grants: none, declaredCapabilities: none };
    const formattingWrites = Object.keys(ALLOWLIST).filter(
      (m) => /Format|Style/.test(m) && ALLOWLIST[m].class === "mutate",
    );
    // Positive control: the filter sees both families.
    expect(formattingWrites).toEqual(
      expect.arrayContaining(["api.setRangeFormat", "api.applyNamedStyle", "sheet.setRangeFormat", "sheet.clearRangeFormat"]),
    );
    const reachable = formattingWrites.filter((m) =>
      ALLOWLIST[m].tier === "unlocked" ? explicitRunAdmits(granted, m) : explicitRunRestrictedRefusal(m) === null,
    );
    expect(reachable, "a granted run can still format through these").toEqual([]);

    const plain = { tier: "restricted" as const, grants: none, declaredCapabilities: none };
    expect(decidePolicy(plain, "sheet.getCellValue", [0, 0]).admitted).toBe(true);
    expect(decidePolicy(plain, "sheet.setCellValue", [0, 0, "x"]).admitted).toBe(true);
  });

  // The route is chosen by the module's DESCRIPTION, which a `.calp` ships with
  // the module — publisher content. Only one of the two routes used to ask for
  // consent, so a publisher wrote `runtime=objectScript` in their own
  // description and their code ran in a real worker realm with the user never
  // having agreed to that application. Describing the tier while the permission
  // behind it did not exist was the more dangerous half of that: a user reading
  // it concludes they are protected by a decision they were never offered.
  it("promises CONSENT on BOTH routes, because both routes now require it", () => {
    for (const description of [OBJECT_SCRIPT_DESCRIPTION, NOTEBOOK_DESCRIPTION, null]) {
      const note = describeMacroProvenance("Acme Finance Pack", description)!;
      expect(note, `route note for ${description}`).toMatch(/approved/i);
    }
    const objectRoute = describeMacroProvenance("Acme Finance Pack", OBJECT_SCRIPT_DESCRIPTION)!;
    expect(objectRoute).toMatch(/does not run unless you have approved/i);
  });

  it("says the object-script route refuses unapproved code, not merely that it fences it", () => {
    const theirs = describeRunRoute(OBJECT_SCRIPT_DESCRIPTION, "Acme Finance Pack");
    expect(theirs).toMatch(/does not run at all unless you have approved/i);
    // The user's own macro is not gated and must not be told it is.
    expect(describeRunRoute(OBJECT_SCRIPT_DESCRIPTION, null)).not.toMatch(/approved/i);
  });

  it("the run-route note stops promising an UNLOCKED mount for distributed code", () => {
    const mine = describeRunRoute(OBJECT_SCRIPT_DESCRIPTION, null);
    expect(mine).toMatch(/unlocked object script/i);

    const theirs = describeRunRoute(OBJECT_SCRIPT_DESCRIPTION, "Acme Finance Pack");
    expect(theirs).toMatch(/restricted object script/i);
    expect(theirs).not.toMatch(/temporary unlocked object script/i);
  });
});

// ---------------------------------------------------------------------------
// THE RUN: tier and identity come from the record
// ---------------------------------------------------------------------------

describe("running a macro that arrived in an application", () => {
  it("asks for the RESTRICTED tier, not unlocked", async () => {
    store.set(PUBLISHER_MACRO.id, PUBLISHER_MACRO);

    await runMacroModule({
      id: PUBLISHER_MACRO.id,
      name: PUBLISHER_MACRO.name,
      source: PUBLISHER_MACRO.source,
      description: PUBLISHER_MACRO.description,
      sourcePackage: PUBLISHER_MACRO.sourcePackage,
      storedSource: PUBLISHER_MACRO.source,
    });

    expect(runObjectScriptOnce).toHaveBeenCalledTimes(1);
    expect(runObjectScriptOnce.mock.calls[0][0]).toMatchObject({
      accessLevel: "restricted",
    });
  });

  it("names the stored record, so the run is filed against the publisher's artifact", async () => {
    store.set(PUBLISHER_MACRO.id, PUBLISHER_MACRO);

    await runMacroModule({
      id: PUBLISHER_MACRO.id,
      name: PUBLISHER_MACRO.name,
      source: PUBLISHER_MACRO.source,
      description: PUBLISHER_MACRO.description,
      sourcePackage: PUBLISHER_MACRO.sourcePackage,
      storedSource: PUBLISHER_MACRO.source,
    });

    // Without the id the runner has only the source to go on, and the id is
    // what keeps a run attributable to the record it came from.
    expect(runObjectScriptOnce.mock.calls[0][0]).toMatchObject({
      scriptId: PUBLISHER_MACRO.id,
    });
  });

  it("a button that LINKS a distributed macro resolves its provenance at click time", async () => {
    store.set(PUBLISHER_MACRO.id, PUBLISHER_MACRO);

    const outcome = await runMacroByRef(PUBLISHER_MACRO.id);

    expect(outcome.status).toBe("ran");
    expect(runObjectScriptOnce.mock.calls[0][0]).toMatchObject({
      accessLevel: "restricted",
      scriptId: PUBLISHER_MACRO.id,
    });
  });

  it("a button link runs the STORED bytes, so the fork rule never fires on it", async () => {
    store.set(PUBLISHER_MACRO.id, PUBLISHER_MACRO);

    const outcome = await runMacroByRef(PUBLISHER_MACRO.id);

    // The link reads the record and runs what it read: stored === executed, so
    // the refusal below can never strand a button that was working.
    expect(outcome).toEqual({ status: "ran", name: PUBLISHER_MACRO.name });
  });

  it("the user's own macro still runs unlocked", async () => {
    store.set(MY_MACRO.id, MY_MACRO);

    await runMacroModule({
      id: MY_MACRO.id,
      name: MY_MACRO.name,
      source: MY_MACRO.source,
      description: MY_MACRO.description,
      sourcePackage: MY_MACRO.sourcePackage,
      storedSource: MY_MACRO.source,
    });

    expect(runObjectScriptOnce.mock.calls[0][0]).toMatchObject({
      accessLevel: "unlocked",
    });
  });

  it("the user's own macro runs whatever they typed — an edit is theirs to make", async () => {
    store.set(MY_MACRO.id, MY_MACRO);

    const result = await runMacroModule({
      id: MY_MACRO.id,
      name: MY_MACRO.name,
      source: `${MY_MACRO.source}\n// my edit`,
      description: MY_MACRO.description,
      sourcePackage: null,
      storedSource: MY_MACRO.source,
    });

    expect(result.type).toBe("success");
    expect(runObjectScriptOnce).toHaveBeenCalledTimes(1);
  });

  it("macroRunAccessLevel is the one derivation both callers use", () => {
    expect(macroRunAccessLevel("Acme Finance Pack")).toBe("restricted");
    expect(macroRunAccessLevel(null)).toBe("unlocked");
    expect(macroRunAccessLevel(undefined)).toBe("unlocked");
    // A blank stamp used to answer "unlocked" here — the run tier of a record
    // every gate treats as distributed. It is restricted, like any other.
    expect(macroRunAccessLevel("   ")).toBe("restricted");
  });
});

// ---------------------------------------------------------------------------
// §4: EDITING A PUBLISHER'S MACRO — the content-keyed bypass, and the fork
//
// The Rust gate `distributed_module_refusal` matches by EXACT SOURCE: it looks
// for a stored module holding the bytes about to run, and refuses when that
// module carries a package the user has not consented to. Source that matches
// nothing stored is treated as an ad-hoc editor run and allowed through. So
// typing one character into the Macro Library textarea and pressing Run took a
// publisher's macro clean past package consent — the strongest bypass in this
// whole surface, and the cheapest to perform.
//
// The answer is the escape hatch the gate already documents: a LOCAL record
// holding the source authorises it. A fork makes that record real.
// ---------------------------------------------------------------------------

describe("editing a macro that arrived in an application", () => {
  it("REFUSES to run edited text under the publisher's name (module runtime)", async () => {
    const notebookMacro: StoredScript = {
      ...PUBLISHER_MACRO,
      description: NOTEBOOK_DESCRIPTION,
      source: "Calcula.setCellValue(0,0,'theirs');",
    };
    store.set(notebookMacro.id, notebookMacro);

    const result = await runMacroModule({
      id: notebookMacro.id,
      name: notebookMacro.name,
      source: "Calcula.setCellValue(0,0,'mine');",
      description: notebookMacro.description,
      sourcePackage: notebookMacro.sourcePackage,
      storedSource: notebookMacro.source,
    });

    // THE BYPASS: this is the call that reached `run_script` with source the
    // Rust gate could not recognise, so no owner was found and nothing refused.
    expect(runWorkbookScript).not.toHaveBeenCalled();
    expect(result.type).toBe("error");
    if (result.type === "error") {
      expect(result.message).toContain("Acme Finance Pack");
      expect(result.message).toMatch(/Save as my copy/i);
    }
  });

  it("REFUSES it on the object-script route too", async () => {
    store.set(PUBLISHER_MACRO.id, PUBLISHER_MACRO);

    const result = await runMacroModule({
      id: PUBLISHER_MACRO.id,
      name: PUBLISHER_MACRO.name,
      source: `${PUBLISHER_MACRO.source}\n// edited`,
      description: PUBLISHER_MACRO.description,
      sourcePackage: PUBLISHER_MACRO.sourcePackage,
      storedSource: PUBLISHER_MACRO.source,
    });

    // Not an escalation (the tier is still derived), but it is the publisher's
    // identity executing text the publisher never wrote, and the audit entry
    // would name their application for it.
    expect(runObjectScriptOnce).not.toHaveBeenCalled();
    expect(result.type).toBe("error");
  });

  it("fails CLOSED when the caller cannot say what the store holds", async () => {
    store.set(PUBLISHER_MACRO.id, PUBLISHER_MACRO);

    const result = await runMacroModule({
      id: PUBLISHER_MACRO.id,
      name: PUBLISHER_MACRO.name,
      source: PUBLISHER_MACRO.source,
      description: PUBLISHER_MACRO.description,
      sourcePackage: PUBLISHER_MACRO.sourcePackage,
      storedSource: null,
    });

    expect(result.type).toBe("error");
    expect(runObjectScriptOnce).not.toHaveBeenCalled();
    expect(runWorkbookScript).not.toHaveBeenCalled();
  });

  it("the disposition is FORK for an edited publisher macro, in place otherwise", () => {
    expect(
      macroEditDisposition({
        sourcePackage: "Acme Finance Pack",
        storedSource: "a",
        draftSource: "b",
      }),
    ).toEqual({ kind: "fork", packageName: "Acme Finance Pack" });

    // A RENAME changes no executable byte, so it writes back in place.
    expect(
      macroEditDisposition({
        sourcePackage: "Acme Finance Pack",
        storedSource: "a",
        draftSource: "a",
      }),
    ).toEqual({ kind: "inPlace" });

    // The user's own code is theirs to edit.
    expect(
      macroEditDisposition({ sourcePackage: null, storedSource: "a", draftSource: "b" }),
    ).toEqual({ kind: "inPlace" });
  });

  it("forks into a record that is the USER'S — new id, no stamp, publisher untouched", async () => {
    store.set(PUBLISHER_MACRO.id, PUBLISHER_MACRO);
    const edited = `${PUBLISHER_MACRO.source}\n// my change`;

    const copy = await forkMacroModule({
      packageName: "Acme Finance Pack",
      name: PUBLISHER_MACRO.name,
      source: edited,
      description: PUBLISHER_MACRO.description,
      scope: PUBLISHER_MACRO.scope,
    });

    expect(copy.id).not.toBe(PUBLISHER_MACRO.id);
    const stored = store.get(copy.id)!;
    expect(stored.source).toBe(edited);
    // No stamp at all: `sticky_source_package` has nothing to carry forward for
    // an id that did not exist, so this record is local from its first byte.
    expect(stored.sourcePackage ?? null).toBeNull();
    // The runtime marker survives, or the copy would route to the wrong
    // interpreter; the lineage is written down beside it rather than hidden.
    expect(stored.description).toContain("runtime=objectScript");
    expect(stored.description).toContain("Acme Finance Pack");

    // THE PUBLISHER'S RECORD IS BYTE-FOR-BYTE AS IT ARRIVED — so a refresh from
    // the application still matches the consent hash the user approved.
    expect(store.get(PUBLISHER_MACRO.id)).toEqual(PUBLISHER_MACRO);
  });

  it("the fork then RUNS — as the user's own code, at their own tier", async () => {
    store.set(PUBLISHER_MACRO.id, PUBLISHER_MACRO);
    const edited = `${PUBLISHER_MACRO.source}\n// my change`;
    const copy = await forkMacroModule({
      packageName: "Acme Finance Pack",
      name: PUBLISHER_MACRO.name,
      source: edited,
      description: PUBLISHER_MACRO.description,
      scope: PUBLISHER_MACRO.scope,
    });

    const record = store.get(copy.id)!;
    const result = await runMacroModule({
      id: record.id,
      name: record.name,
      source: record.source,
      description: record.description,
      sourcePackage: record.sourcePackage,
      storedSource: record.source,
    });

    expect(result.type).toBe("success");
    expect(runObjectScriptOnce.mock.calls[0][0]).toMatchObject({
      accessLevel: "unlocked",
      scriptId: copy.id,
    });
  });

  it("names the copy without colliding with what is already there", async () => {
    store.set(PUBLISHER_MACRO.id, PUBLISHER_MACRO);
    const first = await forkMacroModule({
      packageName: "Acme Finance Pack",
      name: PUBLISHER_MACRO.name,
      source: "one",
      description: PUBLISHER_MACRO.description,
      scope: PUBLISHER_MACRO.scope,
    });
    const second = await forkMacroModule({
      packageName: "Acme Finance Pack",
      name: PUBLISHER_MACRO.name,
      source: "two",
      description: PUBLISHER_MACRO.description,
      scope: PUBLISHER_MACRO.scope,
    });

    expect(first.id).not.toBe(second.id);
    expect(first.name).not.toBe(second.name);
    expect(store.size).toBe(3);
  });

  it("a RENAME writes back in place and KEEPS the stamp", async () => {
    store.set(PUBLISHER_MACRO.id, PUBLISHER_MACRO);

    await updateMacroModule({
      id: PUBLISHER_MACRO.id,
      name: "Vendor close (renamed)",
      source: PUBLISHER_MACRO.source,
      description: PUBLISHER_MACRO.description,
      // What the caller READ from the record — never omitted, which is how a
      // rename used to launder a publisher's macro into local code.
      sourcePackage: PUBLISHER_MACRO.sourcePackage,
      scope: PUBLISHER_MACRO.scope,
    });

    const stored = store.get(PUBLISHER_MACRO.id)!;
    expect(stored.name).toBe("Vendor close (renamed)");
    expect(stored.sourcePackage).toBe("Acme Finance Pack");
  });

  // THE SAME DEFECT ONE FIELD OVER. `sourcePackage` was made a required
  // parameter because omitting it laundered a publisher's macro. `scope` was
  // still a hard-coded `{ type: "workbook" }` inside both writes, so a RENAME —
  // which is supposed to change no byte that executes — moved a sheet-scoped
  // module to the whole workbook, where it resolves from every sheet. Nothing
  // announced it and nothing could undo it, because the old scope was gone.
  const SHEET_SCOPED: StoredScript = {
    id: "macro-sheet-scoped",
    name: "Budget close",
    description: OBJECT_SCRIPT_DESCRIPTION,
    source: "function setup(c){ return c.api.setCellValue(0,0,'scoped'); }",
    sourcePackage: "Acme Finance Pack",
    scope: { type: "sheet", name: "Budget" },
  };

  it("a rename carries the record's SHEET SCOPE, it does not re-assert workbook", async () => {
    store.set(SHEET_SCOPED.id, { ...SHEET_SCOPED });

    await updateMacroModule({
      id: SHEET_SCOPED.id,
      name: "Budget close (renamed)",
      source: SHEET_SCOPED.source,
      description: SHEET_SCOPED.description,
      sourcePackage: SHEET_SCOPED.sourcePackage,
      scope: SHEET_SCOPED.scope,
    });

    expect(store.get(SHEET_SCOPED.id)!.scope).toEqual({ type: "sheet", name: "Budget" });
  });

  it("the fork gives the copy the original's scope, not a wider one", async () => {
    store.set(SHEET_SCOPED.id, { ...SHEET_SCOPED });

    const copy = await forkMacroModule({
      packageName: "Acme Finance Pack",
      name: SHEET_SCOPED.name,
      source: `${SHEET_SCOPED.source}\n// mine`,
      description: SHEET_SCOPED.description,
      scope: SHEET_SCOPED.scope,
    });

    expect(store.get(copy.id)!.scope).toEqual({ type: "sheet", name: "Budget" });
    // The copy is still the USER'S — the scope travels, the stamp does not.
    expect(store.get(copy.id)!.sourcePackage ?? null).toBeNull();
  });
});
