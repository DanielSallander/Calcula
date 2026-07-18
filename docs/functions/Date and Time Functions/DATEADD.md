# DATEADD

Adds a specified number of intervals to a date or timestamp.

## Syntax

```
DATEADD(date, n, interval)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `date` | A date or timestamp expression. Can be a column reference, literal, or any expression that produces a date. |
| `n` | An integer expression specifying the number of intervals to add. A negative value subtracts intervals. |
| `interval` | The unit of time to add. Must be one of: `DAY`, `MONTH`, `YEAR`, `QUARTER`, `HOUR`, `MINUTE`, `SECOND`. Specified as a keyword, not a string. |

## Return value

A date or timestamp representing the original date shifted by the specified number of intervals.

## Remarks

- The interval parameter is a keyword, not a quoted string: use `DAY`, not `"DAY"`.
- Negative values for `n` subtract intervals from the date.
- Returns NULL if the date expression is blank or null.
- SQL generation: `(date + INTERVAL '1 <interval>' * n)`.
- DATEADD forces local computation when the date or n argument contains aggregation functions.

## Example 1: Add 30 days to a date

Calculate a due date 30 days after the order date.

```
DEFINE DueDate = DATEADD(dim_date[order_date], 30, DAY)
```

## Example 2: Subtract 3 months

Find the date three months before each order.

```
DEFINE ThreeMonthsAgo = DATEADD(dim_date[order_date], -3, MONTH)
```

## Example 3: Add one year

```
DEFINE NextYearDate = DATEADD(dim_date[order_date], 1, YEAR)
```

## See also

- [DATEDIFF](DATEDIFF.md) — returns the difference between two dates
- [DATE_TRUNC](DATE_TRUNC.md) — truncates a date to the start of a period
- [EOMONTH](EOMONTH.md) — returns the last day of the month
