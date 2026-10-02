// FILENAME: app/extensions/Collaboration/lib/coPublisherChange.ts
// PURPOSE: The one rule for building the co-publisher list a change writes --
//          and for what the creator must be told first when the workspace is
//          serving a ROLLED-BACK list.
// CONTEXT: The list is sent WHOLE (the artifact is the whole list), so the
//          editor builds it from what the listing showed. A removed delegate
//          who puts back an older `publishers.json` -- still carrying the
//          creator's valid signature -- used to become the base of the
//          creator's own next add or remove, which then re-signed them in at a
//          revision every machine accepts. The listing no longer presents such
//          a list as current (`rolledBack` carries it apart, and
//          `coPublishers` is empty), and Rust refuses a change on top of it
//          unless the request acknowledges the served revision. This builds the
//          list from what the listing CALLS current, and -- only for a rolled-back
//          list -- the confirmation that names whom that list re-adds, which
//          the editor must get a yes to before it sends the acknowledgement.

import type { CoPublishersResponse } from "@api";

export interface CoPublisherEdit {
  /** A key to add (with its display name). */
  add?: { key: string; name: string };
  /** A key to remove. */
  removeKey?: string;
}

export interface CoPublisherChangePlan {
  /** The whole list to write. */
  next: Array<{ key: string; name: string }>;
  /** The served revision to acknowledge -- set only for a rolled-back list. */
  acknowledgedRolledBackRevision?: number;
  /**
   * What the creator must confirm first -- set only for a rolled-back list.
   * The editor sends the change (and the acknowledgement) only on a yes.
   */
  rollbackConfirmation?: string;
}

function who(entry: { key: string; name: string }): string {
  return `${entry.name || "(unnamed)"} (key ${entry.key.slice(0, 12)}…)`;
}

/**
 * Plan a change of the co-publisher list from what the listing CALLS current
 * (`coPublishers`) -- never from a rolled-back list the workspace serves.
 */
export function planCoPublisherChange(
  info: CoPublishersResponse | null,
  packageName: string,
  edit: CoPublisherEdit,
): CoPublisherChangePlan {
  let next = (info?.coPublishers ?? []).map((c) => ({ key: c.key, name: c.name }));
  if (edit.removeKey !== undefined) next = next.filter((c) => c.key !== edit.removeKey);
  if (edit.add) next = [...next, edit.add];

  const rolledBack = info?.rolledBack;
  if (!rolledBack) return { next };

  const keeping = new Set(next.map((c) => c.key.trim().toLowerCase()));
  const served = rolledBack.servedCoPublishers.map((c) => ({ key: c.key, name: c.name }));
  const dropped = served.filter((c) => !keeping.has(c.key.trim().toLowerCase()));
  const lines = [
    `The workspace is serving an OLDER list of who may publish '${packageName}' ` +
      `(revision ${rolledBack.servedRevision}; this computer has already seen revision ` +
      `${rolledBack.seenRevision}). Someone put it back, with your old signature.`,
    served.length > 0
      ? `That older list names: ${served.map(who).join(", ")}.`
      : "That older list names no co-publishers.",
    next.length > 0
      ? `Your change REPLACES it with: ${next.map(who).join(", ")}.`
      : "Your change REPLACES it with no co-publishers: only you can publish.",
  ];
  if (dropped.length > 0) {
    lines.push(
      `Not in your list, so they will NOT be able to publish: ${dropped.map(who).join(", ")}.`,
    );
  }
  lines.push("Replace the older list?");
  return {
    next,
    acknowledgedRolledBackRevision: rolledBack.servedRevision,
    rollbackConfirmation: lines.join("\n\n"),
  };
}
