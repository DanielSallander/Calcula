# ISBLANK

Tests whether an expression evaluates to BLANK (NULL). Returns true if the value is BLANK, false otherwise.

## Syntax

```
ISBLANK(expression)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `expression` | The expression to test. Can be a column reference, aggregation, or any other expression. |

## Return value

A boolean — true if the expression is BLANK (NULL), false otherwise.

## Remarks

- ISBLANK generates SQL `expression IS NULL` internally.
- ISBLANK is typically used as the condition in an [IF](IF.md) expression to handle NULL values.
- For simply replacing BLANK with a fallback value, [COALESCE](COALESCE.md) is more concise than `IF(ISBLANK(x), fallback, x)`.
- ISBLANK always forces local computation when used in a measure expression.

## Example 1: Test and replace

Replace BLANK results with zero.

```
DEFINE SafeRevenue = IF(ISBLANK(SUM(fact_sales[linetotal])), 0, SUM(fact_sales[linetotal]))
```

Note: [COALESCE](COALESCE.md) is simpler for this pattern: `COALESCE(SUM(fact_sales[linetotal]), 0)`.

## Example 2: Conditional logic based on NULL

```
DEFINE HasData = IF(ISBLANK(COUNT(fact_sales[salesorderdetailid])), "No Data", "Has Data")
```

## See also

- [BLANK](BLANK.md) — returns a BLANK (NULL) value
- [COALESCE](COALESCE.md) — replace BLANK with a fallback (simpler alternative)
- [IF](IF.md) — conditional branching
