//! FILENAME: app/src/api/scriptHost/brokerPolicy.ts
// PURPOSE: The broker's admit/refuse DECISION for one call, as a pure function
//          over the ALLOWLIST — extracted so it has exactly one implementation.
// CONTEXT: docs/design/script-sandbox-architecture.md §5.1; the preview rung in
//          docs/design/local-model-script-authoring.md §5c.
//
//          WHY IT IS ITS OWN MODULE. `brokerCall` is the enforcement point and
//          must stay so, but it lives in `broker.ts`, which reaches the audit
//          ring, the live grant store and `invokeBackend` — i.e. Tauri. The
//          OFFLINE eval harness runs candidates in a Node subprocess with no
//          Tauri and no renderer, and so could not import it. It therefore
//          carried its own hand-rolled copy of the order below: ALLOWLIST
//          lookup, then `validate`, then the declared ceiling. That copy was a
//          second source of truth for policy — the exact thing the design doc
//          warns about ("a duplicate would be a second copy of the security
//          gate") — and it was already INCOMPLETE: it never checked the tier.
//
//          So the decision moved here, where it depends on nothing but the
//          policy table, and both callers consume it:
//            - `broker.ts::checkPolicy` audits a refusal and throws BrokerError
//            - the preview harness turns a refusal into the same rejected call
//          A refusal's ORDER and MESSAGE are therefore the same in both, which
//          is what makes the corpus's Layer A anchor evidence about the product.
//
//          THIS MODULE DECIDES AND DOES NOT ACT. It appends no audit, throws no
//          BrokerError, and touches no state — those belong to the enforcement
//          point. Keeping it inert is what lets it be shared without carrying
//          the enforcement point's dependencies along with it.

import { ALLOWLIST, type CapabilityId, type MethodClass, type MethodPolicy } from "./allowlist";

/** The refusal codes this decision can produce. Mirrors `RpcErrorCode`. */
export type PolicyRefusalCode =
  | "UnknownMethod"
  | "ValidationError"
  | "PermissionDenied"
  | "CapabilityRequired";

/**
 * The parts of a `ScriptHandle` a policy decision actually reads. Deliberately
 * narrower than the handle: a decision that cannot see the script's id or name
 * cannot accidentally depend on WHO is calling rather than on what it declared.
 */
export interface PolicyIdentity {
  tier: "restricted" | "unlocked";
  grants: ReadonlySet<CapabilityId>;
  declaredCapabilities: ReadonlySet<CapabilityId>;
}

export type PolicyDecision =
  | { admitted: true; policy: MethodPolicy }
  | {
      admitted: false;
      /** The class to audit the refusal under ("emit" for an unknown method). */
      class: MethodClass;
      code: PolicyRefusalCode;
      message: string;
      capability?: CapabilityId;
      /** Null only for an unknown method, which has no policy row. */
      policy: MethodPolicy | null;
    };

/**
 * Decide whether one call is admitted, in the order the broker has always used.
 *
 * VALIDATION RUNS BEFORE THE TIER CHECK, deliberately: a refusal message that
 * distinguished "wrong tier" from "bad arguments" would let a restricted script
 * probe the policy table by watching which complaint it gets.
 *
 * THE DECLARED CEILING (R19) IS CHECKED BEFORE THE GRANT. A capability the
 * script never declared is refused here, so it is also never JIT-prompted — a
 * script cannot acquire reach by asking for it at run time. This ordering is
 * what makes an EMPTY declared set a total, structural refusal of every
 * capability-bearing method, which is in turn what makes a preview safe.
 */
export function decidePolicy(
  identity: PolicyIdentity,
  method: string,
  args: unknown[],
): PolicyDecision {
  const policy = ALLOWLIST[method];
  if (!policy) {
    return {
      admitted: false,
      class: "emit",
      code: "UnknownMethod",
      message: `Unknown script method: ${method}`,
      policy: null,
    };
  }

  const valid = policy.validate(args);
  if (valid !== true) {
    return {
      admitted: false,
      class: policy.class,
      code: "ValidationError",
      message: `${method}: ${valid}`,
      policy,
    };
  }

  if (policy.tier === "unlocked" && identity.tier !== "unlocked") {
    return {
      admitted: false,
      class: policy.class,
      code: "PermissionDenied",
      message: `${method} requires unlocked access; this script is restricted`,
      policy,
    };
  }

  if (policy.capability && !identity.declaredCapabilities.has(policy.capability)) {
    return {
      admitted: false,
      class: policy.class,
      code: "PermissionDenied",
      message: `${method} requires the '${policy.capability}' capability, which this script did not declare`,
      capability: policy.capability,
      policy,
    };
  }

  if (policy.capability && !identity.grants.has(policy.capability)) {
    return {
      admitted: false,
      class: policy.class,
      code: "CapabilityRequired",
      message: `${method} requires the '${policy.capability}' capability`,
      capability: policy.capability,
      policy,
    };
  }

  return { admitted: true, policy };
}
