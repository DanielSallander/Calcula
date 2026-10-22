// FILENAME: app/extensions/Collaboration/lib/__tests__/senderLabel.test.ts
// PURPOSE: The sentences a publisher and a subscriber read about WHO sends an
//          answer (identity phase 1).

import { describe, expect, it } from "vitest";
import { senderLine, sentAsText, identityLine, notCountedCount, whoAmIText, identityCountsText } from "../senderLabel";

describe("senderLine (Collected Responses)", () => {
  const verdict = (status: "verified" | "signedUnconfirmed" | "notVerified", writtenBy = "") => ({
    status,
    reason: "notChecked" as const,
    writtenBy,
  });

  /**
   * THE NAME IS A CLAIM until the reader proves it: an unverified signed
   * answer says "the sender says they are", in a neutral tone; only a Verified
   * one is "Signed by" the account Windows recorded, in the ok tone.
   *
   * SABOTAGE: return the old `Signed as ${principal}` / "ok" line for every
   * signed answer.
   */
  it("words an unverified name as the sender's claim, and how it was sent", () => {
    expect(senderLine({ sender: "signed", submitterPrincipal: "CORP\\alice", origin: "interactive" })).toEqual({
      text: "Signed; the sender says they are CORP\\alice",
      tone: "muted",
    });
    expect(senderLine({ sender: "signed", submitterPrincipal: "CORP\\alice", origin: "script" }).text).toBe(
      "Signed; the sender says they are CORP\\alice, sent by a script",
    );
    expect(
      senderLine({
        sender: "signed",
        submitterPrincipal: "CORP\\alice",
        origin: "immediate",
        identity: verdict("signedUnconfirmed"),
      }),
    ).toEqual({ text: "Signed; the sender says they are CORP\\alice, sent on save", tone: "muted" });
    // BUG-0562's row: never a green "Signed as CORP\\alice" over "written by CORP\\bob".
    expect(
      senderLine({
        sender: "signed",
        submitterPrincipal: "CORP\\alice",
        origin: null,
        identity: verdict("notVerified", "CORP\\bob"),
      }),
    ).toEqual({ text: "Signed; the sender says they are CORP\\alice", tone: "muted" });
  });

  it("names the account Windows recorded for a verified answer -- and says when the claim differs", () => {
    expect(
      senderLine({
        sender: "signed",
        submitterPrincipal: "CORP\\alice",
        origin: null,
        identity: verdict("verified", "CORP\\alice"),
      }),
    ).toEqual({ text: "Signed by CORP\\alice", tone: "ok" });
    const lied = senderLine({
      sender: "signed",
      submitterPrincipal: "CORP\\alice",
      origin: null,
      identity: verdict("verified", "CORP\\mallory"),
    });
    expect(lied.tone).toBe("warn");
    expect(lied.text).toBe("Signed; Windows recorded CORP\\mallory as the writer, but the sender says they are CORP\\alice");
  });

  it("labels an answer sent before sign-in, and never invents a principal for it", () => {
    const line = senderLine({ sender: "beforeSignIn", submitterPrincipal: "", origin: null });
    expect(line).toEqual({ text: "Sent before sign-in (not signed)", tone: "warn" });
    // Even if a row carried a principal, an unsigned answer does not show it.
    expect(senderLine({ sender: "beforeSignIn", submitterPrincipal: "CORP\\ceo", origin: null }).text).not.toContain(
      "CORP",
    );
  });
});

describe("sentAsText (the submit confirmation)", () => {
  it("names the account the answers are signed as", () => {
    expect(sentAsText({ submitterName: "Salle", submitterPrincipal: "Danne\\Salle" })).toBe(
      "Salle (Danne\\Salle), signed with this computer's key",
    );
    expect(sentAsText({ submitterName: "Salle" })).toBe("Salle, signed with this computer's key");
    expect(sentAsText({ submitterName: "", submitterPrincipal: "" })).toBe("");
  });
});

describe("identityLine (the Identity column)", () => {
  const verdict = (status: "verified" | "signedUnconfirmed" | "notVerified" | "beforeSignIn" | "notChecked") => ({
    status,
    reason: "notChecked" as const,
    writtenBy: "",
  });

  it("shows Rust's sentence with a tone per verdict", () => {
    expect(identityLine({ identity: verdict("verified"), identityLabel: "Verified: Windows account", counted: true })).toEqual({
      text: "Verified: Windows account",
      tone: "ok",
    });
    expect(identityLine({ identity: verdict("notVerified"), identityLabel: "Not verified: written by CORP\bob", counted: true }).tone).toBe(
      "danger",
    );
    expect(identityLine({ identity: verdict("signedUnconfirmed"), identityLabel: "Signed, identity not confirmed", counted: true }).tone).toBe(
      "muted",
    );
    expect(identityLine({ identity: verdict("beforeSignIn"), identityLabel: "Sent before sign-in (not signed)", counted: true }).tone).toBe(
      "warn",
    );
  });

  /** SABOTAGE: drop the "— not counted" suffix -- this fails. */
  it("says when the application's rule does not count an answer", () => {
    const line = identityLine({ identity: verdict("signedUnconfirmed"), identityLabel: "Signed, identity not confirmed", counted: false });
    expect(line.text).toBe("Signed, identity not confirmed — not counted");
    expect(line.tone).toBe("danger");
    expect(notCountedCount([{ counted: true }, { counted: false }, {}])).toBe(1);
    // A row from before the field is not a refusal to count.
    expect(identityLine({}).text).toBe("Not checked");
  });
});

describe("whoAmIText (Writeback tab Status, Writeback pane)", () => {
  it("names the Windows account and its kind", () => {
    const v = whoAmIText({
      displayName: "Salle",
      id: "win-x",
      principalName: "Danne\Salle",
      provider: "windows",
      scope: "localMachine",
    });
    expect(v.text).toBe("You are signed in as Salle (Windows account)");
    expect(v.account).toBe("Danne\Salle, this computer's own account");
    expect(v.detail).toContain("signed with this computer's key");
    expect(
      whoAmIText({ displayName: "Anna", id: "win-y", principalName: "CORP\anna", provider: "windows", scope: "domain" }).account,
    ).toBe("CORP\anna, a domain account");
  });

  it("says a failed or pending read as what it is", () => {
    expect(whoAmIText(null, "damaged key").text).toBe("Who you are could not be read");
    expect(whoAmIText(null).text).toBe("Reading who you are…");
  });
});

describe("identityCountsText (Application Inspector)", () => {
  it("words the counts and leaves zeros out", () => {
    expect(
      identityCountsText({ verified: 2, signedUnconfirmed: 1, notVerified: 0, beforeSignIn: 3, notChecked: 0 }),
    ).toBe("2 verified · 1 signed, identity not confirmed · 3 sent before sign-in");
    expect(identityCountsText({ verified: 0, signedUnconfirmed: 0, notVerified: 0, beforeSignIn: 0, notChecked: 0 })).toBe(
      "no answers",
    );
    expect(identityCountsText(null)).toBe("");
  });
});
