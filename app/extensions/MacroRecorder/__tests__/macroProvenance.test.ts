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

vi.mock("@api", () => ({
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
  // The real implementations — provenance labelling must agree with the one
  // definition every other transparency surface reads.
  scriptOriginForStoredRecord: (record: { sourcePackage?: string | null }) => {
    const name =
      typeof record.sourcePackage === "string" ? record.sourcePackage.trim() : "";
    return name === "" ? { kind: "local" } : { kind: "package", name };
  },
  originTagTitle: (origin: { kind: string; name?: string }) =>
    origin.kind === "package"
      ? `From package "${origin.name}"`
      : "Authored in this workbook",
}));

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
    expect(macroProvenanceTag("   ")).toBeNull();
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
