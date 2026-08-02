//! FILENAME: app/extensions/ScriptableObjects/__tests__/consentTextHonesty.test.ts
// PURPOSE: The package-consent prompt must not describe a sandbox Calcula does
//          not implement.
// CONTEXT: `ScriptConsentDialog` is the last screen before somebody else's code
//          runs in the user's workbook. It claimed scripts "cannot read or
//          write arbitrary cells" and "can only reach the objects they're
//          attached to". Both were false: the whole `sheet.*` family in
//          `scriptHost/allowlist.ts` is `tier: "restricted"`, so cell reads and
//          writes are available to EVERY mounted object script with no
//          capability involved. A consent screen that understates reach is
//          worse than none — the user's "Allow" is answering a different
//          question from the one the code will act on.
//
//          Derived from the ALLOWLIST SOURCE rather than a reconstructed copy,
//          so the day someone changes the tier of a sheet.* row this test says
//          which sentence went stale. Same technique as libraryTrustBadge.test.ts.

import fs from "fs";
import path from "path";
import { describe, it, expect } from "vitest";

const APP_ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(APP_ROOT, rel), "utf8");

/**
 * Strip block comments before matching. A source scanner that matches comments
 * reports the OPPOSITE of the truth here: the comment recording why a false
 * claim was removed quotes the false claim, so an un-stripped scan fails on the
 * very file that was fixed. (The same trap the program's own drift guards fell
 * into — see the scanner-hygiene findings.)
 */
function code(src: string): string {
  // `[^:]` keeps `https://` out of the line-comment rule.
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const ALLOWLIST = read("src/api/scriptHost/allowlist.ts");
const DIALOG = code(read("extensions/ScriptableObjects/components/ScriptConsentDialog.tsx"));
const EXT_INDEX = code(read("extensions/ScriptableObjects/index.ts"));

/** The tier an ALLOWLIST row declares, read out of the source. */
function tierOf(method: string): string | null {
  const row = ALLOWLIST.match(
    new RegExp(`"${method.replace(".", "\\.")}":\\s*\\{[^}]*?tier:\\s*"([a-z]+)"`, "s"),
  );
  return row ? row[1] : null;
}

describe("ScriptConsentDialog states the real grid reach", () => {
  // The premise. If this ever fails, the dialog text below may legitimately
  // need to change — but it must change deliberately, not drift.
  it("cell read and write really are restricted-tier (no capability)", () => {
    expect(tierOf("sheet.getCellValue")).toBe("restricted");
    expect(tierOf("sheet.setCellValue")).toBe("restricted");
    expect(tierOf("sheet.getRangeValues")).toBe("restricted");
    expect(tierOf("sheet.setRangeValues")).toBe("restricted");
    // ...and none of them is gated by a capability, which is what would have
    // made "anything not listed stays blocked" cover them.
    for (const m of ["sheet.getCellValue", "sheet.setCellValue"]) {
      const row = ALLOWLIST.match(new RegExp(`"${m.replace(".", "\\.")}":\\s*\\{[^}]*\\}`, "s"));
      expect(row, `${m} row not found`).toBeTruthy();
      expect(row![0]).not.toContain("capability:");
    }
  });

  it("no longer claims scripts cannot read or write cells", () => {
    expect(DIALOG).not.toContain("cannot read or write");
    expect(DIALOG).not.toContain("arbitrary cells");
  });

  it("no longer claims scripts can only reach the objects they are attached to", () => {
    expect(DIALOG).not.toMatch(/only\s+reach\s+the\s*\n?\s*objects/);
    expect(DIALOG).not.toMatch(/only\s*\n?\s*access the objects/);
  });

  it("says plainly that a restricted script reads and writes the shown sheet", () => {
    const flat = DIALOG.replace(/\s+/g, " ");
    // Both branches of the prompt — capabilities requested and none requested.
    const claims = flat.match(/read and write the cells of the sheet currently shown/g) ?? [];
    expect(claims.length, "both consent branches must state the grid reach").toBe(2);
    expect(flat).toContain("reach nothing outside this workbook");
  });

  it("keeps the wording the allowlist itself uses for the clamp", () => {
    // The host clamps to the ACTIVE sheet, and the allowlist rows say so. The
    // consent text must not invent a stricter-sounding clamp ("its own sheet",
    // "the sheet it is attached to") that the host does not implement.
    expect(ALLOWLIST).toContain("Read cells on the sheet currently shown");
    expect(DIALOG).not.toContain("bound sheet");
    expect(DIALOG).not.toMatch(/its own sheet/);
  });
});

describe("package consent does not overstate distribution capabilities", () => {
  // A script that arrived in a package is forced to the restricted tier, and
  // every cap.pkg* row is unlocked-tier — so these two can be requested and
  // never exercised. The prompt must say what was asked AND that it is refused.
  it("says publish/subscribe are refused for a packaged script", () => {
    const flat = EXT_INDEX.replace(/\s+/g, " ");
    const refusal = "a script that arrived in a package cannot actually do this — Calcula refuses it — but it asked";
    const publish = flat.match(/"distribution\.publish":\s*"([^"]*)"/);
    const subscribe = flat.match(/"distribution\.subscribe":\s*"([^"]*)"/);
    expect(publish, "distribution.publish phrase missing").toBeTruthy();
    expect(subscribe, "distribution.subscribe phrase missing").toBeTruthy();
    expect(publish![1]).toContain(refusal);
    expect(subscribe![1]).toContain(refusal);
  });

  it("uses the same refusal clause as the Subscribe review", () => {
    const subscribeDialog = read("extensions/Distribution/components/SubscribeDialog.tsx");
    const refusal = "a script that arrived in a package cannot actually do this — Calcula refuses it — but it asked";
    expect(subscribeDialog).toContain(refusal);
  });
});
