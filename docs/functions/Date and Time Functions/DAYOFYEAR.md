# DAYOFYEAR

Returns the day of the year as a number from 1 to 366.

## Syntax

```
DAYOFYEAR(date)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `date` | A date or timestamp expression. Can be a column reference, literal, or any expression that produces a date. |

## Return value

An integer from 1 to 366, representing the ordinal day within the year. January 1 returns 1, December 31 returns 365 (or 366 in a leap year).

## Remarks

- Returns NULL if the date expression is blank or null.
- SQL generation: `EXTRACT(DOY FROM date)`.
- DAYOFYEAR forces local computation when the date argument contains aggregation functions.

## Example 1: Day of year for an order

```
DEFINE OrderDayOfYear = DAYOFYEAR(dim_date[order_date])
```

## Example 2: Progress through the year

Calculate what fraction of the year has passed.

```
DEFINE YearProgress = DIVIDE(DAYOFYEAR(dim_date[order_date]), 365)
```

## Example 3: Compare day of year across years

```
DEFINE DayNumber = DAYOFYEAR(dim_date[ship_date])
```

## See also

- [DAYOFWEEK](DAYOFWEEK.md) — returns the day of the week as a number
- [DAY](DAY.md) — extracts the day of the month from a date
- [WEEKNUM](WEEKNUM.md) — returns the ISO week number
