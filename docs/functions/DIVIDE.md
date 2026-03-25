# DIVIDE

Performs division with safe handling of division by zero. Returns an alternate result (or BLANK) when the denominator is zero.

## Syntax

```
DIVIDE(numerator, denominator [, alternate])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `numerator` | The dividend — any numeric expression. |
| `denominator` | The divisor — any numeric expression. |
| `alternate` | *(Optional)* The value returned when the denominator is zero. Defaults to BLANK (NULL) if omitted. |

## Return value

A decimal number — the result of the division, or the alternate value if the denominator is zero.

## Remarks

- DIVIDE is the recommended way to perform division in measures. It avoids division-by-zero errors that would otherwise cause the query to fail.
- The alternate value is only used when the denominator is **exactly zero**. NULL denominators are not treated as zero.
- DIVIDE always produces a floating-point result, even when both numerator and denominator are integers. This differs from the `/` operator, which preserves integer types.
- DIVIDE can be nested inside other functions like [ROUND](ROUND.md), [ABS](ABS.md), and [COALESCE](COALESCE.md).
- When either the numerator or denominator contains aggregation functions, DIVIDE forces local computation (not pushed down to data source).

## Example 1: Safe average

Calculate average order value using DIVIDE instead of `/`.

```
DEFINE AvgOrderValue = DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid]))
```

| AvgOrderValue |
|---------------|
| 905.31 |

## Example 2: Revenue per unit

```
DEFINE RevenuePerUnit = DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[orderqty]))
```

## Example 3: With alternate value

Provide 0 instead of BLANK when division by zero occurs.

```
DEFINE SafeRatio = DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid]), 0)
```

## Example 4: DIVIDE grouped by dimension

```
DEFINE AvgOrderValue = DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid]))
QUERY: AvgOrderValue BY dim_product[categoryname]
```

| categoryname | AvgOrderValue |
|-------------|---------------|
| Accessories | 36.19 |
| Bikes | 1,793.27 |
| Clothing | 120.86 |
| Components | 791.30 |

## Example 5: Nested with ROUND

Round the result of a safe division.

```
DEFINE RoundedAvg = ROUND(DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid])), 2)
```

## See also

- [COALESCE](COALESCE.md) — provide fallback for NULL values
- [ROUND](ROUND.md) — round the result of a division
- [COUNTROWS](COUNTROWS.md) — count all rows (useful as denominator)
- [BLANK](BLANK.md) — the default alternate value
