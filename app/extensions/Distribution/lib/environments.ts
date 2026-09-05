// FILENAME: app/extensions/Distribution/lib/environments.ts
// PURPOSE: Every sentence and every piece of pipeline arithmetic the environment
//          surfaces need, as pure functions a test can hold.
// CONTEXT: An environment is a named pointer to a version on ONE development
//          line; promotion moves the pointer and copies nothing. The decisions a
//          user makes here — promote to prod, roll back, switch which stream a
//          workbook follows — are the ones where a wrong sentence costs the most,
//          so the sentences live in one tested place rather than inline in four
//          components that drift.
//
//          NO REACT, NO IPC. A component that wants to say something asks here.

import type { EnvironmentPointer, EnvironmentSummary } from "@api/distribution";

/** Names an environment may not take, mirroring `RESERVED_ENVIRONMENT_NAMES`. */
export const RESERVED_ENVIRONMENT_NAMES: readonly string[] = [
  "dev",
  "latest",
  "head",
  "line",
];

/** A pointer or a summary — the two shapes the same environment arrives in. */
type AnyEnvironment = { name: string; version?: string | null };

/**
 * Compare two semver strings NUMERICALLY.
 *
 * `"1.9.0" > "1.10.0"` lexicographically, and a rollback across a two-digit
 * minor is exactly when a subscriber most needs to be told which way they are
 * going. An unparseable version sorts last rather than throwing: this feeds
 * display, and a malformed pointer must not blank a panel.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const parse = (v: string): number[] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x && !y) return 0;
  if (!x) return 1;
  if (!y) return -1;
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

/** True when moving from `from` to `to` goes BACKWARDS. */
export function isRollback(from: string, to: string): boolean {
  if (!from || !to) return false;
  return compareSemver(to, from) < 0;
}

/**
 * The environment a subscriber should be offered by default: the LAST.
 *
 * Production by convention — the pipeline is ordered, and the end of it is what
 * consumers consume. Offering the first would seat every new subscriber on test.
 */
export function defaultEnvironment(envs: readonly AnyEnvironment[]): string | null {
  return envs.length > 0 ? envs[envs.length - 1].name : null;
}

/**
 * The environment that comes after `name`, or the FIRST when `name` is null.
 * `null` when `name` is the last — there is nothing further to promote to.
 */
export function nextEnvironment(
  pipeline: readonly string[],
  name: string | null,
): string | null {
  if (name === null) return pipeline.length > 0 ? pipeline[0] : null;
  const i = pipeline.indexOf(name);
  if (i < 0 || i + 1 >= pipeline.length) return null;
  return pipeline[i + 1];
}

/**
 * Where a promotion into `target` draws from: the development line for the
 * first environment, the previous environment otherwise.
 */
export function promotionSource(
  envs: readonly AnyEnvironment[],
  lineHead: string,
  target: string,
): { label: string; version: string } {
  const i = envs.findIndex((e) => e.name === target);
  if (i <= 0) return { label: "the development line", version: lineHead };
  const previous = envs[i - 1];
  return { label: previous.name, version: previous.version ?? "" };
}

/** The environments currently pointing at `version`, in pipeline order. */
export function environmentsAtVersion(
  envs: readonly AnyEnvironment[],
  version: string,
): string[] {
  if (!version) return [];
  return envs.filter((e) => e.version === version).map((e) => e.name);
}

/** `v1.2.0 · prod`, `v1.5.0 · head`, `v1.5.0 · head · test`. */
export function versionLabel(
  version: string,
  envs: readonly AnyEnvironment[],
  lineHead: string,
): string {
  const tags: string[] = [];
  if (version && version === lineHead) tags.push("head");
  tags.push(...environmentsAtVersion(envs, version));
  return tags.length > 0 ? `v${version} · ${tags.join(" · ")}` : `v${version}`;
}

/**
 * The versions an environment may be rolled back to: the ones it has HELD,
 * newest first, minus where it is now.
 *
 * From the environment's own history, not "every older version on the line".
 * A version this environment never ran is not a rollback target — it is an
 * untested promotion wearing a rollback's clothes, and the backend refuses it.
 */
export function rollbackCandidates(env: EnvironmentPointer): string[] {
  return (env.heldVersions ?? []).filter((v) => v !== (env.version ?? ""));
}

/** Whether this subscription follows the line while its application has a pipeline. */
export function subscriptionFollowsLine(
  sub: { environment?: string | null },
  envs: readonly { name: string }[],
): boolean {
  return !sub.environment && envs.length > 0;
}

/** `sales (prod)` — or just `sales` for a line subscription. */
export function formatSubscriptionTarget(
  packageName: string,
  environment?: string | null,
): string {
  return environment ? `${packageName} (${environment})` : packageName;
}

/**
 * The refresh card's two lines, and whether it is going backwards.
 *
 * The direction has to be in the words. A subscriber who reads a downgrade as
 * an update concludes the publisher changed those cells; what actually happened
 * is that a known-good version was restored, and the conflicts they are about
 * to resolve are against the OLDER content.
 */
export function describeRefreshCard(p: {
  packageName: string;
  environment?: string | null;
  currentVersion: string;
  newVersion: string;
}): { title: string; versions: string; rollback: boolean } {
  const rollback = isRollback(p.currentVersion, p.newVersion);
  return {
    title: formatSubscriptionTarget(p.packageName, p.environment),
    versions: rollback
      ? `v${p.currentVersion} → v${p.newVersion} — rolled back`
      : `v${p.currentVersion} → v${p.newVersion}`,
    rollback,
  };
}

/**
 * The promotion confirm: what it is called, what it says, and how loud.
 *
 * Every clause earns its place. It names the environment and BOTH versions,
 * because "promote" without them is a button whose effect the user has to
 * remember. It says nothing changes on anyone's machine until they refresh,
 * because the alternative reading — that a promotion pushes content at people —
 * is what makes users afraid to promote. And it says it can be rolled back,
 * because that is the fact that makes this a reversible decision.
 */
export function describePromotion(p: {
  packageName: string;
  environment: string;
  fromVersion: string | null;
  toVersion: string;
  sourceLabel: string;
  mode: "promote" | "rollback";
}): { title: string; message: string; okLabel: string; kind?: "warning" } {
  if (p.mode === "rollback") {
    return {
      title: `Roll back ${p.environment}`,
      okLabel: "Roll back",
      kind: "warning",
      message:
        `Roll "${p.packageName}" ${p.environment} back from v${p.fromVersion} to ` +
        `v${p.toVersion}?\n\n` +
        `Everyone subscribed to ${p.environment} will be offered v${p.toVersion} — an ` +
        `OLDER version — at their next refresh, and their refresh preview will say so. ` +
        `Cells they have edited keep their overrides. This is recorded as a promotion ` +
        `signed by you, and promoting v${p.fromVersion} again undoes it.`,
    };
  }
  const opening = p.fromVersion
    ? `Promote "${p.packageName}" to ${p.environment}: v${p.fromVersion} → v${p.toVersion} ` +
      `(from ${p.sourceLabel}).`
    : `Promote "${p.packageName}" to ${p.environment}: v${p.toVersion} (from ` +
      `${p.sourceLabel}) — ${p.environment} has no version yet.`;
  return {
    title: `Promote to ${p.environment}`,
    okLabel: "Promote",
    message:
      `${opening}\n\n` +
      `Everyone subscribed to ${p.environment} will be offered v${p.toVersion} at their ` +
      `next refresh; nothing changes on their machines until they apply it. No files ` +
      `are copied — ${p.environment} is a pointer — and you can roll it back at any time ` +
      `from the Application Explorer.`,
  };
}

/**
 * The sentence after a push that says where the release now stands.
 *
 * Empty when the application has no environments: adding "and no environments
 * exist" to every push in every solo workbook would be noise about a feature
 * that user has not adopted.
 */
export function describePushLanding(
  version: string,
  envs: readonly AnyEnvironment[],
): string {
  if (envs.length === 0) return "";
  const parts = envs.map((e) =>
    e.version ? `${e.name} is at v${e.version}` : `${e.name} has nothing yet`,
  );
  return `${parts.join(", ")} — promote from the Application Explorer.`;
}

/**
 * Why a pipeline cannot be saved as typed, or `null` when it can.
 *
 * Names are compared across machines, so `Prod` and `prod` being different
 * environments would strand subscribers on whichever spelling their dialog
 * happened to show.
 */
export function pipelineEditValidation(names: readonly string[]): string | null {
  if (names.length > 32) return "An application may define at most 32 environments.";
  const seen = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    if (!name) return "Every environment needs a name.";
    if (name.length > 32) return `"${name}" is longer than 32 characters.`;
    if (!/^[a-z0-9-]+$/.test(name)) {
      return `"${name}" — use lowercase letters, digits and hyphens only.`;
    }
    if (name.startsWith("-") || name.endsWith("-")) {
      return `"${name}" must not start or end with a hyphen.`;
    }
    if (RESERVED_ENVIRONMENT_NAMES.includes(name)) {
      return (
        `"${name}" already means something else here — "dev" is the local preview ` +
        `subscription, and "latest", "head" and "line" name the development line.`
      );
    }
    if (seen.has(name)) return `"${name}" is listed twice.`;
    seen.add(name);
  }
  return null;
}

/**
 * Resolve an Inspector version `<select>` choice to a version.
 *
 * `env:prod` is a UI-LOCAL encoding, resolved here before any backend call ever
 * sees it. It must never travel: a prefix inside a pin string is the dead
 * `channel:` convention, and `VersionPin::parse` refuses it by name.
 */
export function resolveVersionChoice(
  choice: string,
  envs: readonly AnyEnvironment[],
): { version: string } | { error: string } {
  if (!choice.startsWith("env:")) return { version: choice };
  const name = choice.slice(4);
  const env = envs.find((e) => e.name === name);
  if (!env) return { error: `This application has no environment called "${name}".` };
  if (!env.version) {
    return { error: `Nothing has been promoted into "${name}" yet.` };
  }
  return { version: env.version };
}

/** Summaries and pointers both answer `{ name, version }`. */
export function summarize(
  envs: readonly (EnvironmentPointer | EnvironmentSummary)[],
): AnyEnvironment[] {
  return envs.map((e) => ({ name: e.name, version: e.version ?? null }));
}
