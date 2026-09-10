// FILENAME: app/extensions/ModelEditor/components/sections/strategy/timeAxis.ts
// PURPOSE: The model-wide time axis: which columns can BE one, and the
//          `MM-DD` fiscal-year start.
// CONTEXT: Implements property (9). The axis is a <select> over the model's own
//          columns for the same reason a scope column is: a typo there is not a
//          broken axis, it is an axis that silently disables every time fact.
//          And a fiscal year START RECURS, so it is refused at the keystroke
//          that commits it rather than at Save — the commonest wrong answer is
//          a full date. See ../StrategySection.tsx.

import type { ModelOverview } from "@api";
import { modelColumnRefs } from "../../../lib/strategyTypes";
import { MONTH_DAY_MAX } from "./constants";

// ===========================================================================

/** One group of columns in the time-axis picker. */
export interface TimeAxisGroup {
  label: string;
  refs: string[];
}

/** Is this column's type one a time series can be plotted against? */
function isDateish(dataType: string): boolean {
  // The backend sends `format!("{:?}", data_type)`, so the two temporal
  // variants of engine-core's `DataType` arrive as exactly these words. This
  // is ORDERING ONLY, never a decision: a type this misses lands in the last
  // group and is still pickable, which is the difference between this and the
  // frontend inference ladder that was deleted for matching `dataType` against
  // exact strings and quietly mis-classifying every `Decimal(38, 10)` column.
  const t = dataType.trim().toLowerCase();
  return t === "date" || t === "timestamp";
}

/**
 * Every column the model has, ordered so the plausible time axes come first.
 *
 * PREFERENCE, NOT A FILTER. The validator errors on an axis that is not a
 * column at all and only WARNS when the axis sits outside the marked date
 * table — a model with no marked date table, or one whose time axis genuinely
 * lives on the fact table, is a real model and must be authorable here. So the
 * marked date table leads, date-typed columns elsewhere follow, and everything
 * else is still on offer underneath.
 *
 * The first group is the whole marked date table rather than its date-TYPED
 * columns, because that is the rule the validator actually applies (it compares
 * the axis's table, not its type) and because a calendar's key column is
 * routinely an integer — filtering by type would demote the very column
 * inference itself picks first.
 */
export function timeAxisGroups(overview: ModelOverview): TimeAxisGroup[] {
  const dateType = new Map<string, string>();
  for (const t of overview.tables) {
    for (const c of t.columns) dateType.set(`${t.name}[${c.name}]`, c.dataType);
  }
  // The same universe the scope editor picks from — one spelling of "the
  // model's columns", so the two pickers cannot come to disagree about it.
  const all = modelColumnRefs(overview);
  const marked = overview.dateTable;
  const inDateTable = (ref: string): boolean =>
    marked !== null && ref.startsWith(`${marked}[`);

  const groups: TimeAxisGroup[] = [
    { label: `marked date table — ${marked ?? ""}`, refs: all.filter(inDateTable) },
    {
      label: "date-typed columns elsewhere",
      refs: all.filter((r) => !inDateTable(r) && isDateish(dateType.get(r) ?? "")),
    },
    {
      label: "every other column",
      refs: all.filter((r) => !inDateTable(r) && !isDateish(dateType.get(r) ?? "")),
    },
  ];
  return groups.filter((g) => g.refs.length > 0);
}


/**
 * Read a fiscal year start, or say why it is not one.
 *
 * A fiscal year start RECURS, so it carries no year: `2026-04-01` is the
 * commonest wrong answer. Nothing reads the field yet (see property (10)), so
 * today a malformed value is a stored trap rather than a wrong report — which
 * is exactly why the check earns its keep: the trap springs on whoever wires
 * the field up, long after the person who typed it has gone. This comment used
 * to say "every period bucket in every fact is derived from this"; it was not
 * true, and it is the overstatement the field's own on-screen note exists to
 * stop repeating.
 *
 * The month/day ranges mirror `MonthDay::new` (`insights/strategy/types.rs`)
 * EXACTLY. The backend is the authority, and a tab that refused something Save
 * would have accepted would be a second, stricter rule nobody wrote down. This
 * comment used to cite a `malformed-fiscal-year-start` arm in
 * `insights/strategy/validate.rs`; that arm was DELETED when the field became a
 * `MonthDay`, and validate.rs now says so in the comment standing where it used
 * to be. The check moved from the validator to the TYPE, which is what raises
 * the stakes here: a malformed value no longer earns a finding, it stops the
 * whole document deserializing. This copy exists to say so at the keystroke
 * rather than at Save.
 *
 * THE DAY IS CHECKED AGAINST ITS MONTH, AND FEBRUARY GETS 29. `MonthDay` used
 * to take any day in 1..=31, so `02-31`, `04-31`, `06-31`, `09-31` and `11-31`
 * were all storable — five days no calendar has, sitting in the document
 * waiting for whoever wires the field up. It does not take the further step of
 * checking `02-29` against a leap year, and neither does this, because AN MM-DD
 * CARRIES NO YEAR: there is no year here to ask about, so 29 is the only
 * defensible ceiling for February.
 *
 * `MONTH_DAY_MAX` is a restatement of a Rust rule and is only a mirror while
 * something diffs it. The guard is in `lib/strategyTypes.test.ts`, beside the
 * closed-set mirrors and the `isValidIsoDate` one, and it is there rather than
 * in this component's own test file so that ONE reading of the Rust source
 * serves both calendars: it parses the `max_day_of_month` match arms out of
 * `insights/strategy/types.rs` at test time and probes this function against
 * them, direction fixed Rust -> TypeScript. `max_day_of_month`, not
 * `days_in_month` — the two are different tables on purpose, and February is
 * where they differ.
 */

export function parseFiscalYearStart(
  text: string,
): { ok: true; value: string | undefined } | { ok: false; error: string } {
  const raw = text.trim();
  if (raw === "") return { ok: true, value: undefined };
  const parts = /^(\d{2})-(\d{2})$/.exec(raw);
  const month = parts ? Number(parts[1]) : NaN;
  const day = parts ? Number(parts[2]) : NaN;
  if (!parts || month < 1 || month > 12) {
    return {
      ok: false,
      error: `'${raw}' is not a fiscal year start. Write MM-DD — a fiscal year starts on the same day every year, so it carries no year (04-01, not 2026-04-01).`,
    };
  }
  const maxDay = MONTH_DAY_MAX[month - 1];
  if (day < 1 || day > maxDay) {
    return {
      ok: false,
      error: `'${raw}' is not a fiscal year start: month ${parts[1]} runs to day ${maxDay}, so there is no such day to start a year on. February is allowed 29 here because an MM-DD carries no year and so cannot know whether the year is a leap year.`,
    };
  }
  return { ok: true, value: raw };
}

// ===========================================================================
// Inheritance — reading what the RESOLVER decided, never deciding it here
