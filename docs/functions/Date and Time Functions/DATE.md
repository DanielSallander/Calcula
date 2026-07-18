# DATE

Constructs a date value from individual year, month, and day components.

## Syntax

```
DATE(year, month, day)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `year` | An integer expression representing the year. |
| `month` | An integer expression representing the month (1-12). |
| `day` | An integer expression representing the day (1-31). |

## Return value

A date value constructed from the specified year, month, and day.

## Remarks

- All three parameters are required.
- Invalid combinations (e.g., month 13 or day 32) produce an error.
- Translates to `make_date(year, month, day)` in SQL.
- Parameters can be literal values or expressions including other date functions.

## Example 1: Construct a fixed date

```dax
DATE(2024, 1, 15)
```

## Example 2: Build a date from extracted parts

```dax
DATE(YEAR(dim_date[order_date]), 1, 1)
```

## Example 3: Use in a DATEDIFF calculation

```dax
DEFINE DaysSinceStart = DATEDIFF(DATE(2024, 1, 1), dim_date[order_date], DAY)
```

## See also

- [YEAR](YEAR.md) — extract the year from a date
- [MONTH](MONTH.md) — extract the month from a date
- [DAY](DAY.md) — extract the day from a date
- [DATEDIFF](DATEDIFF.md) — calculate the difference between two dates
