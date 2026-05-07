# DAYOFWEEK

Returns the day of the week as a number, where 0 is Sunday and 6 is Saturday.

## Syntax

```
DAYOFWEEK(date)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `date` | A date or timestamp expression. Can be a column reference, literal, or any expression that produces a date. |

## Return value

An integer from 0 to 6, where 0 = Sunday, 1 = Monday, ..., 6 = Saturday.

## Remarks

- The numbering follows ISO convention with 0 for Sunday.
- Returns NULL if the date expression is blank or null.
- SQL generation: `EXTRACT(DOW FROM date)`.
- DAYOFWEEK forces local computation when the date argument contains aggregation functions.
- To get the day name as text instead of a number, use [DAYNAME](DAYNAME.md).

## Example 1: Day of week for order dates

```
DEFINE OrderDayOfWeek = DAYOFWEEK(dim_date[order_date])
```

## Example 2: Filter for weekends

Check if orders fall on a weekend (Saturday = 6 or Sunday = 0).

```
DEFINE IsWeekend = IF(DAYOFWEEK(dim_date[order_date]) = 0 || DAYOFWEEK(dim_date[order_date]) = 6, 1, 0)
```

## Example 3: Combined with DAYNAME

```
DEFINE DayInfo = DAYNAME(dim_date[order_date])
```

## See also

- [DAYNAME](DAYNAME.md) — returns the day of the week as text
- [DAY](DAY.md) — extracts the day of the month from a date
- [DAYOFYEAR](DAYOFYEAR.md) — returns the day of the year
