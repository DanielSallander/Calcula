# DAYNAME

Returns the name of the day of the week as text.

## Syntax

```
DAYNAME(date)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `date` | A date or timestamp expression. Can be a column reference, literal, or any expression that produces a date. |

## Return value

A text value representing the day of the week, such as "Monday", "Tuesday", etc. The name is returned with an initial capital letter and no trailing spaces.

## Remarks

- The returned name uses English day names: "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday".
- Returns NULL if the date expression is blank or null.
- SQL generation: `TRIM(TO_CHAR(date, 'Day'))`. The TRIM removes trailing padding that some databases add.
- DAYNAME forces local computation when the date argument contains aggregation functions.
- For a numeric representation of the day, use [DAYOFWEEK](DAYOFWEEK.md) instead.

## Example 1: Day name for order dates

```
DEFINE OrderDay = DAYNAME(dim_date[order_date])
```

## Example 2: Use in a lookup column

Display the day name alongside aggregated sales.

```
DEFINE ShipDayName = DAYNAME(dim_date[ship_date])
```

## Example 3: Combine with IF for weekend detection

```
DEFINE DayType = IF(DAYOFWEEK(dim_date[order_date]) = 0 || DAYOFWEEK(dim_date[order_date]) = 6, "Weekend", "Weekday")
```

## See also

- [DAYOFWEEK](DAYOFWEEK.md) — returns the day of the week as a number
- [MONTHNAME](MONTHNAME.md) — returns the name of the month as text
- [DAY](DAY.md) — extracts the day of the month from a date
