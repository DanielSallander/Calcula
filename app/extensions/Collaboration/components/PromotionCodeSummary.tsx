// FILENAME: app/extensions/Collaboration/components/PromotionCodeSummary.tsx
// PURPOSE: The first section of the Promote dialog (plan_M8 S5): the CODE that
//          changes for everyone in the environment, and what each change means
//          for them.
// CONTEXT: A promotion decides what code an entire audience runs next. The
//          version diff below it lists every cell edit, and a changed macro used
//          to sit somewhere inside that list -- or, on a FIRST promotion, nowhere
//          at all. This section is read first: a headline (how many changes,
//          and whether everyone is asked to approve the application's code
//          again), then one row per change with its consequence sentence, any
//          capability an object script gains, and the code before and after,
//          collapsed.
//
//          Every word comes from ../lib/promotionCode (one exhaustive table per
//          wire value); a failed comparison is SHOWN as one, never as "no
//          changes".
//
//          The PUSH preview shows this same section first too (owner question
//          14, `act="push"`): the code a push changes against its signed base,
//          said about the development line. One component, so the two can
//          never word the same change differently.

import React from "react";
import type { PromotionCodeChange } from "@api/collaboration";
import {
  CODE_SUMMARY_FAILED_NOTE,
  PROMOTION_CODE_CHANGE,
  PROMOTION_CODE_CONSEQUENCE,
  PROMOTION_CODE_KIND,
  describeCodeHeadline,
  type CodeSummaryAct,
  type PromotionCodeState,
} from "../lib/promotionCode";
import { errorTextStyle, mutedStyle, warnBoxStyle } from "./explorerStyles";

export interface PromotionCodeSummaryProps {
  state: PromotionCodeState;
  /** Who receives it: the environment being promoted ("prod"), or the development line for a push. */
  environment: string;
  /** The environment holds no version yet: every piece of code is new. */
  firstPromotion: boolean;
  toVersion: string;
  /** Which act this summary describes. Default: a promotion. */
  act?: CodeSummaryAct;
}

const codeStyle: React.CSSProperties = {
  margin: "4px 0 0 0",
  padding: "4px 6px",
  maxHeight: 160,
  overflow: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontFamily: "Consolas, 'Cascadia Mono', monospace",
  fontSize: "11px",
  background: "var(--panel-bg-alt, rgba(127, 127, 127, 0.08))",
  border: "1px solid var(--border-default)",
  borderRadius: 3,
};

function CodeText({ label, text, truncated }: { label: string; text: string | null; truncated: boolean }) {
  if (text === null) return null;
  return (
    <div style={{ marginTop: 4 }}>
      <div style={mutedStyle}>
        {label}
        {truncated ? " (cut short: it is longer than the comparison shows)" : ""}
      </div>
      <pre style={codeStyle}>{text}</pre>
    </div>
  );
}

function PromotionCodeRow({ change, environment }: { change: PromotionCodeChange; environment: string }) {
  const kind = PROMOTION_CODE_KIND[change.kind];
  const consequence = PROMOTION_CODE_CONSEQUENCE[change.consequence];
  const consequenceStyle: React.CSSProperties =
    consequence.tone === "error"
      ? { ...errorTextStyle, fontSize: "12px" }
      : consequence.tone === "warn"
        ? { color: "#8a5a00" }
        : consequence.tone === "info"
          ? { color: "var(--text-primary)" }
          : { color: "var(--text-secondary)" };
  const hasCode = change.before !== null || change.after !== null;
  return (
    <div
      data-promotion-code-row={change.id}
      data-promotion-code-kind={change.kind}
      data-promotion-code-change={change.change}
      data-promotion-code-consequence={change.consequence}
      style={{ padding: "6px 0", borderTop: "1px solid var(--border-default)", lineHeight: 1.4 }}
    >
      <div>
        <strong>{kind.label}</strong> {change.name}
        {change.sheetName ? <span style={mutedStyle}> on {change.sheetName}</span> : null}
        <span style={mutedStyle}> · {PROMOTION_CODE_CHANGE[change.change]}</span>
      </div>
      <div data-promotion-code-consequence-text style={consequenceStyle}>
        {consequence.sentence(environment)}
      </div>
      {change.addedCapabilities.length > 0 && (
        <div data-promotion-code-capabilities style={{ color: "#8a5a00" }}>
          It gains {change.addedCapabilities.join(", ")}.
        </div>
      )}
      {change.detail && (
        <div data-promotion-code-detail style={mutedStyle}>
          {change.detail}
        </div>
      )}
      {hasCode && (
        <details data-promotion-code-source>
          <summary style={{ cursor: "pointer", fontSize: "11px" }}>Show the code</summary>
          <CodeText label="Before" text={change.before} truncated={change.beforeTruncated} />
          <CodeText label="After" text={change.after} truncated={change.afterTruncated} />
        </details>
      )}
    </div>
  );
}

export function PromotionCodeSummary({
  state,
  environment,
  firstPromotion,
  toVersion,
  act = "promotion",
}: PromotionCodeSummaryProps) {
  const headline = describeCodeHeadline(state, environment, firstPromotion, toVersion);
  const loud =
    state.status === "failed" ||
    state.asksApprovalAgain ||
    state.changes.some((c) => PROMOTION_CODE_CONSEQUENCE[c.consequence].tone === "error");
  return (
    <div
      data-promotion-code={state.status}
      data-code-summary-act={act}
      style={{ marginTop: 10, marginBottom: 10 }}
    >
      <div
        data-promotion-code-headline
        style={
          state.status === "failed"
            ? { ...errorTextStyle, fontSize: "12px", fontWeight: 600 }
            : loud
              ? { ...warnBoxStyle, marginTop: 0, fontWeight: 600 }
              : { fontWeight: 600 }
        }
      >
        {headline}
      </div>
      {state.status === "failed" && (
        <div style={{ ...mutedStyle, marginTop: 4 }}>{CODE_SUMMARY_FAILED_NOTE[act](environment)}</div>
      )}
      {state.status === "ready" && state.changes.length > 0 && (
        <div style={{ marginTop: 6 }}>
          {state.changes.map((c) => (
            <PromotionCodeRow key={`${c.kind}:${c.id}`} change={c} environment={environment} />
          ))}
          <div style={{ ...mutedStyle, marginTop: 4 }}>
            A forecast from the two versions: approvals follow the exact code, so new or changed
            code asks again. It cannot see a subscriber&rsquo;s own copies or earlier answers.
          </div>
        </div>
      )}
    </div>
  );
}
