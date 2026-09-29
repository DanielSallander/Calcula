//! FILENAME: app/extensions/Checkbox/__tests__/checkboxToggleCommandDoc.test.ts
// PURPOSE: The comment on CHECKBOX_TOGGLE_COMMAND tells the truth about who
//          reaches the command: bare Space DOES toggle a legacy checkbox.
// CONTEXT: Z11 (wave F; wave E core fix-up NEEDS 2). The comment said Space
//          never toggles a legacy style-flag checkbox because Core's
//          handleCommand logs "Unknown command" -- true until wave E (Y9)
//          routed handleCommand's default through executeCommandAnywhere, which
//          reaches this extension-registry command. A reader trusting the
//          comment would "fix" a working door. The behaviour itself is pinned
//          by src/core/components/Spreadsheet/__tests__/spaceRunsExtensionCommand
//          .test.tsx.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const SOURCE = fs.readFileSync(path.resolve(__dirname, "../index.ts"), "utf8");
const DOC = (() => {
  const at = SOURCE.indexOf("const CHECKBOX_TOGGLE_COMMAND");
  return SOURCE.slice(SOURCE.lastIndexOf("/**", at), at);
})();

describe("the checkbox.toggle command's comment", () => {
  it("no longer claims Space never toggles a legacy checkbox", () => {
    expect(DOC.length, "the comment above CHECKBOX_TOGGLE_COMMAND was not found").toBeGreaterThan(0);
    expect(DOC, "the stale claim is back").not.toMatch(/never toggles a legacy/);
    expect(DOC, "the stale claim is back").not.toMatch(/NOT through Spacebar/);
  });

  it("names the doors that DO reach it: Space through executeCommandAnywhere, and a button", () => {
    expect(DOC).toMatch(/Space/);
    expect(DOC).toMatch(/executeCommandAnywhere/);
    expect(DOC).toMatch(/button\.ts/);
  });
});
