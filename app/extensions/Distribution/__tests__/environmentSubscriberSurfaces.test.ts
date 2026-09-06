//! FILENAME: app/extensions/Distribution/__tests__/environmentSubscriberSurfaces.test.ts
// PURPOSE: The four subscriber-side rules that live in components rather than in
//          a testable helper: exactly one target reaches the backend, a switch
//          pulls nothing, an unresolvable environment blocks Apply, and no
//          surface silently re-targets a line subscription.
// CONTEXT: `lib/environments.ts` holds every sentence and every piece of
//          arithmetic BECAUSE those can be tested behaviourally. What is left is
//          wiring — which value is passed to which call, and in which order —
//          and the failures it produces are the expensive kind: a pin sent
//          beside an environment is two claims about what to follow, and one of
//          them silently wins.
//
//          Each rule below names the one-line sabotage that must red it.

import fs from "fs";
import path from "path";
import { describe, it, expect } from "vitest";

const APP_ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(APP_ROOT, rel), "utf8");

/**
 * Strip comments before matching. These files EXPLAIN the rules in prose, so an
 * unstripped scan finds the sentence describing the requirement and passes on
 * an implementation that does not meet it. (`[^:]` keeps `https://` out.)
 */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const SUBSCRIBE = code(read("extensions/Distribution/components/SubscribeDialog.tsx"));
const REFRESH = code(read("extensions/Distribution/components/RefreshPreviewDialog.tsx"));
const MANAGER = code(read("extensions/Distribution/components/SubscriptionManagerPane.tsx"));
const API = code(read("src/api/distribution.ts"));

describe("exactly one target reaches the backend", () => {
  it("sends no pin when an environment is chosen, in BOTH calls", () => {
    // A pin beside an environment is two claims about what to follow, and the
    // backend refuses rather than letting one win — but only if the frontend
    // actually stops sending the stale one.
    //
    // BOTH means both. The two needles here used to be satisfied by the PULL
    // call alone — the second is a substring of the first — so deleting the
    // guard from `inspectApplication` left this green.
    // SABOTAGE: `versionPin,` in either call.
    const occurrences = SUBSCRIBE.split('environment ? "" : versionPin').length - 1;
    expect(occurrences, "the pin is suppressed in inspect AND in pull").toBe(2);
    expect(SUBSCRIBE).toContain('versionPin: environment ? "" : versionPin,');
  });

  it("marks a line subscription as DELIBERATE rather than defaulting to it", () => {
    // The line receives every push the moment it lands. A subscribe that names
    // no environment on an application that has them is refused, and this flag
    // is the only thing that can say "yes, I mean the line".
    // AND IT IS A CHOICE, not the absence of one. `followLine: !environment`
    // asserted a deliberate line subscription on every subscribe that had not
    // picked an environment — including one where the user typed an application
    // name and was never OFFERED an environment, so the backend refusal that
    // names them could not fire.
    // SABOTAGE: `followLine: !environment` or `followLine: true`.
    expect(SUBSCRIBE).toContain("followLine: !environment && lineChosen,");
    expect(SUBSCRIBE).not.toContain("followLine: true");
    // The flag is only ever set by an explicit control.
    expect(SUBSCRIBE).toContain("setLineChosen(true)");
  });

  it("defaults a new subscriber to the LAST environment", () => {
    // Production by convention. Seating them on the first would put every
    // consumer on the test environment.
    // SABOTAGE: `setEnvironment(pkg.environments[0]?.name ?? null)`.
    expect(SUBSCRIBE).toContain("setEnvironment(defaultEnvironment(pkg.environments))");
  });

  it("never encodes an environment inside a pin string", () => {
    // The dead `channel:` convention: a magic prefix eleven call sites had to
    // special-case while nothing ever produced one. `VersionPin::parse` refuses
    // it by name now, so a string built here would fail at the backend — but
    // loudly is not the same as never.
    // SABOTAGE: `versionPin: \`env:${environment}\``.
    const needle = ["env", ":"].join("") + "$";
    for (const src of [SUBSCRIBE, REFRESH, MANAGER]) {
      expect(src.includes("`" + needle + "{")).toBe(false);
    }
  });
});

describe("switching an environment pulls nothing", () => {
  it("re-runs the PREVIEW rather than a refresh, in both surfaces", () => {
    // A two-word choice in a dropdown must never be an unreviewed content
    // change. The switch records intent; the user still reviews and applies.
    // SABOTAGE: call `refreshApply()` after the switch in either file.
    expect(REFRESH).toContain("setSubscriptionEnvironment(");
    expect(MANAGER).toContain("setSubscriptionEnvironment(");

    // The switcher's aftermath is the preview, not the apply.
    const switcher = REFRESH.slice(REFRESH.indexOf("function EnvironmentSwitcher"));
    expect(switcher).toContain("onSwitched()");
    expect(switcher).not.toContain("refreshApply(");
  });

  it("says so in the wrapper itself, so a third caller inherits the rule", () => {
    // SABOTAGE: have `setSubscriptionEnvironment` pull after recording.
    const fn = API.slice(API.indexOf("export function setSubscriptionEnvironment"));
    expect(fn.slice(0, 400)).toContain("calp_set_subscription_environment");
    expect(fn.slice(0, 400)).not.toContain("calp_refresh_apply");
  });

  it("returning to the LINE carries a pin, because the line has no pointer", () => {
    // An empty pin on a line subscription resolves to nothing: `VersionPin::parse("")`
    // errs, which is deliberate — it makes a forgotten environment branch fail
    // loudly instead of reporting "up to date" forever. So the switch back has
    // to supply one.
    // SABOTAGE: drop the ternary and always send "".
    expect(REFRESH).toContain('versionPin: target === null ? "latest" : ""');
    expect(MANAGER).toContain('versionPin: environment === null ? "latest" : ""');
  });
});

describe("an unresolvable environment blocks the whole refresh", () => {
  it("disables Apply while any subscription is unavailable", () => {
    // A refresh is ONE gesture over every subscription in the workbook.
    // Applying while one sat out would leave that report on an old version with
    // nothing on screen having said so.
    // SABOTAGE: drop `|| unavailable.length > 0` from the disabled expression.
    expect(REFRESH).toContain("disabled={applying || blocked || unavailable.length > 0}");
  });

  it("renders the stranded rows OUTSIDE the has-updates branch", () => {
    // A workbook whose only subscription is stranded has no updates to show, so
    // a block nested under `hasUpdates` would render "all up to date" over a
    // subscription that cannot refresh at all.
    // SABOTAGE: move the unavailable block inside `hasUpdates && preview &&`.
    //
    // ORDER IS NOT ENOUGH: a block placed before the has-updates branch could
    // still be nested inside another condition that hides it. The guard also
    // reads the condition the block is actually rendered under.
    const at = REFRESH.indexOf("unavailable.length > 0 && (");
    const hasUpdatesAt = REFRESH.indexOf("!result && hasUpdates && preview && (");
    expect(at).toBeGreaterThan(0);
    expect(hasUpdatesAt).toBeGreaterThan(0);
    expect(at).toBeLessThan(hasUpdatesAt);
    const condition = REFRESH.slice(Math.max(0, at - 90), at);
    expect(condition, "the stranded rows must not be gated on having updates").not.toContain(
      "hasUpdates",
    );
  });

  it("offers a way out of the block rather than only naming it", () => {
    // SABOTAGE: delete the switcher from the unavailable card. Apply is then
    // disabled with no control on screen that can re-enable it.
    //
    // The slice used to run to the has-updates branch, which swallowed the
    // NOTICES block and its own switcher — so the guard passed on the notice's
    // control while the stranded card had none. It now ends at the notices.
    const start = REFRESH.indexOf("unavailable.length > 0 && (");
    const noticesAt = REFRESH.indexOf("notices.length > 0 && (");
    expect(noticesAt).toBeGreaterThan(start);
    const block = REFRESH.slice(start, noticesAt);
    expect(block).toContain("EnvironmentSwitcher");
  });
});

describe("a line subscription is never re-targeted behind the user's back", () => {
  it("offers the switch and takes a refusal for an answer", () => {
    // Moving somebody's subscription because their publisher added environments
    // would change what they receive without their asking.
    // SABOTAGE: call `setSubscriptionEnvironment` from the notice's own effect.
    //
    // Presence of the words was not enough: the guard passed on a "Not now"
    // button that did nothing. It now checks the button actually dismisses.
    expect(REFRESH).toContain("Not now");
    const notNowAt = REFRESH.indexOf("Not now");
    const handler = REFRESH.slice(Math.max(0, notNowAt - 400), notNowAt);
    expect(handler, "the button must record the dismissal").toContain("setDismissedNotices");
    // The dismissal is per-showing: the condition persists, so a permanent
    // dismissal would hide a real difference forever.
    expect(REFRESH).toContain("setDismissedNotices(new Set());");
  });

  it("says the notice permanently in the pane, where nobody is mid-decision", () => {
    // The refresh preview's copy is dismissible because the user is deciding
    // something else at that moment. The pane is where the state lives.
    // SABOTAGE: make the pane's notice dismissible too.
    expect(MANAGER).toContain("followsLineWithPipeline");
    expect(MANAGER).not.toContain("dismissedNotices");
  });

  it("does not render a pin against an environment subscription", () => {
    // An environment subscription carries no pin at all, so "(pin )" would be a
    // second, empty answer to what it is following.
    // SABOTAGE: drop `!followsEnvironment &&` from `stale`.
    //
    // The bare needle matched a second, unrelated occurrence, so deleting it
    // from the `stale` expression left the guard green. It now reads the whole
    // expression.
    expect(MANAGER).toContain("const followsEnvironment = !!s.environment;");
    expect(MANAGER).toContain(
      "const stale =\n              !followsEnvironment &&",
    );
  });
});
