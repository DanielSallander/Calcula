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
//          `preview` IS THE ANSWER TO "TWO PLACES TO DEFINE A TARGET". The
//          resolver has always read the model's own KPI as its base layer; it
//          is the TAB that renders the raw document, so a measure whose
//          direction is fully determined by a KPI shows an empty dropdown and
//          invites a second, competing answer. `strategyPreview` fetches what
//          the resolver already decided, provenance and all. Nothing on this
//          side re-derives any of it.
//
//          Documents leave through `toWireDoc`: every container in
//          insights/strategy/types.rs carries `deny_unknown_fields`, and a
//          `null` where a `Vec` is expected is a hard deserialization error,
//          so absent values are pruned rather than serialized.

import { biModelStrategy } from "@api";
import { toWireDoc } from "./strategyTypes";
import type {
  AggregationSpec,
  Cadence,
  Direction,
  Finding,
  Materiality,
  StrategyDoc,
  StrategyOpResult,
  Target,
  Unit,
} from "./strategyTypes";

/**
 * What `suggestions` returns: the findings, plus the usage snapshot they were
 * measured against.
 *
 * `usage` is deliberately `unknown`. Nothing renders it yet, and a hand-written
 * mirror of a Rust struct that no caller reads is a type that drifts silently
 * until the day someone trusts it. Whoever renders it first mirrors it then,
 * against the Rust definition, and pins it with a test.
 */
export interface StrategySuggestionsResult extends StrategyOpResult {
  usage: unknown;
}

/** The stored document, or null when nobody has annotated this model yet. */
export async function strategyGet(connectionId: string): Promise<StrategyDoc | null> {
  const raw = await biModelStrategy<StrategyDoc | null>(connectionId, "get");
  return raw ?? null;
}

/**
 * Propose a draft document from the model itself. Never writes.
 *
 * The ONE inference. It walks each measure's AST for additivity, ranks
 * analysis dimensions by how the workbook actually uses them, and reads names
 * through a bilingual lexicon — none of which the frontend can see. Every
 * entry comes back `reviewed: false`, because a machine's opinion about what
 * "good" means is a draft a person confirms row by row, never an answer.
 *
 * The caller decides what to do with it: the Strategy tab REPLACES its
 * unsaved draft, so it asks first.
 */
export async function strategyInfer(connectionId: string): Promise<StrategyDoc> {
  return biModelStrategy<StrategyDoc>(connectionId, "infer");
}

/**
 * What the workbook's own pivots, filters and layouts say about how this model
 * is really used, measured against what the document declares. Never writes.
 *
 * Reachable but UNWIRED: no UI calls this yet. It is here so the surface is one
 * import away when the tab grows a "what does the workbook think?" panel, and
 * so the op cannot rot untested behind a command name nothing spells.
 * Omitting `doc` judges the STORED document.
 */
export async function strategySuggestions(
  connectionId: string,
  doc?: StrategyDoc,
): Promise<StrategySuggestionsResult> {
  return biModelStrategy<StrategySuggestionsResult>(
    connectionId,
    "suggestions",
    doc === undefined ? null : toWireDoc(doc),
  );
}

// ---------------------------------------------------------------------------
// preview — what a measure already RESOLVES to, and who decided each attribute
// ---------------------------------------------------------------------------

/**
 * Where one attribute's value came from.
 *
 * Externally tagged, exactly as serde writes the Rust enum
 * (`insights/strategy/resolve.rs`): the two variants that carry a name are
 * objects (`{ "kpi": "Margin % KPI" }`, `{ "rule": "refunds-dept" }`) and the
 * three that do not are bare strings. The KPI and rule NAMES are the point —
 * "inherited" is not an answer anyone can go and check.
 */
export type AttrSource = "base" | "inferred" | "strategy" | { kpi: string } | { rule: string };

/** A resolved value together with its provenance. */
export interface Applied<T> {
  value: T;
  source: AttrSource;
}

/** One attribute deliberately withheld, and the rule that withheld it. */
export interface Suppression {
  /** `direction` | `target` | `materiality` | `cadence` | `aggregation` |
   *  `suppress` | `rankWeight` — the Rust `Attribute` enum, camelCased. */
  attribute: string;
  /** The rule id. A suppression always names one. */
  rule: string;
  reason: string;
}

/**
 * What the strategy says about one measure at the empty scope point.
 *
 * A MIRROR of `ResolvedMeasure` in `insights/strategy/resolve.rs`, and nothing
 * more: no attribute is re-derived here. The whole reason this type exists is
 * that ONE implementation — the Rust resolver — decides what a measure
 * inherits, so a KPI lookup or a direction inference written on this side would
 * be the second opinion the preview exists to remove.
 */
export interface ResolvedMeasure {
  measure: string;
  // `| null`, NOT just optional. `ResolvedMeasure`'s `Option<Applied<T>>` fields
  // carry NO `skip_serializing_if`, so serde writes an absent attribute as an
  // explicit `null` rather than omitting the key. Typing these `?:` alone said
  // "absent means undefined", every guard was written `=== undefined`, and the
  // first measure with no KPI and no strategy entry — i.e. the first measure of
  // any real model — crashed the whole Model Editor window on `null.value`.
  //
  // Read a Rust field's serde attributes before deciding what "absent" looks
  // like on this side. `?:` is kept alongside so a later `skip_serializing_if`
  // would not make this type wrong in the other direction.
  direction?: Applied<Direction> | null;
  aggregation?: Applied<AggregationSpec> | null;
  unit?: Applied<Unit> | null;
  target?: Applied<Target> | null;
  materiality?: Applied<Materiality> | null;
  cadence?: Applied<Cadence> | null;
  priority?: Applied<number> | null;
  rankWeight?: Applied<number> | null;
  /** Fact kinds withheld here, as the union of every rule that reaches. */
  suppressedKinds: string[];
  /** `Table[Column]` refs — a `QualifiedColumn` is one string on the wire. */
  analysisDimensions: string[];
  neverSliceBy: string[];
  /** Also `| null` — same reason as the attributes above. */
  context?: string | null;
  suppressions: Suppression[];
}

export interface StrategyPreviewMeasure {
  measure: string;
  /** Does the document carry a row for this measure at all? An attribute's
   *  `source` says where its VALUE came from; this says whether the row the tab
   *  would edit exists. */
  hasEntry: boolean;
  /** False means an ORPHAN entry — the document names a measure the model no
   *  longer has, which the validator already warns about. */
  inModel: boolean;
  resolved: ResolvedMeasure;
}

export interface StrategyPreviewResult {
  measures: StrategyPreviewMeasure[];
  /** Populated only when the document could not be read at all; `measures` is
   *  then empty. The tab does not render these — Validate and Save report the
   *  same problem in the place people already look for it. */
  findings: Finding[];
}

/**
 * Resolve every measure the model or the document knows. Never writes.
 *
 * PASS THE IN-MEMORY DOCUMENT so an UNSAVED edit previews: someone raising a
 * measure's materiality should see the effect before Save, not after. Omitting
 * `doc` (or passing null) previews the STORED document instead.
 */
export async function strategyPreview(
  connectionId: string,
  doc?: StrategyDoc | null,
): Promise<StrategyPreviewResult> {
  return biModelStrategy<StrategyPreviewResult>(
    connectionId,
    "preview",
    doc === undefined || doc === null ? null : toWireDoc(doc),
  );
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
