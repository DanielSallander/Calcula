# OPENINGBALANCE

A semi-additive balance: a measure evaluated at the **first** date of the current
date context (the period-start value), rather than summed across the period.

## Syntax

```
OPENINGBALANCE(<measure>)
```

## Parameters

| Parameter | Description |
|-----------|-------------|
| `measure` | A measure expression (typically a stock measure like inventory on hand, an account balance, or headcount) |

## Why semi-additive

Stock measures are **not** additive over time. `OPENINGBALANCE` pins the measure
to the first date present in the context, giving the value *as of the period
start*. It is the symmetric partner of [CLOSINGBALANCE](CLOSINGBALANCE.md) (the
last-date value).

## Requirements

**Filter-context only (v1)** — identical to [CLOSINGBALANCE](CLOSINGBALANCE.md),
except the engine probes the **minimum** `DateKey` under the active date filter
and evaluates the measure with a single-day `DateKey = <first date>` filter:

- The model must mark a Gregorian date table with a `DateKey`-role column.
- A date column on the group-by axis fails closed
  (`EngineError::TimeIntelligence`); a non-Gregorian date table fails closed.

## Examples

```
OPENINGBALANCE(SUM(fact_inventory[on_hand]))
```

With the context filtered to a month, this is the on-hand quantity on the first
day of that month.

## Execution

Lowered to a filter-context `Keep(Clear(<date roles>), [DateKey = first_date])`
over the marked date table, evaluated locally. Never rendered to SQL directly.

## Notes

- `MODEL_FORMAT_VERSION` 9 (AST variant `SemiAdditiveBalance`).
- See [CLOSINGBALANCE](CLOSINGBALANCE.md) for the period-end value.
- v1 limits: filter-context only; Gregorian calendar; no date-on-axis form.
