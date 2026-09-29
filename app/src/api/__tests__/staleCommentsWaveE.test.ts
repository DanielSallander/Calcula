//! FILENAME: app/src/api/__tests__/staleCommentsWaveE.test.ts
// PURPOSE: Three comments that stopped being true in wave D say what is true.
// CONTEXT: Y13 (wave E). A comment that describes a mechanism the code no
//          longer has is how the next reader "fixes" the wrong thing:
//            - app/e2e/walker/reset.ts said pane controls are reached by
//              nothing in the walker's reset, their only trigger a
//              `sheet:activated` listener nothing dispatches. The Controls pane
//              refreshes on SHEET_CHANGED since wave D (X13), and the reset's
//              resetToNewWorkbook dispatches `app:sheet-changed` -- the same
//              event.
//            - ScriptableObjects/lib/cellBehaviorUx.ts and Sparklines/index.ts
//              said `ExtensionRegistry.registerCommand` has no unregister; it
//              has had `unregisterCommand` since wave D (X20).

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const APP = path.resolve(__dirname, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(APP, rel), "utf8").replace(/\r\n/g, "\n");

describe("e2e/walker/reset.ts: pane controls and the reset", () => {
  const src = read("e2e/walker/reset.ts");

  it("no longer says their only trigger is a dead `sheet:activated` listener", () => {
    expect(src).not.toMatch(/only other trigger is a `sheet:activated` listener/);
    expect(src).not.toMatch(/nothing in the reset reaches them at all/);
  });

  it("says what reaches them now, and the claim is true", () => {
    expect(src).toMatch(/AFTER_NEW/);
    expect(src).toMatch(/newFile/);
    // ...the Controls pane does refresh on AFTER_NEW (and on SHEET_CHANGED)...
    const pane = read("extensions/ControlsPane/index.ts");
    expect(pane).toMatch(/for \(const evt of \[AppEvents\.AFTER_OPEN, AppEvents\.AFTER_NEW\] as const\)/);
    expect(pane).toMatch(/onAppEvent\(AppEvents\.SHEET_CHANGED, handleSheetChanged\)/);
    // ...and the reset runs the app's own newFile (BUG-0205), which announces
    // AFTER_NEW -- never a raw new_file.
    const reset = read("e2e/helpers/screenshots.ts");
    expect(reset).toMatch(/await fileApi\.newFile\(\);/);
    expect(reset).not.toMatch(/invoke\("new_file"/);
  });
});

describe.each([
  "extensions/ScriptableObjects/lib/cellBehaviorUx.ts",
  "extensions/Sparklines/index.ts",
])("%s: registerCommand's unregister", (rel) => {
  it("no longer claims ExtensionRegistry.registerCommand has no unregister", () => {
    expect(read(rel)).not.toMatch(/registerCommand has no unregister/);
  });

  it("and the unregister it now names exists", () => {
    expect(read(rel)).toMatch(/unregisterCommand/);
    expect(read("src/api/extensions.ts")).toMatch(/unregisterCommand\(command: CommandDefinition\): void/);
  });
});
