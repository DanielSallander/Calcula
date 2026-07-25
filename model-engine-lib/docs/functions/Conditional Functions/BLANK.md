# BLANK

Returns a blank (NULL) value. BLANK is the Calcula Engine equivalent of SQL NULL.

## Syntax

```
BLANK()
```

### Parameters

None.

## Return value

A blank (NULL) value.

## Remarks

- BLANK() takes no arguments.
- BLANK is primarily used as an alternate value in [DIVIDE](DIVIDE.md) or as a result in [IF](IF.md) / [SWITCH](SWITCH.md) expressions.
- BLANK values are treated as NULL in aggregations — they are skipped by SUM, COUNT, AVG, MIN, and MAX.
- Use [ISBLANK](ISBLANK.md) to test whether an expression evaluates to BLANK.
- In the internal representation, BLANK generates SQL `NULL`.

## Example 1: Explicit BLANK in IF

Return BLANK when a condition is not met.

```
DEFINE ConditionalRevenue = IF(
    SUM(fact_sales[orderqty]) > 10,
    SUM(fact_sales[linetotal]),
    BLANK()
)
```

## Example 2: BLANK as DIVIDE alternate

DIVIDE returns BLANK by default when the denominator is zero. This is equivalent to explicitly passing BLANK():

```
DEFINE SafeAvg = DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid]), BLANK())
```

## See also

- [ISBLANK](ISBLANK.md) — test whether a value is BLANK
- [COALESCE](COALESCE.md) — replace BLANK with a fallback value
- [DIVIDE](DIVIDE.md) — returns BLANK by default on division by zero
- [IF](IF.md) — conditional expressions that may return BLANK
