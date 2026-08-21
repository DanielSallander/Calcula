//! FILENAME: app/src/api/scriptHost/scriptPreview/__tests__/coverage.test.ts
// PURPOSE: MEASURE how much of what a model is actually taught the preview can
//          serve — and fail when the part that must be total stops being total.
// CONTEXT: docs/design/local-model-script-authoring.md §5c.
//
//          WHY MEASURE AT ALL. The preview's gap discipline is honest but not
//          free: a gapped run is `applicable: false`, and a rung that declines
//          most of what it sees is a rung that is dead again — which is the
//          state this whole piece of work existed to get out of. "How often does
//          it gap" was unmeasured when the preview shipped, and the number was
//          being guessed at from intuition. This file computes it.
//
//          THE RIGHT DENOMINATOR IS WHAT THE MODEL IS TAUGHT, not the 233-row
//          ALLOWLIST. A model can only call what the prompt shows it, so the
//          surface that matters is `PROMPT_CORE_CHAINS` (shown at EVERY budget)
//          plus whatever the corpus references actually reach. Measuring against
//          all 233 would report a frightening number about methods no draft will
//          ever contain.
//
//          THE MAPPING IS EXACT, NOT GUESSED. `SCRIPT_SURFACE` is generated from
//          the same probe as the typings and carries `chain -> broker` for every
//          member, so "which broker method does `api.sortRange` dispatch to" is
//          a lookup rather than a regex. A member with NO broker crosses no
//          policy boundary (a worker-local mirror read) and needs no backend at
//          all — those are already faithful and are excluded from the ratio.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SCRIPT_SURFACE } from "../../generated/scriptSurfacePolicy";
import { ALLOWLIST } from "../../allowlist";
import { UNPREVIEWABLE } from "../backend";
import { callableAncestorOf, isKnownPrefix } from "../../scriptValidation/surface";
import { PROMPT_CORE_CHAINS, buildSurfacePrompt } from "../../scriptPrompt";
import { analyzeScript } from "../../scriptValidation/analyze";
import { referenceSource, type EvalCorpus } from "../../scriptEval";

const BACKEND = resolve(__dirname, "../backend.ts");
const CORPUS = resolve(__dirname, "../../../../../../tests/eval/tasks.json");

/**
 * The broker methods `respond()` answers, read out of its own `case` labels.
 *
 * Parsed from the source rather than by calling it: a probe would need valid
 * arguments for 39 different signatures, and half of them would throw for
 * reasons unrelated to whether the case exists.
 */
function servedMethods(): Set<string> {
  const src = readFileSync(BACKEND, "utf8");
  const from = src.indexOf("export function respond(");
  expect(from, "respond() not found — this guard is reading the wrong file").toBeGreaterThan(-1);
  const body = src.slice(from);
  return new Set([...body.matchAll(/^\s*case "([a-z]+\.[A-Za-z0-9]+)":/gm)].map((m) => m[1]));
}

/** chain -> broker method, for every member that crosses the broker at all. */
const brokerOf = new Map<string, string>(
  SCRIPT_SURFACE.filter((m) => m.broker).map((m) => [m.chain, m.broker as string]),
);

/**
 * Split a set of chains into what the preview can serve and what it cannot.
 *
 * Resolution goes through `callableAncestorOf`, the SAME rule the reach check
 * uses, so a call on a returned value lands where it belongs:
 * `caps.fetch.json` is `cap.fetch` plus a method on the response the shim
 * built, not an unknown member. Writing a second rule here would have made the
 * measurement disagree with the validator about what a script even calls.
 *
 * A chain with no broker needs no backend — it never leaves the realm — so it
 * counts as served. A chain that resolves to nothing is reported separately:
 * that is a defect in the INPUT (a prompt or a reference naming a member that
 * does not exist), never a gap in the backend.
 */
function classify(chains: Iterable<string>, served: Set<string>) {
  const ok: string[] = [];
  const gapped: string[] = [];
  const unknown: string[] = [];
  for (const chain of new Set(chains)) {
    const member = callableAncestorOf(chain);
    if (member === undefined) {
      // A bare namespace reference (`const c = context.caps`) is legal and
      // reaches nothing; anything else here is genuinely not a member.
      if (isKnownPrefix(chain)) ok.push(chain);
      else unknown.push(chain);
      continue;
    }
    const broker = brokerOf.get(member);
    if (!broker) ok.push(chain); // worker-local; no backend involved
    else (served.has(broker) ? ok : gapped).push(chain);
  }
  return { ok: ok.sort(), gapped: gapped.sort(), unknown: unknown.sort() };
}

const served = servedMethods();
const corpus = JSON.parse(readFileSync(CORPUS, "utf8")) as EvalCorpus;

describe("the preview serves what the model is actually taught", () => {
  it("reads a real backend, so the coverage below is not measured against nothing", () => {
    expect(served.size).toBeGreaterThan(30);
    expect(served.has("api.setCellValue")).toBe(true);
    expect(brokerOf.size).toBeGreaterThan(300);
  });

  /**
   * THE ONE THAT MUST BE TOTAL.
   *
   * `PROMPT_CORE_CHAINS` is shown to the model at EVERY budget — it is the floor
   * that outranks hint pressure, added because at 4k the ranker had dropped
   * `api.setCellValue` from a task about writing cells. A model is therefore
   * MOST likely to produce exactly these, and a gap here would decline the most
   * ordinary drafts there are. This is the assertion that keeps the rung alive.
   */
  it("serves EVERY chain the prompt shows at every budget", () => {
    const { ok, gapped, unknown } = classify(PROMPT_CORE_CHAINS, served);
    expect(unknown, "the prompt teaches a member the generated surface does not have").toEqual([]);
    expect(
      gapped,
      "these are in PROMPT_CORE_CHAINS, so a model is taught them at every budget — " +
        "the preview must serve them or it will decline the most ordinary drafts there are. " +
        "Add a case to respond() in scriptPreview/backend.ts, or remove the chain from the prompt.",
    ).toEqual([]);
    expect(ok.length).toBe(PROMPT_CORE_CHAINS.length);
  });

  /**
   * The corpus is the closest thing to a realistic draft distribution: 36 tasks
   * written as the things people ask for, each with a solution known to work.
   * Every chain they reach is one a model plausibly emits.
   */
  it("serves every chain the corpus references reach", () => {
    const chains = corpus.tasks.flatMap((t) => analyzeScript(referenceSource(t)).calls.map((c) => c.chain));
    const { ok, gapped, unknown } = classify(chains, served);

    // Reported rather than asserted away: a reference calling something the
    // generated surface does not know would be a corpus defect, and Layer A
    // would already have caught it — this line exists so a future one is
    // attributed correctly instead of read as a preview gap.
    expect(unknown, "a corpus reference calls a member that is not in the surface").toEqual([]);

    expect(
      gapped,
      "a corpus reference reaches a member the preview cannot serve, so that task " +
        "would come back `applicable: false` — the run would say nothing about the script",
    ).toEqual([]);
    expect(ok.length).toBeGreaterThan(20);
  });

  /**
   * THE NUMBER THAT ACTUALLY PREDICTS THE GAP RATE.
   *
   * `PROMPT_CORE_CHAINS` is the floor, not the whole prompt: the assembler
   * ranks the rest of the surface and includes as much as the budget allows, so
   * the set a model can emit is `includedChains`, which is budget- and
   * hint-dependent and much larger than the core. Every included chain the
   * preview cannot serve is a live chance of `applicable: false` on a real
   * draft.
   *
   * Measured per corpus task at both working budgets, because the exposure is
   * per prompt: a task hinting "download" gets `caps.fetch` ranked in and a task
   * about sorting does not.
   */
  it("reports the exposure at the budgets the runner actually uses", () => {
    /**
     * TWO KINDS OF GAP, and conflating them produces a number nobody can act on.
     *
     *  - A CAPABILITY chain (`caps.fetch`, `caps.biQuery`, `caps.dialog.form`)
     *    is declined BY DESIGN in-app: the preview has no network, no user to
     *    answer a dialog and no model to query, and answering from a canned stub
     *    would make it report its own fiction as the draft's runtime error.
     *    Serving these is not the fix; they are permanently un-previewable and
     *    counting them as shortfall would demand work that must never be done.
     *  - Everything else is plain grid/object reach the backend simply has not
     *    implemented. THAT is the addressable set, and it is what the assertion
     *    below is about.
     */
    const outOfReach = (chain: string): boolean => {
      const member = callableAncestorOf(chain);
      const broker = member ? brokerOf.get(member) : undefined;
      if (!broker) return false;
      // Capability-bearing is derived from the ALLOWLIST rather than listed, so
      // the set cannot drift as capabilities are added.
      return !!ALLOWLIST[broker]?.capability || UNPREVIEWABLE.has(broker);
    };

    const rows: string[] = [];
    const actionable = new Map<string, number>();
    let at8k = { offered: 0, servedCount: 0, outOfReachGaps: 0, otherGaps: 0 };

    for (const budgetTokens of [4_000, 8_000]) {
      let offered = 0;
      let outOfReachGaps = 0;
      let otherGaps = 0;
      for (const task of corpus.tasks) {
        const prompt = buildSurfacePrompt({ objectType: task.objectType, budgetTokens, hints: task.hints });
        const c = classify(prompt.includedChains, served);
        offered += prompt.includedChains.length;
        for (const g of c.gapped) {
          if (outOfReach(g)) outOfReachGaps++;
          else {
            otherGaps++;
            if (budgetTokens === 8_000) actionable.set(g, (actionable.get(g) ?? 0) + 1);
          }
        }
      }
      const servedCount = offered - outOfReachGaps - otherGaps;
      const previewable = offered - outOfReachGaps; // the denominator that can be improved
      rows.push(
        `  ${budgetTokens / 1000}k: ${offered} chains offered — ${servedCount} served, ` +
          `${outOfReachGaps} out of reach (capability / structural), ${otherGaps} addressable gaps. ` +
          `Addressable coverage ${((servedCount / previewable) * 100).toFixed(1)}%`,
      );
      if (budgetTokens === 8_000) at8k = { offered, servedCount, outOfReachGaps, otherGaps };
    }

    const top = [...actionable.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    // eslint-disable-next-line no-console
    console.log(
      `[preview exposure] across ${corpus.tasks.length} corpus tasks\n${rows.join("\n")}\n` +
        `  most-offered ADDRESSABLE gaps @8k: ${top.map(([c, n]) => `${c}(${n})`).join(", ") || "none"}`,
    );

    expect(at8k.offered, "no chains were offered — the assembler is not being exercised").toBeGreaterThan(100);

    /**
     * A RATCHET, and named as one rather than dressed up as a quality target.
     *
     * The two assertions that actually protect the rung are above: the prompt's
     * permanent floor is served in full, and so is every chain a correct
     * solution reaches. What this line protects is the BACKEND FALLING BEHIND
     * THE PROMPT — someone widening what the model is offered without widening
     * what can be previewed, which converts silently into declined drafts.
     *
     * It is deliberately NOT set near 100%. The tail is a long list of members
     * (`api.addComment`, `api.applyNamedStyle`, `api.consolidate`, …) that no
     * correct solution in the corpus reaches, and chasing a high number here
     * would mean writing 25 approximate implementations. An approximate
     * implementation is strictly worse than a gap: a gap declines and says
     * nothing, while an approximation grades a WRONG script as right. Raise
     * this only by serving something faithfully — the corpus's Layer A anchor
     * is what proves you did.
     */
    const previewable = at8k.offered - at8k.outOfReachGaps;
    expect(
      at8k.servedCount / previewable,
      `preview coverage of what the model is SHOWN has FALLEN to ` +
        `${at8k.servedCount}/${previewable}. Something widened the prompt without widening ` +
        `the backend, so drafts reaching for the difference now come back \`applicable: false\`. ` +
        `Serve the most-offered gaps printed above in scriptPreview/backend.ts — faithfully, ` +
        `with a corpus task that exercises each — or narrow what the prompt offers.`,
    ).toBeGreaterThan(0.5);
  });

  /**
   * The measurement itself, printed rather than asserted at a threshold.
   *
   * A number pinned to an exact value here would fail on every honest addition
   * to the surface and teach the next person to bump it without reading it. What
   * IS asserted is the shape of the answer: the whole taught floor is served,
   * which the two tests above already pin. This one exists so the rate is
   * visible in the run rather than being guessed at again.
   */
  it("reports the coverage rate over the whole author-facing surface", () => {
    const everyChain = SCRIPT_SURFACE.map((m) => m.chain);
    const { ok, gapped } = classify(everyChain, served);
    const brokerBearing = ok.filter((c) => brokerOf.has(c)).length + gapped.length;
    const pct = ((ok.filter((c) => brokerOf.has(c)).length / brokerBearing) * 100).toFixed(1);

    // eslint-disable-next-line no-console
    console.log(
      `[preview coverage] ${served.size} broker methods served. ` +
        `Of ${brokerBearing} broker-bearing chains in the whole surface, ${pct}% are served; ` +
        `${gapped.length} gap. Prompt core: ${PROMPT_CORE_CHAINS.length}/${PROMPT_CORE_CHAINS.length}. ` +
        `A gapped chain is not a defect — the run declines and says nothing.`,
    );

    // The only thing worth failing on here: the whole surface must not be
    // mostly served by accident either, which would mean `respond()` had grown
    // a delegating default and stopped gapping at all.
    expect(gapped.length, "respond() appears to serve nearly everything — has its default stopped throwing?").toBeGreaterThan(0);
  });
});
