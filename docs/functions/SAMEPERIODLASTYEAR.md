# SAMEPERIODLASTYEAR

Shifts the measure's date context back by exactly one year — the same-period-last-year comparison. `SAMEPERIODLASTYEAR` is an exact synonym for [PRIORYEAR](PRIORYEAR.md): both parse to the same period-shift node (shift −1 year), so everything documented for `PRIORYEAR` applies unchanged.

## Syntax

```
SAMEPERIODLASTYEAR(aggregate)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `aggregate` | The measure expression to evaluate against the year-shifted date context (e.g. `SUM(fact_sales[amount])`). |

## Remarks

- Requires the model's marked date table (see [PRIORYEAR](PRIORYEAR.md) for the date-role requirements).
- **Filter-context mode** (no date column on the axis): the current date window `[min, as-of]` is shifted back 12 calendar months. This is the same-period-last-year value.
- **Axis mode** (date-role columns on `group_by`): a positional one-year LAG per period; a gapped axis fails closed with a typed error rather than reading the wrong period.
- Fiscal (non-Gregorian) calendars fail closed on the shift path — the year-shift is Gregorian.
- Composes into compound arithmetic for year-over-year measures, e.g. `SUM(fact_sales[amount]) - SAMEPERIODLASTYEAR(SUM(fact_sales[amount]))`.

## Example

```
DEFINE Sales PY = SAMEPERIODLASTYEAR(SUM(fact_sales[amount]))
DEFINE YoY Growth = DIVIDE(
    SUM(fact_sales[amount]) - SAMEPERIODLASTYEAR(SUM(fact_sales[amount])),
    SAMEPERIODLASTYEAR(SUM(fact_sales[amount]))
)
```

## See also

- [PRIORYEAR](PRIORYEAR.md) — the identical function under its primary name
- [PRIORPERIOD](PRIORPERIOD.md) — a shift by an arbitrary number of years/quarters/months
- [PARALLELPERIOD](PARALLELPERIOD.md) — signed period shift
- [YTD](YTD.md) — year-to-date running total
