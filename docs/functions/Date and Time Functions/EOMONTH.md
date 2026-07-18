# EOMONTH

Returns the last day of the month, optionally offset by a number of months.

## Syntax

```
EOMONTH(date [, months])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `date` | A date or timestamp expression. Can be a column reference, literal, or any expression that produces a date. |
| `months` | Optional. An integer specifying the number of months to offset before finding the end of month. Defaults to `0` (the current month). A negative value moves backward. |

## Return value

A date representing the last day of the target month.

## Remarks

- `EOMONTH(date)` with no offset returns the last day of the same month as the input date.
- `EOMONTH(date, 1)` returns the last day of the next month.
- `EOMONTH(date, -1)` returns the last day of the previous month.
- Returns NULL if the date expression is blank or null.
- SQL generation: adds the month offset to the date, then computes the last day of the resulting month.
- EOMONTH forces local computation when the date or months argument contains aggregation functions.

## Example 1: End of current month

```
DEFINE MonthEnd = EOMONTH(dim_date[order_date])
```

## Example 2: End of next month

```
DEFINE NextMonthEnd = EOMONTH(dim_date[order_date], 1)
```

## Example 3: End of previous month

```
DEFINE PrevMonthEnd = EOMONTH(dim_date[order_date], -1)
```

## See also

- [LAST_DAY](LAST_DAY.md) — returns the last day of any period (month, quarter, year)
- [DATEADD](DATEADD.md) — adds intervals to a date
- [MONTH](MONTH.md) — extracts the month number from a date
