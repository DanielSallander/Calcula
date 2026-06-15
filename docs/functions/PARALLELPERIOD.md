# PARALLELPERIOD

Value of a measure shifted by n periods (year, quarter, or month) — a synonym of `PRIORPERIOD`.

## Syntax

```
PARALLELPERIOD(<measure>, <n>, YEAR | QUARTER | MONTH)
```

## Parameters

| Parameter | Description |
|-----------|-------------|
| `measure` | Any measure expression (the computed value is shifted) |
| `n` | Integer shift: negative = earlier periods, positive = later |
| interval | `YEAR`, `QUARTER`, or `MONTH` (bare or quoted, case-insensitive) |

`PARALLELPERIOD(m, n, g)` is exactly `PRIORPERIOD(m, n, g)` — it lowers to the
same `Expression::PeriodShift { offset: n, granularity: g }` AST. The alias
exists for familiarity; for a single-period context it reads as "the parallel
period n steps away".

## Requirements

Same as [PRIORPERIOD](PRIORPERIOD.md):

- **Axis mode** — the date is on `group_by`: the axis must carry the anchor
  columns for the granularity (Year for `YEAR`; Year + Quarter for `QUARTER`;
  Year + Month for `MONTH`), and no finer date column may be on the axis for a
  `QUARTER`/`MONTH` shift.
- **Filter-context mode** — the date is only in the filters: the whole as-of
  window is shifted by `n × months-per-period` calendar months at **any**
  granularity (year, quarter, and month). The date table must be in-memory; a
  non-date `KEEP` wrapper or a connector-served date table fails closed.

## Examples

```
PARALLELPERIOD(SUM(fact_sales[amount]), -1, QUARTER)
```

Identical to `PRIORPERIOD(SUM(fact_sales[amount]), -1, QUARTER)`.

## Execution

Axis mode lowers to SQL `LAG`/`LEAD` over the materialized measure. Filter-context
mode rewrites the active date filter into a shifted half-open date range. Always
executes locally.

## Notes

- **Positional shift contract (axis mode, v1):** the offset moves along the
  sorted distinct axis values *present in the result*; periods missing from the
  data shift to the nearest present period rather than producing blank.
- Cannot be combined with totals (ROLLUP) or hierarchy group-by in v1.
