//! FILENAME: app/extensions/Collaboration/lib/forgetAnchor.ts
// PURPOSE: The one remedy for a checkout refused because the workspace names a
//          DIFFERENT creator than this computer remembers (the developer
//          anchor): forget the remembered creator -- asked first, naming both
//          keys, failing closed.
// CONTEXT: The workspace proves an application's creator by its first version's
//          signature, but finds that version through an unsigned listing, so
//          anyone who can write to the workspace folder can plant one of their
//          own. This computer's memory of the creator is the one thing they
//          cannot forge, and forgetting it re-opens exactly that door. So the
//          question names both keys, says to confirm with the creator first,
//          and anything but an explicit yes -- a No, a dialog that cannot be
//          shown, a dialog that throws -- forgets nothing.
//
//          A ROLLED-BACK co-publisher list offers no such remedy: only the
//          creator can fix it, by saving the list again.

import { forgetDeveloperAnchor, type AnchorRefusal } from "@api/collaboration";
import { confirmAsync } from "@api/dialogs";

/** The question asked before forgetting. Names both keys, and the risk. */
export function forgetAnchorQuestion(packageName: string, refusal: AnchorRefusal): string {
  return (
    `This computer remembers that '${packageName}' was created by the key ` +
    `${refusal.rememberedFingerprint}. The workspace now says its creator is ` +
    `${refusal.claimedFingerprint}.\n\n` +
    "Forget the remembered creator only after the application's creator has confirmed to you " +
    `that ${refusal.claimedFingerprint} is their key -- for example because they deleted and ` +
    "re-created the application. If the new key was planted by someone who can write to the " +
    "workspace folder, forgetting lets their versions in, and your next push would publish " +
    "their work under your key.\n\n" +
    "Forget the remembered creator and try again?"
  );
}

/**
 * Ask, then forget. Resolves to `true` only when the user said yes AND the
 * backend forgot; `false` when nothing was forgotten. Throws what the forget
 * throws.
 */
export async function confirmAndForgetAnchor(
  registryPath: string,
  packageName: string,
  refusal: AnchorRefusal,
): Promise<boolean> {
  if (refusal.kind !== "contradicted") return false;
  let proceed = false;
  try {
    // AWAITED: the Tauri confirm is a Promise, and `!promise` is always false.
    proceed = await confirmAsync(forgetAnchorQuestion(packageName, refusal), {
      title: "Forget the remembered creator",
      kind: "warning",
    });
  } catch {
    // A dialog that cannot be shown is a refusal, never consent.
    proceed = false;
  }
  if (proceed !== true) return false;
  await forgetDeveloperAnchor(registryPath, packageName);
  return true;
}
