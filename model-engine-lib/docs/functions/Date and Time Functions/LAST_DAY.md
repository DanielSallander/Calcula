# LAST_DAY

Returns the last day of the period containing the specified date.

## Syntax

```
LAST_DAY(date [, interval])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `date` | A date or timestamp expression. Can be a column reference, literal, or any expression that produces a date. |
| `interval` | Optional. The period whose last day to return. Must be one of: `YEAR`, `QUARTER`, `MONTH`, `WEEK`. Defaults to `MONTH` if omitted. Specified as a keyword, not a string. |

## Return value

A date representing the last day of the specified period containing the original date.

## Remarks

- When no interval is provided, LAST_DAY defaults to MONTH, making it equivalent to `EOMONTH(date, 0)`.
- The interval parameter is a keyword, not a quoted string: use `QUARTER`, not `"QUARTER"`.
- Returns NULL if the date expression is blank or null.
- SQL generation: `DATE_TRUNC(interval, date) + INTERVAL '1 interval' - INTERVAL '1 day'`.
- LAST_DAY forces local computation when the date argument contains aggregation functions.

## Example 1: Last day of the month

```
DEFINE MonthEnd = LAST_DAY(dim_date[order_date])
```

## Example 2: Last day of the quarter

```
DEFINE QuarterEnd = LAST_DAY(dim_date[order_date], QUARTER)
```

## Example 3: Last day of the year

```
DEFINE YearEnd = LAST_DAY(dim_date[order_date], YEAR)
```

## See also

- [EOMONTH](EOMONTH.md) — returns the last day of the month with optional offset
- [DATE_TRUNC](DATE_TRUNC.md) — truncates a date to the start of a period
- [DATEADD](DATEADD.md) — adds intervals to a date
