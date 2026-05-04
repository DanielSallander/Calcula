# TODAY

Returns the current date with no time component.

## Syntax

```
TODAY()
```

### Parameters

None. TODAY takes no parameters.

## Return value

A date value representing the current date at the time of query execution.

## Remarks

- TODAY returns the date only, with no time-of-day component. Use [NOW](NOW.md) if you need the full timestamp.
- The value is evaluated at query execution time, so results will differ from day to day.
- Translates to `CURRENT_DATE` in SQL.

## Example 1: Days since order

Calculate how many days have passed since each order was placed.

```dax
DEFINE OrderAge = DATEDIFF(dim_date[order_date], TODAY(), DAY)
```

## Example 2: Filter to current year

```dax
DEFINE CurrentYearRevenue = SUM(fact_sales[linetotal]), KEEP(dim_date[year] = YEAR(TODAY()))
```

## See also

- [NOW](NOW.md) — returns the current date and time
- [DATEDIFF](DATEDIFF.md) — calculate the difference between two dates
- [YEAR](YEAR.md) — extract the year from a date
