# DATE_TRUNC

Truncates a date or timestamp to the start of the specified period.

## Syntax

```
DATE_TRUNC(date, interval)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `date` | A date or timestamp expression. Can be a column reference, literal, or any expression that produces a date. |
| `interval` | The period to truncate to. Must be one of: `YEAR`, `QUARTER`, `MONTH`, `WEEK`, `DAY`, `HOUR`, `MINUTE`, `SECOND`. Specified as a keyword, not a string. |

## Return value

A date or timestamp representing the start of the specified period containing the original date.

## Remarks

- The interval parameter is a keyword, not a quoted string: use `MONTH`, not `"MONTH"`.
- `DATE_TRUNC(date, MONTH)` returns the first day of the month containing the date.
- `DATE_TRUNC(date, YEAR)` returns January 1 of that year.
- `DATE_TRUNC(date, WEEK)` returns the Monday of the ISO week containing the date.
- Returns NULL if the date expression is blank or null.
- SQL generation: `DATE_TRUNC('interval', date)`.
- DATE_TRUNC forces local computation when the date argument contains aggregation functions.

## Example 1: Truncate to month

Find the first day of the month for each order date.

```
DEFINE MonthStart = DATE_TRUNC(dim_date[order_date], MONTH)
```

## Example 2: Truncate to quarter

```
DEFINE QuarterStart = DATE_TRUNC(dim_date[order_date], QUARTER)
```

## Example 3: Truncate to year

```
DEFINE YearStart = DATE_TRUNC(dim_date[order_date], YEAR)
```

## See also

- [DATEADD](DATEADD.md) — adds intervals to a date
- [LAST_DAY](LAST_DAY.md) — returns the last day of a period
- [YEAR](YEAR.md) — extracts the year from a date
