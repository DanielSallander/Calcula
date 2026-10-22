// FILENAME: app/extensions/Collaboration/lib/senderLabel.ts
// PURPOSE: The one sentence a publisher reads about WHO sent an answer
//          (identity phase 1, owner decision 2026-10-22), and the one a
//          subscriber reads about who they send as.
// CONTEXT: Rust decides everything here (`calp::submission_seal`): the fold
//          drops forged answers before any list sees them, so a row is either
//          SIGNED by the key its sender id names or was SENT BEFORE SIGN-IN.
//          These helpers only word it. What a signature proves is worded
//          plainly: this user's Calcula sent the answer, from the origin it
//          names -- not that a person typed it, and in phase 1 not that the
//          account name is right (it is the sender's own claim, bound to
//          their key; docs/design/calp-writeback.md "Who sends an answer").

import type {
  IdentityCounts,
  IdentityStatus,
  IdentityVerdict,
  SenderCheck,
  SubmissionOrigin,
  SubmitterIdentity,
} from "@api/collaboration";

export type SenderTone = "ok" | "warn" | "muted";

export interface SenderLine {
  text: string;
  tone: SenderTone;
}

/** How a signed answer was sent, as a short trailing clause ("" when typed and submitted). */
function originClause(origin: SubmissionOrigin | null | undefined): string {
  switch (origin) {
    case "script":
      return ", sent by a script";
    case "immediate":
      return ", sent on save";
    default:
      return "";
  }
}

/**
 * The publisher's line for one Collected Responses row.
 *
 * THE NAME IS A CLAIM until the reader's verdict proves it. A signature proves
 * the sender's own computer sent the answer; the account name in it is what
 * that computer said. So only a VERIFIED answer is worded as "Signed by" an
 * account (the one Windows recorded) in the "ok" tone; every other signed
 * answer reads "the sender says they are ..." in a neutral tone -- and a
 * verified writer who CLAIMED another account is said plainly in the warning
 * tone. A green "Signed as CORP\alice" above a red "written by CORP\bob" is
 * exactly how BUG-0562's forged name read as the real person.
 */
export function senderLine(row: {
  sender: SenderCheck;
  submitterPrincipal: string;
  origin: SubmissionOrigin | null;
  identity?: IdentityVerdict;
}): SenderLine {
  if (row.sender === "signed") {
    const how = originClause(row.origin);
    const claimed = row.submitterPrincipal.trim();
    const written = (row.identity?.writtenBy ?? "").trim();
    if (row.identity?.status === "verified" && written) {
      if (claimed && claimed.toLowerCase() !== written.toLowerCase()) {
        return { text: `Signed; Windows recorded ${written} as the writer, but the sender says they are ${claimed}${how}`, tone: "warn" };
      }
      return { text: `Signed by ${written}${how}`, tone: "ok" };
    }
    if (!claimed) return { text: `Signed${how}`, tone: "muted" };
    return { text: `Signed; the sender says they are ${claimed}${how}`, tone: "muted" };
  }
  if (row.sender === "beforeSignIn") {
    return { text: "Sent before sign-in (not signed)", tone: "warn" };
  }
  return { text: "Not checked", tone: "muted" };
}

/** The subscriber's "sent as" clause for the submit confirmation. */
export function sentAsText(p: { submitterName: string; submitterPrincipal?: string }): string {
  const principal = p.submitterPrincipal ?? "";
  if (!p.submitterName && !principal) return "";
  if (principal && principal !== p.submitterName) {
    return `${p.submitterName || principal} (${principal}), signed with this computer's key`;
  }
  return `${p.submitterName || principal}, signed with this computer's key`;
}

// ============================================================================
// Identity (the READER's verdict) and who-am-I
// ============================================================================

export type IdentityTone = "ok" | "warn" | "danger" | "muted";

export interface IdentityLineView {
  text: string;
  tone: IdentityTone;
}

const IDENTITY_TONE: Record<IdentityStatus, IdentityTone> = {
  verified: "ok",
  signedUnconfirmed: "muted",
  notVerified: "danger",
  beforeSignIn: "warn",
  notChecked: "muted",
};

/**
 * The Identity column of one Collected Responses row: Rust's sentence for the
 * reader's verdict (verified / signed but not confirmed / not verified /
 * sent before sign-in), plus "not counted" when the application's identity
 * rule leaves it out of every total. Rust decides both; this only words the
 * suffix and picks the tone.
 */
export function identityLine(row: {
  identity?: IdentityVerdict;
  identityLabel?: string;
  counted?: boolean;
}): IdentityLineView {
  const text = row.identityLabel || "Not checked";
  // Absent `counted` (a row from before the field) is not a refusal to count.
  const counted = row.counted !== false;
  return {
    text: counted ? text : `${text} — not counted`,
    tone: counted ? IDENTITY_TONE[row.identity?.status ?? "notChecked"] : "danger",
  };
}

/**
 * The rows the Collected Responses header totals (respondents, pending,
 * approved, rejected) count: under "count only verified senders" only the
 * counted ones -- the strip beside them says the rest are "left out of every
 * total", and the "N not counted" chip names them.
 */
export function headerRows<T extends { counted?: boolean }>(rows: readonly T[], requireVerified: boolean): T[] {
  return requireVerified ? rows.filter((r) => r.counted !== false) : [...rows];
}

/** How many of `rows` the application's identity rule does not count. */
export function notCountedCount(rows: ReadonlyArray<{ counted?: boolean }>): number {
  return rows.filter((r) => r.counted === false).length;
}

/** The kind of account, in words. */
function accountKind(identity: SubmitterIdentity): string {
  switch (identity.scope) {
    case "localMachine":
      return "this computer's own account";
    case "domain":
      return "a domain account";
    case "entraJoined":
      return "a work account";
    default:
      return "an account";
  }
}

export interface WhoAmIView {
  /** "You are signed in as Salle (Windows account)". */
  text: string;
  /** "DanneSalle, this computer's own account" (the second Status row). */
  account: string;
  /** "Danne\Salle, this computer's own account. Your answers are signed with this computer's key." */
  detail: string;
}

/**
 * WHO THIS COMPUTER SENDS AS, for the subscriber's Writeback tab Status and
 * the Writeback pane (owner decision 2026-10-22: "You are signed in as <name>
 * (Windows account)"). Phase 1 is always the Windows account; Entra ID is a
 * later phase and not offered.
 */
export function whoAmIText(identity: SubmitterIdentity | null, error?: string | null): WhoAmIView {
  if (!identity) {
    return error
      ? { text: "Who you are could not be read", account: "", detail: error }
      : { text: "Reading who you are…", account: "", detail: "" };
  }
  const name = identity.displayName || identity.principalName || identity.id;
  if (identity.provider !== "windows") {
    return { text: `You are signed in as ${name}`, account: identity.principalName, detail: identity.principalName };
  }
  const principal = identity.principalName && identity.principalName !== name ? `${identity.principalName}, ` : "";
  const account = `${principal}${accountKind(identity)}`;
  return {
    text: `You are signed in as ${name} (Windows account)`,
    account,
    detail: `${account}. Your answers are signed with this computer's key.`,
  };
}

/**
 * Verdict counts in words, zeros left out -- the Application Inspector's
 * "who sent them" line: "2 verified · 1 signed, identity not confirmed ·
 * 1 not verified · 3 sent before sign-in".
 */
export function identityCountsText(counts: IdentityCounts | null | undefined): string {
  if (!counts) return "";
  const parts: string[] = [];
  if (counts.verified > 0) parts.push(`${counts.verified} verified`);
  if (counts.signedUnconfirmed > 0) parts.push(`${counts.signedUnconfirmed} signed, identity not confirmed`);
  if (counts.notVerified > 0) parts.push(`${counts.notVerified} not verified`);
  if (counts.beforeSignIn > 0) parts.push(`${counts.beforeSignIn} sent before sign-in`);
  if (counts.notChecked > 0) parts.push(`${counts.notChecked} not checked`);
  return parts.length > 0 ? parts.join(" · ") : "no answers";
}
