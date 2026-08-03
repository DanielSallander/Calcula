//! FILENAME: app/extensions/MacroRecorder/__tests__/commandWiring.test.ts
// PURPOSE: The recorder's registered commands are the ONE implementation of
//          stop / pause / resume / discard, and the status-bar indicator drives
//          them rather than reaching past them into the lib.
// CONTEXT: Found during the integration pass after the four field bugs. The
//          indicator called `abandonRecording()` for Discard while the
//          registered `macroRecorder.cancel` called the weaker
//          `cancelRecording()` — two "discard" behaviours, differing in whether
//          a previously finished recording is dropped from the flow state, with
//          nothing anywhere asserting they agreed. The four non-START commands
//          also had no UI caller at all: script-and-test-only surface, which is
//          the exact dead-plumbing shape this feature was rebuilt to remove.
//
//          These are source-shape assertions on purpose. What is being pinned is
//          "these two call sites resolve to the same behaviour", which is a
//          statement about the WIRING; a behavioural test of either side alone
//          passes happily while they disagree — that is how the drift survived.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const indexSource = fs.readFileSync(path.resolve(__dirname, "../index.ts"), "utf8");
const indicatorSource = fs.readFileSync(
  path.resolve(__dirname, "../components/RecordingIndicator.tsx"),
  "utf8",
);

describe("recorder command wiring", () => {
  it("registers every command id declared in ids.ts", () => {
    for (const key of ["START", "STOP", "PAUSE", "RESUME", "CANCEL", "LIBRARY"]) {
      expect(indexSource).toContain(`context.commands.register(COMMANDS.${key}`);
    }
  });

  it("maps CANCEL to abandonRecording, not the weaker cancelRecording", () => {
    // abandonRecording = cancelRecording + drop the finished recording the
    // review dialog holds. Discarding must do both, or the next Discard leaves
    // a stale result the dialog would re-open.
    expect(indexSource).toMatch(
      /context\.commands\.register\(COMMANDS\.CANCEL,\s*\(\)\s*=>\s*abandonRecording\(\)\)/,
    );
    expect(indexSource).not.toMatch(
      /context\.commands\.register\(COMMANDS\.CANCEL,\s*\(\)\s*=>\s*cancelRecording\(\)\)/,
    );
  });

  it("returns the finishRecording promise from STOP so failures can surface", () => {
    expect(indexSource).toMatch(
      /context\.commands\.register\(COMMANDS\.STOP,\s*\(\)\s*=>\s*finishRecording\(\)\)/,
    );
  });
});

describe("the status-bar indicator drives the commands", () => {
  it("executes commands instead of calling the lib functions directly", () => {
    expect(indicatorSource).toContain('import { CommandRegistry } from "@api"');
    for (const key of ["PAUSE", "RESUME", "STOP", "CANCEL"]) {
      expect(indicatorSource).toContain(`COMMANDS.${key}`);
    }
  });

  it("no longer imports the lib actions it used to call behind the commands", () => {
    for (const bypassed of [
      "pauseRecording",
      "resumeRecording",
      "finishRecording",
      "abandonRecording",
    ]) {
      expect(indicatorSource).not.toMatch(
        new RegExp(`^import[^;]*\\b${bypassed}\\b`, "m"),
      );
    }
  });

  it("keeps the Discard confirmation in the UI, not in the command", () => {
    // A script calling `macroRecorder.cancel` must never be able to raise a
    // modal, so the confirm() belongs to the button and not to the handler.
    expect(indicatorSource).toContain("window.confirm(");
    expect(indexSource).not.toContain("window.confirm(");
  });
});

describe("driving the recorder is never itself recorded", () => {
  it("keeps every command under the ignored `macroRecorder.` prefix", () => {
    const ids = fs.readFileSync(path.resolve(__dirname, "../lib/ids.ts"), "utf8");
    const declared = [...ids.matchAll(/^\s*[A-Z]+:\s*"([^"]+)"/gm)].map((m) => m[1]);
    const commandIds = declared.filter((id) => id.startsWith("macroRecorder."));
    expect(commandIds.length).toBeGreaterThanOrEqual(6);

    const recorder = fs.readFileSync(
      path.resolve(__dirname, "../lib/actionRecorder.ts"),
      "utf8",
    );
    expect(recorder).toContain('commandId.startsWith("macroRecorder.")');
  });
});
