//! FILENAME: app/src/api/__tests__/beginUndoTransactionAnswer.test.ts
// PURPOSE: X5 (wave D) and its review fix-up (F1/F3). `begin_undo_transaction`
//          answers whether THIS begin OPENED the backend transaction -- with a
//          TICKET -- or JOINED one another caller holds open (null), decided
//          under the one lock that opens it (app/src-tauri/src/undo_commands.rs).
//          Every caller that pairs a begin with a close decides by that answer
//          AND presents the ticket: the backend then closes the slot only while
//          it still holds that very transaction. A bare "I opened it" record
//          went stale the moment a sheet add / rename / move / copy or a
//          document swap ended the transaction, and the opener's close then
//          landed on whatever a stranger had opened since.
//          (X5 itself: the wrapper was typed `Promise<void>`, so the callers
//          that honour the answer had to read it as `unknown`.)
// CONTEXT: The type gate cannot see a test file (tests are excluded from
//          `check-types`), so the declaration and its readers are pinned by
//          source; the wire (what is sent, what is read) by runtime tests over
//          a mocked `invoke`.

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

const invoke = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => undefined);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
}));

import {
  beginUndoTransaction,
  cancelUndoTransaction,
  commitUndoTransaction,
  readUndoBeginAnswer,
} from "../../core/lib/tauri-api";

const SRC = path.resolve(__dirname, "../..");
function read(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), "utf8");
}

beforeEach(() => {
  invoke.mockReset();
});

describe("beginUndoTransaction answers a ticket when it opened (X5, review F1/F3)", () => {
  it("passes the backend's answer through unchanged (positive control)", async () => {
    invoke.mockResolvedValueOnce(7);
    await expect(beginUndoTransaction("Opened")).resolves.toBe(7);
    invoke.mockResolvedValueOnce(null);
    await expect(beginUndoTransaction("Joined")).resolves.toBe(null);
    expect(invoke).toHaveBeenCalledWith("begin_undo_transaction", { description: "Joined" });
  });

  it("is DECLARED to answer a ticket or null, so no caller has to read it as unknown", () => {
    const api = read("core/lib/tauri-api.ts");
    expect(
      api,
      "beginUndoTransaction does not declare the ticket its closes must present",
    ).toMatch(
      /export async function beginUndoTransaction\(description: string\): Promise<UndoTransactionTicket \| null> \{/,
    );
    expect(api).toMatch(/invoke<UndoTransactionTicket \| null>\("begin_undo_transaction", \{ description \}\)/);
  });

  it("commit and cancel PRESENT the ticket they are given, and stay bare without one", async () => {
    await commitUndoTransaction(7);
    await cancelUndoTransaction(8);
    expect(invoke, "the commit did not send its ticket: it would close whatever is open").toHaveBeenCalledWith(
      "commit_undo_transaction",
      { ticket: 7 },
    );
    expect(invoke, "the cancel did not send its ticket: it would drop whatever is open").toHaveBeenCalledWith(
      "cancel_undo_transaction",
      { ticket: 8 },
    );
    invoke.mockReset();
    await commitUndoTransaction();
    await cancelUndoTransaction(null);
    expect(invoke.mock.calls).toEqual([["commit_undo_transaction", undefined], ["cancel_undo_transaction", undefined]]);
  });

  it("readUndoBeginAnswer: a number opened, null joined, no answer fails toward closing", () => {
    expect(readUndoBeginAnswer(7)).toEqual({ opened: true, ticket: 7 });
    expect(readUndoBeginAnswer(null), "a JOIN read as opened: its close would end another caller's step").toEqual({
      opened: false,
      ticket: null,
    });
    expect(readUndoBeginAnswer(false)).toEqual({ opened: false, ticket: null });
    expect(
      readUndoBeginAnswer(undefined),
      "no answer read as a join: nobody would ever close the transaction it opened",
    ).toEqual({ opened: true, ticket: null });
  });

  it("its readers take the answer through readUndoBeginAnswer, never as unknown", () => {
    const geometry = read("api/objectGeometry.ts");
    expect(geometry, "openUndoTransaction still reads the begin's answer as unknown").not.toMatch(
      /\(answer: unknown\)/,
    );
    expect(geometry, "openUndoTransaction no longer keeps the ticket it must commit with").toMatch(
      /readUndoBeginAnswer\(answer\)[\s\S]*tx\.ticket = own\.ticket/,
    );
    expect(geometry).toMatch(/commitUndoTransaction\(tx\.ticket\)/);
    const host = read("api/scriptHost/host.ts");
    expect(host, "the script host still reads the begin's answer as unknown").not.toMatch(
      /:\s*unknown\s*=\s*await\s+lib\.beginUndoTransaction/,
    );
    expect(host, "a script-host begin is read some other way than readUndoBeginAnswer").not.toMatch(
      /await lib\.beginUndoTransaction\([^)]*\)\)\s*!==\s*false/,
    );
  });
});
