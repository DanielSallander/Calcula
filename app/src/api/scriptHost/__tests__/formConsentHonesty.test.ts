//! FILENAME: app/src/api/scriptHost/__tests__/formConsentHonesty.test.ts
// PURPOSE: Pin the consent story a form tells to the reach a form actually has.
// CONTEXT: Release-one forms reuse `ui.dialog` rather than minting a capability
//          id. That is honest ONLY while three things stay true at once:
//            (a) every form row that shows, changes or closes a dialog carries
//                ui.dialog — a form the user never consented to cannot pop;
//            (b) the layout row (`form.define`) carries NONE, because nothing is
//                shown until the script asks to show it;
//            (c) the user-facing ui.dialog sentences keep promising "a dialog"
//                and "your answer". Cell reach is the TIER's — a bound widget
//                reads and writes through the capability-free sheet.*/api.*
//                rows — and the consent screen already says a restricted script
//                reads and writes the sheet on show (consentTextHonesty.test.ts).
//          The day a form row gains reach its sentence does not name, or the
//          shared sentence is edited to promise less than the rows do, this is
//          the test that goes red. Descs are compared as data (the ALLOWLIST is
//          imported); the four consent sentences are compared as SOURCE TEXT,
//          because two of them live in extensions this test must not import.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ALLOWLIST } from "../allowlist";

const APP = resolve(__dirname, "../../../..");
const read = (rel: string) => readFileSync(resolve(APP, rel), "utf8");

/** Every form row that can put something on screen or take it down. */
const DIALOG_ROWS = ["form.show", "form.update", "form.close", "cap.formsShow"] as const;
/** The two rows a person has to ANSWER (class "ui", person-length deadline). */
const SHOW_ROWS = ["form.show", "cap.formsShow"] as const;

describe("form rows carry exactly the capability their consent sentence covers", () => {
  it("every row that shows, changes or closes a form needs ui.dialog", () => {
    for (const name of DIALOG_ROWS) {
      const row = ALLOWLIST[name];
      expect(row, name).toBeDefined();
      expect(row.capability, name).toBe("ui.dialog");
    }
  });

  it("describing the layout needs no capability — nothing is shown yet", () => {
    const row = ALLOWLIST["form.define"];
    expect(row).toBeDefined();
    expect(row.capability).toBeUndefined();
    expect(row.desc).toContain("nothing is shown until it asks to show it");
  });

  it("no form row can put something on screen without ui.dialog", () => {
    // The whole `form.` namespace, read from the ALLOWLIST rather than from a
    // list this test maintains, so a row added later is judged too.
    //
    // The rule is about REACH, not about the prefix: a row that shows, changes
    // or closes a dialog needs the capability the user consented to. A row that
    // only READS workbook data does not — cell reads (`sheet.getCellData`) are
    // capability-free at restricted tier and the consent screen states that
    // reach directly (consentTextHonesty.test.ts). What every such row DOES
    // need is to be a broker row at all, so the read is decided by policy and
    // lands in the audit ring; `form.readControl` exists because reaching the
    // Controls store directly was the one read a form could do unaudited.
    const formRows = Object.keys(ALLOWLIST).filter((k) => k.startsWith("form."));
    expect(formRows.length).toBeGreaterThanOrEqual(5);
    for (const name of formRows) {
      const row = ALLOWLIST[name];
      if (name === "form.define") continue;
      if (row.class === "read") {
        expect(row.capability, `${name} is a read: capability-free like sheet.getCellData`).toBeUndefined();
        expect(row.tier, name).toBe("restricted");
        continue;
      }
      expect(row.capability, name).toBe("ui.dialog");
    }
  });

  it("the control read is a broker row, so a form cannot read the Controls pane unaudited", () => {
    const row = ALLOWLIST["form.readControl"];
    expect(row).toBeDefined();
    expect(row.class).toBe("read");
    expect(row.desc).toContain("Controls pane");
    // It is the ONLY way any script reaches a control value: nothing else in
    // the allowlist offers one, so this row is the whole surface.
    const controlRows = Object.entries(ALLOWLIST).filter(([, p]) => p.desc.includes("Controls pane"));
    expect(controlRows.map(([k]) => k)).toEqual(["form.readControl"]);
  });

  it("the two rows a person must answer are the ui-class ones, and only those", () => {
    for (const name of SHOW_ROWS) expect(ALLOWLIST[name].class, name).toBe("ui");
    expect(ALLOWLIST["form.update"].class).toBe("emit");
    expect(ALLOWLIST["form.close"].class).toBe("emit");
    expect(ALLOWLIST["form.define"].class).toBe("emit");
  });

  it("a show desc promises a dialog and an answer, in the consent sentence's words", () => {
    for (const name of SHOW_ROWS) {
      const desc = ALLOWLIST[name].desc;
      expect(desc, name).toMatch(/dialog/);
      expect(desc, name).toMatch(/answer|entered/);
    }
  });

  it("form.show names its cell reach: what a bound field shows, when it writes, which sheet", () => {
    // Decision 11: a restricted form is pinned to the sheet active at show. The
    // desc is the only place the user is told that before the dialog opens.
    const desc = ALLOWLIST["form.show"].desc;
    expect(desc).toContain("bound to a cell");
    expect(desc).toContain("writes it back when you submit");
    expect(desc).toContain("sheet you were looking at when it opened");
  });

  it("form.show also names the OTHER moment a bound field writes", () => {
    // `writeOn: "change"` — per widget or for the whole form — writes each
    // committed change immediately, and closing the form does not take those
    // writes back. A sentence promising writeback "when you submit" is false
    // for that form, and it is the sentence a distributed script's user reads
    // before deciding whether to let it run.
    const desc = ALLOWLIST["form.show"].desc;
    expect(desc).toContain("as soon as you change it");
    expect(desc).toContain("closing the form does not undo it");
  });

  it("cap.formsShow says whose form it is and on whose behalf", () => {
    const desc = ALLOWLIST["cap.formsShow"].desc;
    expect(desc).toContain("another script's form");
    expect(desc).toContain("on that script's behalf");
  });
});

describe("the four user-facing ui.dialog sentences still promise a dialog and an answer", () => {
  // Pinned as source text: the sentence a person reads on the consent screen is
  // the contract the form rows above are held to. Loosening a sentence ("show
  // you things") or tightening it past what the rows do ("ask one question")
  // both make the pairing dishonest.
  const SENTENCES: Array<[string, string]> = [
    ["src/api/scriptHost/capabilities.ts", `"ui.dialog": "show you a dialog and receive what you enter"`],
    ["extensions/Distribution/components/SubscribeDialog.tsx", `"ui.dialog": "interrupt you with a dialog and read your answer"`],
    ["extensions/Distribution/components/inspector/ScriptsSection.tsx", `"ui.dialog": "interrupt you with a dialog and read your answer"`],
    ["extensions/ScriptableObjects/index.ts", `"ui.dialog": "Interrupt you with a dialog box and read what you answer"`],
  ];

  it.each(SENTENCES)("%s carries its sentence verbatim", (file, sentence) => {
    expect(read(file)).toContain(sentence);
  });

  it("reads the real files, so the comparison cannot pass vacuously", () => {
    expect(read("src/api/scriptHost/capabilities.ts")).toContain("ui.dialog");
    expect(read("extensions/ScriptableObjects/index.ts")).toContain("SCRIPT_FORM_REQUEST_EVENT");
  });
});
