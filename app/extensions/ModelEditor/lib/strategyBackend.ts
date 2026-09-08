// FILENAME: app/extensions/ModelEditor/lib/strategyBackend.ts
// PURPOSE: Typed wrappers over the `bi_model_strategy` command — the ONE place
//          the Strategy tab and the CLI verbs reach the strategy document.
// CONTEXT: THE REFUSAL IS A RESULT, NOT AN ERROR. `set` on a document with an
//          error finding comes back `{ written: false, findings: [...] }` and
//          resolves; only a transport/permission failure rejects. Every caller
//          therefore has to look at `written` — a `try { await set() } catch`
//          that assumes success on a resolved promise reports "Saved" over a
//          document the backend refused, and throws the findings away with it.
//          These wrappers keep that shape instead of normalising it into an
//          exception, and `strategySet` is the only one that can write.
//
//          Documents leave through `toWireDoc`: every container in
//          insights/strategy/types.rs carries `deny_unknown_fields`, and a
//          `null` where a `Vec` is expected is a hard deserialization error,
//          so absent values are pruned rather than serialized.

import { biModelStrategy } from "@api";
import { toWireDoc } from "./strategyTypes";
import type { StrategyDoc, StrategyOpResult } from "./strategyTypes";

/** The stored document, or null when nobody has annotated this model yet. */
export async function strategyGet(connectionId: string): Promise<StrategyDoc | null> {
  const raw = await biModelStrategy<StrategyDoc | null>(connectionId, "get");
  return raw ?? null;
}

/** Judge a document without storing it. Never writes. */
export async function strategyValidate(
  connectionId: string,
  doc: StrategyDoc,
): Promise<StrategyOpResult> {
  return biModelStrategy<StrategyOpResult>(connectionId, "validate", toWireDoc(doc));
}

/** Run only the document's own inline assertions. Never writes. */
export async function strategyRunTests(
  connectionId: string,
  doc: StrategyDoc,
): Promise<StrategyOpResult> {
  return biModelStrategy<StrategyOpResult>(connectionId, "runTests", toWireDoc(doc));
}

/**
 * Store the document — IF it validates.
 *
 * A refusal resolves with `written: false` and the findings that caused it.
 * Callers must render those; reporting success on a resolved promise is the
 * exact bug this shape exists to make visible.
 */
export async function strategySet(
  connectionId: string,
  doc: StrategyDoc,
): Promise<StrategyOpResult> {
  return biModelStrategy<StrategyOpResult>(connectionId, "set", toWireDoc(doc));
}

/** Remove the document entirely (errors when the model has none). */
export async function strategyDelete(connectionId: string): Promise<StrategyOpResult> {
  return biModelStrategy<StrategyOpResult>(connectionId, "delete");
}
