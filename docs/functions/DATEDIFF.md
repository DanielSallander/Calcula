# DATEDIFF

Returns the difference between two dates in the specified interval.

## Syntax

```
DATEDIFF(start_date, end_date, interval)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `start_date` | A date or timestamp expression representing the start of the period. |
| `end_date` | A date or timestamp expression representing the end of the period. |
| `interval` | The unit of measurement for the difference. Must be one of: `DAY`, `MONTH`, `YEAR`, or `QUARTER`. Specified as a keyword, not a string. |

## Return value

An integer representing the number of intervals between the start and end dates. A positive value indicates that end_date is after start_date.

## Remarks

- The interval parameter is a keyword, not a quoted string: use `DAY`, not `"DAY"`.
- If start_date is later than end_date, the result is negative.
- Returns NULL if either date is blank or null.
- MONTH and YEAR intervals count calendar boundaries, not fixed durations.

## Example 1: Days between two dates

```dax
DATEDIFF(dim_date[start_date], dim_date[end_date], DAY)
```

## Example 2: Age of an order in days

```dax
DEFINE OrderAge = DATEDIFF(dim_date[order_date], TODAY(), DAY)
```

## Example 3: Months between dates

```dax
DATEDIFF(dim_date[start_date], dim_date[end_date], MONTH)
```

## See also

- [DATE](DATE.md) — construct a date from parts
- [TODAY](TODAY.md) — returns the current date
- [YEAR](YEAR.md) — extract the year from a date
