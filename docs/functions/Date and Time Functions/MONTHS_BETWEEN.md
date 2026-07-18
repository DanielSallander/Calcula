# MONTHS_BETWEEN

Returns the number of months between two dates.

## Syntax

```
MONTHS_BETWEEN(start_date, end_date)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `start_date` | A date or timestamp expression representing the start of the period. |
| `end_date` | A date or timestamp expression representing the end of the period. |

## Return value

A number representing the months between the two dates. The result can be fractional when dates do not fall on the same day of the month. A positive value indicates that end_date is after start_date.

## Remarks

- If start_date is later than end_date, the result is negative.
- Returns NULL if either date is blank or null.
- SQL generation: computes the year difference multiplied by 12 plus the month difference.
- MONTHS_BETWEEN forces local computation when either date argument contains aggregation functions.
- For differences in other units (days, years, quarters), use [DATEDIFF](DATEDIFF.md) instead.

## Example 1: Months between order and ship date

```
DEFINE ShipDelay = MONTHS_BETWEEN(dim_date[order_date], dim_date[ship_date])
```

## Example 2: Customer tenure in months

Calculate how many months since the first order.

```
DEFINE TenureMonths = MONTHS_BETWEEN(dim_date[first_order_date], TODAY())
```

## Example 3: Average monthly span

```
DEFINE AvgMonthSpan = DIVIDE(SUM(fact_sales[linetotal]), MONTHS_BETWEEN(MIN(dim_date[order_date]), MAX(dim_date[order_date])))
```

## See also

- [DATEDIFF](DATEDIFF.md) — returns the difference between two dates in any interval
- [DATEADD](DATEADD.md) — adds intervals to a date
- [MONTH](MONTH.md) — extracts the month number from a date
