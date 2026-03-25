# AND

Checks whether both arguments are TRUE, and returns TRUE if both arguments are TRUE. Otherwise returns FALSE.

## Syntax

```
AND(logical1, logical2)
```

AND can also be used as an **operator** between conditions:

```
condition1 AND condition2
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `logical1` | The first logical expression to evaluate. |
| `logical2` | The second logical expression to evaluate. |

## Return value

TRUE if both arguments are TRUE, otherwise FALSE.

## Remarks

- AND is available both as a function `AND(a, b)` and as an infix operator `a AND b`. Both produce the same result.
- The function form is useful for nesting: `AND(cond1, AND(cond2, cond3))`.
- The operator form is more readable for simple cases: `SUM(t[a]) > 0 AND SUM(t[b]) > 0`.
- AND generates a SQL `(left AND right)` expression internally.
- Both arguments can contain aggregation functions, comparisons, or other logical functions.

## Example 1: Function syntax in IF

```
DEFINE HighVolume = IF(AND(SUM(fact_sales[linetotal]) > 50000, COUNT(fact_sales[salesorderdetailid]) > 100), "Yes", "No")
```

## Example 2: Operator syntax in IF

```
DEFINE HighVolume = IF(SUM(fact_sales[linetotal]) > 50000 AND COUNT(fact_sales[salesorderdetailid]) > 100, "Yes", "No")
```

## Example 3: Nested AND

```
DEFINE AllCriteria = IF(
    AND(SUM(t[a]) > 0, AND(SUM(t[b]) > 0, SUM(t[c]) > 0)),
    "All met",
    "Not all met"
)
```

## See also

- [OR](OR.md) — returns TRUE if either argument is TRUE
- [NOT](NOT.md) — negates a logical value
- [XOR](XOR.md) — exclusive OR
- [IF](IF.md) — conditional branching
- [TRUE](TRUE.md) / [FALSE](FALSE.md) — boolean literals
