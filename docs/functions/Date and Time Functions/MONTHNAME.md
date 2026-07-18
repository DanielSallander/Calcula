# MONTHNAME

Returns the name of the month as text.

## Syntax

```
MONTHNAME(date)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `date` | A date or timestamp expression. Can be a column reference, literal, or any expression that produces a date. |

## Return value

A text value representing the month name, such as "January", "February", etc. The name is returned with an initial capital letter and no trailing spaces.

## Remarks

- The returned name uses English month names: "January" through "December".
- Returns NULL if the date expression is blank or null.
- SQL generation: `TRIM(TO_CHAR(date, 'Month'))`. The TRIM removes trailing padding that some databases add.
- MONTHNAME forces local computation when the date argument contains aggregation functions.
- For the numeric month value, use [MONTH](MONTH.md) instead.

## Example 1: Month name for order dates

```
DEFINE OrderMonth = MONTHNAME(dim_date[order_date])
```

## Example 2: Display month alongside totals

```
DEFINE ShipMonth = MONTHNAME(dim_date[ship_date])
```

## Example 3: Combine with YEAR for labels

```
DEFINE PeriodLabel = CONCATENATE(MONTHNAME(dim_date[order_date]), CONCATENATE(" ", YEAR(dim_date[order_date])))
```

## See also

- [MONTH](MONTH.md) — extracts the month number from a date
- [DAYNAME](DAYNAME.md) — returns the name of the day of the week as text
- [QUARTER](QUARTER.md) — extracts the quarter number from a date
