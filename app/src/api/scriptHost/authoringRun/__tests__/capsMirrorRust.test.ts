//! FILENAME: app/src/api/scriptHost/authoringRun/__tests__/capsMirrorRust.test.ts
// PURPOSE: The caps in this module are MIRRORS of the `pub const`s in
//          core/calcula-format/src/features/script_authoring.rs, and the
//          authority direction is fixed Rust -> TypeScript: the renderer can be
//          compromised, so the Rust clamp is the one that holds, and this side
//          may only repeat its numbers.
// CONTEXT: 2026-08-27. The clamp originally capped four fields and left
//          summary/notices/findings/metadata/attempt-count uncapped IN BOTH
//          LANGUAGES — one hostile append under a fresh draft-* id then had no
//          serialized ceiling, survived reload, and the byte-budget loop
//          evicted INNOCENT scripts' history trying to pay for it. Closing the
//          holes doubled the number of constants, and a constant that drifts
//          between the languages re-opens a hole on whichever side got the
//          smaller number. Reading the RUST SOURCE rather than trusting a
//          comment is the `mediaHandles.test.ts` precedent.

import { describe, it, expect } from "vitest";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import {
  MAX_REPLY_CHARS,
  MAX_REASONING_CHARS,
  MAX_INSTRUCTION_CHARS,
  MAX_RUNS_PER_SCRIPT,
  MAX_RUN_CHARS,
  MAX_LOG_BYTES,
  MAX_DETAIL_CHARS,
  MAX_META_CHARS,
  MAX_ATTEMPTS_PER_RUN,
  MAX_NOTICES_PER_RUN,
  MAX_FINDINGS_PER_ATTEMPT,
  MAX_HOOKS_PER_RUN,
} from "../index";

const RUST_FILE = nodePath.resolve(
  __dirname,
  "../../../../../../core/calcula-format/src/features/script_authoring.rs",
);

/** Every cap this module exports, by its Rust twin's name. A cap added on the
 *  Rust side without a row here still fails: the sweep below counts the Rust
 *  file's `MAX_*` consts and compares. */
const MIRROR: Record<string, number> = {
  MAX_REPLY_CHARS,
  MAX_REASONING_CHARS,
  MAX_INSTRUCTION_CHARS,
  MAX_RUNS_PER_SCRIPT,
  MAX_RUN_CHARS,
  MAX_LOG_BYTES,
  MAX_DETAIL_CHARS,
  MAX_META_CHARS,
  MAX_ATTEMPTS_PER_RUN,
  MAX_NOTICES_PER_RUN,
  MAX_FINDINGS_PER_ATTEMPT,
  MAX_HOOKS_PER_RUN,
};

describe("the authoring-run caps mirror script_authoring.rs", () => {
  const rust = nodeFs.readFileSync(RUST_FILE, "utf8");

  it("agrees with every Rust cap, number for number", () => {
    for (const [name, tsValue] of Object.entries(MIRROR)) {
      const m = new RegExp(`pub const ${name}: usize = ([0-9_]+);`).exec(rust);
      expect(m, `${name} not found as a pub const usize in script_authoring.rs`).not.toBeNull();
      const rustValue = Number(m![1].replace(/_/g, ""));
      expect(tsValue, `${name} drifted (Rust is the authority)`).toBe(rustValue);
    }
  });

  it("mirrors EVERY MAX_* cap the Rust file declares — none unmirrored", () => {
    // The failure this closes: a new cap added in Rust with no TS twin leaves
    // the renderer building runs the backend then silently truncates.
    const declared = [...rust.matchAll(/pub const (MAX_[A-Z_]+): usize = /g)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(0);
    expect(new Set(declared).size).toBe(declared.length);
    expect([...declared].sort()).toEqual(Object.keys(MIRROR).sort());
  });
});
