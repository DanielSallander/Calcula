// FILENAME: app/extensions/ModelEditor/lib/useProblems.ts
// PURPOSE: Own the problem list: what re-runs when, and what the panel is
//          allowed to claim it checked.
// CONTEXT: Two cadences, deliberately.
//
//          The CLIENT-SIDE checks are pure functions over the `ModelOverview`
//          already in memory, so they re-run on every model change and are
//          always current.
//
//          The DEEP checks cost backend calls — and `bi_model_validate` clones
//          the entire model and rebuilds it, which is not something to do on
//          every keystroke-adjacent mutation. Those run on open and on an
//          explicit Re-check, and the coverage line SAYS SO in between rather
//          than letting an empty list imply a freshness it does not have.

import { useCallback, useEffect, useRef, useState } from "react";
import { biModelValidate } from "@api";
import type { ModelOverview } from "@api";
import {
  bestPracticeProblems,
  modelBuildProblem,
  sortProblems,
  strategyProblems,
} from "./problems";
import type { Problem, ProblemCoverage } from "./problems";
import { strategyGet, strategyValidate } from "./strategyBackend";

const DEBOUNCE_MS = 400;

export interface ProblemsState {
  problems: Problem[];
  coverage: ProblemCoverage;
  busy: boolean;
  /** Re-run the deep checks (engine build + strategy). */
  recheck: () => void;
}

export function useProblems(
  connectionId: string,
  overview: ModelOverview | null,
): ProblemsState {
  const [bp, setBp] = useState<Problem[]>([]);
  const [deep, setDeep] = useState<Problem[]>([]);
  const [coverage, setCoverage] = useState<ProblemCoverage>({
    bestPractice: 0,
    modelBuild: null,
    strategy: null,
  });
  const [busy, setBusy] = useState(false);

  // Cheap checks: debounced so a burst of mutations (a bulk edit fanning out,
  // an import landing) recomputes once rather than per write.
  useEffect(() => {
    if (!overview) {
      setBp([]);
      setCoverage((c) => ({ ...c, bestPractice: 0 }));
      return;
    }
    const timer = setTimeout(() => {
      const found = bestPracticeProblems(overview);
      setBp(found);
      setCoverage((c) => ({ ...c, bestPractice: found.length }));
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [overview]);

  // A monotonic sequence, so a slow deep check cannot install its answer over a
  // newer one — the same hazard `overviewSeqRef` exists for in ModelEditorApp.
  const seqRef = useRef(0);
  const connRef = useRef(connectionId);
  connRef.current = connectionId;

  const runDeep = useCallback(async () => {
    const conn = connRef.current;
    if (!conn) return;
    const seq = ++seqRef.current;
    setBusy(true);
    const found: Problem[] = [];
    let buildState: ProblemCoverage["modelBuild"] = null;
    let strategyCount: number | null = null;

    try {
      const issues = await biModelValidate(conn);
      found.push(...modelBuildProblem(issues));
      buildState = issues.length === 0 ? "ok" : "failed";
    } catch {
      // A failed CHECK is not a failed model; leaving it null keeps the
      // coverage line honest instead of claiming a clean build.
    }

    try {
      // Validating needs the stored document, so this is two calls — and null
      // means the model has no strategy at all, which is not a problem.
      const doc = await strategyGet(conn);
      if (doc) {
        const res = await strategyValidate(conn, doc);
        found.push(...strategyProblems(res.findings));
        strategyCount = res.findings.length;
      } else {
        strategyCount = 0;
      }
    } catch {
      // Same: unknown, not clean.
    }

    if (seqRef.current !== seq || connRef.current !== conn) return;
    setDeep(found);
    setCoverage((c) => ({ ...c, modelBuild: buildState, strategy: strategyCount }));
    setBusy(false);
  }, []);

  // Run the deep checks once per connection, on arrival.
  const deepRanFor = useRef<string | null>(null);
  useEffect(() => {
    if (!connectionId || !overview) return;
    if (deepRanFor.current === connectionId) return;
    deepRanFor.current = connectionId;
    setDeep([]);
    setCoverage({ bestPractice: 0, modelBuild: null, strategy: null });
    void runDeep();
  }, [connectionId, overview, runDeep]);

  return {
    problems: sortProblems([...bp, ...deep]),
    coverage,
    busy,
    recheck: () => void runDeep(),
  };
}
