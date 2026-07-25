# CLOSINGBALANCE

A semi-additive balance: a measure evaluated at the **last** date of the current
date context (the period-end value), rather than summed across the period.

## Syntax

```
CLOSINGBALANCE(<measure>)
```

## Parameters

| Parameter | Description |
|-----------|-------------|
| `measure` | A measure expression (typically a stock measure like inventory on hand, an account balance, or headcount) |

## Why semi-additive

Stock measures are **not** additive over time: summing the daily on-hand quantity
across a month does not give the month's inventory. `CLOSINGBALANCE` instead pins
the measure to the last date present in the context, giving the value *as of the
period end*. `OPENINGBALANCE` is the symmetric first-date value.

## Requirements

**Filter-context only (v1).** The date must be supplied through the **filter**
context (a card, or a pivot grouped by a non-date dimension), not on the
group-by axis:

- The model must mark a date table (`DataModelBuilder::mark_date_table`) with a
  `DateKey`-role `Date`/`Timestamp` column and a Gregorian calendar.
- The engine probes the **maximum** `DateKey` under the active date filter and
  evaluates the measure with a single-day `DateKey = <last date>` filter.
- A date column **on the group-by axis** fails closed
  (`EngineError::TimeIntelligence`) — the per-row balance over a date axis is the
  deferred `LASTDATE`/`FIRSTDATE` primitive.
- A non-Gregorian (fiscal) date table fails closed.

## Examples

```
CLOSINGBALANCE(SUM(fact_inventory[on_hand]))
```

With the context filtered to a month, this is the on-hand quantity on the last
day of that month. Grouped by `dim_warehouse[name]` (no date on the axis), each
warehouse shows its month-end on-hand.

## Execution

Lowered to a filter-context `Keep(Clear(<date roles>), [DateKey = last_date])`
over the marked date table, evaluated locally (the same machinery as
filter-context `YTD` / `DATESINPERIOD`). Never rendered to SQL directly.

## Notes

- `MODEL_FORMAT_VERSION` 9 (AST variant `SemiAdditiveBalance`).
- See [OPENINGBALANCE](OPENINGBALANCE.md) for the period-start value.
- v1 limits: filter-context only; Gregorian calendar; no date-on-axis form;
  `LASTDATE`/`FIRSTDATE`/`LASTNONBLANK` scalar primitives are deferred.
