# NOW

Returns the current date and time as a timestamp.

## Syntax

```
NOW()
```

### Parameters

None. NOW takes no parameters.

## Return value

A timestamp value representing the current date and time at the moment of query execution.

## Remarks

- NOW includes both date and time components. Use [TODAY](TODAY.md) if you only need the date.
- The value is evaluated at query execution time.
- Translates to `NOW()` in SQL.
- Useful for timestamp comparisons and calculating elapsed time with precision finer than days.

## Example 1: Time since last update

```dax
DATEDIFF(dim_orders[last_updated], NOW(), DAY)
```

## Example 2: Compare with a fixed timestamp

```dax
DEFINE RecentOrders = COUNT(fact_sales[order_id]), KEEP(dim_date[order_timestamp] >= DATE(2024, 1, 1))
```

## See also

- [TODAY](TODAY.md) — returns the current date without a time component
- [DATEDIFF](DATEDIFF.md) — calculate the difference between two dates
