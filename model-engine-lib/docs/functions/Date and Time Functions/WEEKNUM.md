# WEEKNUM

Returns the ISO week number for a date.

## Syntax

```
WEEKNUM(date)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `date` | A date or timestamp expression. Can be a column reference, literal, or any expression that produces a date. |

## Return value

An integer from 1 to 53, representing the ISO week number of the year.

## Remarks

- ISO weeks start on Monday. Week 1 is the week containing the first Thursday of the year.
- A date near the end of December may belong to week 1 of the following year, and a date in early January may belong to week 52 or 53 of the previous year.
- Returns NULL if the date expression is blank or null.
- SQL generation: `EXTRACT(WEEK FROM date)`.
- WEEKNUM forces local computation when the date argument contains aggregation functions.

## Example 1: Week number for orders

```
DEFINE OrderWeek = WEEKNUM(dim_date[order_date])
```

## Example 2: Group sales by week

```
DEFINE WeekOfYear = WEEKNUM(dim_date[order_date])
```

## Example 3: Combined with YEAR

Identify year-week pairs for time series analysis.

```
DEFINE YearWeek = YEAR(dim_date[order_date]) * 100 + WEEKNUM(dim_date[order_date])
```

## See also

- [DAYOFWEEK](DAYOFWEEK.md) — returns the day of the week as a number
- [DAYOFYEAR](DAYOFYEAR.md) — returns the day of the year
- [YEAR](YEAR.md) — extracts the year from a date
