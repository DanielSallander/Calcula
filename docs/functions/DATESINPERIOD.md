# DATESINPERIOD

Evaluates a measure over a trailing window of periods ending at the current context's as-of date (DAX-compatible).

## Syntax

```
DATESINPERIOD(expression, intervals, "granularity")
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `expression` | The aggregate to evaluate over the trailing window. |
| `intervals` | Negative period count — the trailing window size (e.g. `-12` = last 12 periods). |
| `"granularity"` | `"YEAR"`, `"QUARTER"`, `"MONTH"`, or `"WEEK"` (weeks shift by 7 days). |

## Return value

The inner aggregate over `[as-of + 1 day − |intervals| periods, as-of]`, where the as-of date is the latest date present in the current filter context.

## Remarks

- `intervals` must be negative (a trailing window); non-negative counts are rejected with a clear error.
- Filter-context only: a date-table column on the query axis fails closed — remove the date column from the axis, or use a running total (YTD/QTD/MTD) for the per-row form.
- Requires a marked date table with a `DateKey` role column.
- For an ABSOLUTE window independent of the context, use [DATESBETWEEN](DATESBETWEEN.md).

## Example

A rolling-12-months measure:

```
DEFINE Sales R12M = DATESINPERIOD(SUM(fact_sales[linetotal]), -12, "MONTH")
```

With a slicer on March 2024, sums April 2023 through March 2024.

## See also

- [DATESBETWEEN](DATESBETWEEN.md)
- [YTD](YTD.md)
