//! FILENAME: app/extensions/Distribution/lib/__tests__/environments.test.ts
// PURPOSE: The pipeline arithmetic and every sentence the environment surfaces
//          put in front of a decision.
// CONTEXT: Promoting to prod and rolling it back are the two most consequential
//          gestures in the distribution stack, and both are irreversible in the
//          sense that matters: every subscriber sees the result. The words
//          matter as much as the arithmetic, so both are tested here rather than
//          left inline in components a source-text guard can only sniff at.

import { describe, it, expect } from "vitest";
import {
  compareSemver,
  isRollback,
  defaultEnvironment,
  nextEnvironment,
  promotionSource,
  environmentsAtVersion,
  versionLabel,
  rollbackCandidates,
  subscriptionFollowsLine,
  formatSubscriptionTarget,
  describeRefreshCard,
  describePromotion,
  describePushLanding,
  pipelineEditValidation,
  resolveVersionChoice,
  RESERVED_ENVIRONMENT_NAMES,
} from "../environments";
import type { EnvironmentPointer } from "@api/distribution";

const env = (name: string, version: string | null, held: string[] = []): EnvironmentPointer => ({
  name,
  version,
  previousVersion: "",
  promotedAt: "2026-09-05T00:00:00Z",
  promotedBy: "alice",
  promoterKey: "aa",
  isYou: true,
  sequence: 1,
  heldVersions: held,
});

describe("pipeline arithmetic", () => {
  it("compares versions NUMERICALLY, not as strings", () => {
    // 1.9.0 > 1.10.0 lexicographically, and a rollback across a two-digit minor
    // is exactly when a subscriber most needs the direction to be right.
    // SABOTAGE: `a < b` on the raw strings.
    expect(compareSemver("1.9.0", "1.10.0")).toBe(-1);
    expect(isRollback("1.10.0", "1.9.0")).toBe(true);
    expect(isRollback("1.9.0", "1.10.0")).toBe(false);
    expect(isRollback("1.2.0", "1.2.0")).toBe(false);
  });

  it("does not throw on a malformed version", () => {
    // This feeds display. A malformed pointer must not blank a panel.
    expect(compareSemver("", "1.0.0")).toBe(1);
    expect(isRollback("", "1.0.0")).toBe(false);
  });

  it("defaults a subscriber to the LAST environment", () => {
    // Production by convention: the pipeline is ordered, and the end of it is
    // what consumers consume.
    // SABOTAGE: return `envs[0]` — every new subscriber lands on test.
    expect(defaultEnvironment([env("test", "1.0.0"), env("prod", "1.0.0")])).toBe("prod");
    expect(defaultEnvironment([])).toBeNull();
  });

  it("walks the pipeline forward, and stops at the end", () => {
    // SABOTAGE: return `pipeline[i]` instead of `pipeline[i + 1]`.
    expect(nextEnvironment(["test", "prod"], null)).toBe("test");
    expect(nextEnvironment(["test", "prod"], "test")).toBe("prod");
    expect(nextEnvironment(["test", "prod"], "prod")).toBeNull();
    expect(nextEnvironment([], null)).toBeNull();
  });

  it("draws the first environment from the LINE and the rest from the one before", () => {
    // SABOTAGE: always use `envs[i - 1]` — the first environment then has
    // nothing to promote from and the pipeline can never be started.
    const envs = [env("test", "1.3.0"), env("prod", "1.2.0")];
    expect(promotionSource(envs, "1.5.0", "test")).toEqual({
      label: "the development line",
      version: "1.5.0",
    });
    expect(promotionSource(envs, "1.5.0", "prod")).toEqual({
      label: "test",
      version: "1.3.0",
    });
  });

  it("labels a version with the head and every environment on it", () => {
    const envs = [env("test", "1.5.0"), env("prod", "1.2.0")];
    expect(versionLabel("1.5.0", envs, "1.5.0")).toBe("v1.5.0 · head · test");
    expect(versionLabel("1.2.0", envs, "1.5.0")).toBe("v1.2.0 · prod");
    expect(versionLabel("1.3.0", envs, "1.5.0")).toBe("v1.3.0");
    expect(environmentsAtVersion(envs, "")).toEqual([]);
  });

  it("offers only versions the environment has HELD, minus where it is now", () => {
    // A version this environment never ran is not a rollback target — it is an
    // untested promotion wearing a rollback's clothes, and the backend refuses
    // it. Offering it would produce a button that always fails.
    // SABOTAGE: return every version older than the current one.
    const prod = env("prod", "1.5.0", ["1.5.0", "1.2.0", "1.0.0"]);
    expect(rollbackCandidates(prod)).toEqual(["1.2.0", "1.0.0"]);
    expect(rollbackCandidates(env("test", null, []))).toEqual([]);
  });
});

describe("what the surfaces say", () => {
  it("names the environment beside the application", () => {
    expect(formatSubscriptionTarget("sales", "prod")).toBe("sales (prod)");
    expect(formatSubscriptionTarget("sales", null)).toBe("sales");
  });

  it("says ROLLED BACK when a refresh goes backwards", () => {
    // A subscriber who reads a downgrade as an update concludes the publisher
    // changed those cells. What happened is that a known-good version was
    // restored, and the conflicts they are about to resolve are against the
    // OLDER content.
    // SABOTAGE: drop the rollback branch.
    const back = describeRefreshCard({
      packageName: "sales",
      environment: "prod",
      currentVersion: "1.5.0",
      newVersion: "1.2.0",
    });
    expect(back.title).toBe("sales (prod)");
    expect(back.versions).toBe("v1.5.0 → v1.2.0 — rolled back");
    expect(back.rollback).toBe(true);

    const forward = describeRefreshCard({
      packageName: "sales",
      environment: "prod",
      currentVersion: "1.2.0",
      newVersion: "1.5.0",
    });
    expect(forward.versions).toBe("v1.2.0 → v1.5.0");
    expect(forward.rollback).toBe(false);
  });

  it("promotes with both versions, the source, and the fact it is reversible", () => {
    // Every clause earns its place: without the versions the button's effect
    // has to be remembered; without "nothing changes until they apply it"
    // people read a promotion as pushing content at users; without "roll it
    // back" they treat a reversible decision as final.
    // SABOTAGE: shorten the message to "Promote?".
    const m = describePromotion({
      packageName: "sales",
      environment: "prod",
      fromVersion: "1.2.0",
      toVersion: "1.5.0",
      sourceLabel: "test",
      mode: "promote",
    });
    expect(m.title).toBe("Promote to prod");
    expect(m.okLabel).toBe("Promote");
    expect(m.kind).toBeUndefined();
    expect(m.message).toContain("v1.2.0 → v1.5.0");
    expect(m.message).toContain("from test");
    expect(m.message).toContain("nothing changes on their machines until they apply it");
    expect(m.message).toContain("roll it back");
  });

  it("says an empty target has no version yet, rather than promoting from null", () => {
    const m = describePromotion({
      packageName: "sales",
      environment: "test",
      fromVersion: null,
      toVersion: "1.5.0",
      sourceLabel: "the development line",
      mode: "promote",
    });
    expect(m.message).toContain("test has no version yet");
    expect(m.message).not.toContain("null");
  });

  it("shouts OLDER on a rollback, and warns", () => {
    // SABOTAGE: reuse the promote text with the versions swapped.
    const m = describePromotion({
      packageName: "sales",
      environment: "prod",
      fromVersion: "1.5.0",
      toVersion: "1.2.0",
      sourceLabel: "prod",
      mode: "rollback",
    });
    expect(m.title).toBe("Roll back prod");
    expect(m.okLabel).toBe("Roll back");
    expect(m.kind).toBe("warning");
    expect(m.message).toContain("OLDER");
    expect(m.message).toContain("keep their overrides");
  });

  it("says where the release stands after a push, and nothing when there is no pipeline", () => {
    // SABOTAGE: always mention environments. Every push in every solo workbook
    // then carries noise about a feature that user has not adopted.
    expect(describePushLanding("1.5.0", [])).toBe("");
    expect(
      describePushLanding("1.5.0", [env("test", "1.3.0"), env("prod", null)]),
    ).toBe("test is at v1.3.0, prod has nothing yet — promote from the Application Explorer.");
  });
});

describe("editing the pipeline", () => {
  it("accepts a plain pipeline", () => {
    expect(pipelineEditValidation(["test", "prod"])).toBeNull();
    expect(pipelineEditValidation(["uat", "pre-prod", "prod"])).toBeNull();
    expect(pipelineEditValidation([])).toBeNull();
  });

  it("refuses names that would strand a subscriber or collide with something else", () => {
    // Names are compared across machines: `Prod` and `prod` being different
    // environments would strand subscribers on whichever spelling their dialog
    // happened to show.
    // SABOTAGE: drop the reserved list, or the case rule.
    expect(pipelineEditValidation([""])).toContain("needs a name");
    expect(pipelineEditValidation(["Prod"])).toContain("lowercase");
    expect(pipelineEditValidation(["-x"])).toContain("hyphen");
    expect(pipelineEditValidation(["prod", "prod"])).toContain("listed twice");
    for (const reserved of RESERVED_ENVIRONMENT_NAMES) {
      expect(pipelineEditValidation([reserved])).toContain("already means something else");
    }
  });
});

describe("the Inspector's version choice", () => {
  it("resolves an environment choice CLIENT-SIDE, so no prefix ever travels", () => {
    // `env:prod` inside a pin string is the dead `channel:` convention: a magic
    // prefix every parser has to special-case. `VersionPin::parse` refuses it,
    // so this has to resolve before any backend call sees it.
    // SABOTAGE: pass the choice through unchanged.
    const envs = [env("test", "1.5.0"), env("prod", "1.2.0")];
    expect(resolveVersionChoice("env:prod", envs)).toEqual({ version: "1.2.0" });
    expect(resolveVersionChoice("=1.3.0", envs)).toEqual({ version: "=1.3.0" });
    expect(resolveVersionChoice("latest", envs)).toEqual({ version: "latest" });
  });

  it("explains an environment it cannot resolve rather than sending nothing", () => {
    const envs = [env("test", null)];
    expect(resolveVersionChoice("env:test", envs)).toEqual({
      error: 'Nothing has been promoted into "test" yet.',
    });
    expect(resolveVersionChoice("env:gone", envs)).toEqual({
      error: 'This application has no environment called "gone".',
    });
  });
});

describe("a line subscription on an application that grew a pipeline", () => {
  it("is recognised, and only when there is actually a pipeline", () => {
    // SABOTAGE: drop the `envs.length > 0` half — every line subscription in
    // every workbook then nags about environments that do not exist.
    expect(subscriptionFollowsLine({ environment: null }, [{ name: "prod" }])).toBe(true);
    expect(subscriptionFollowsLine({ environment: "prod" }, [{ name: "prod" }])).toBe(false);
    expect(subscriptionFollowsLine({ environment: null }, [])).toBe(false);
  });
});
