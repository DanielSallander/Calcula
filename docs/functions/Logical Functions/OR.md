# OR

Checks whether one of the arguments is TRUE to return TRUE. Returns FALSE if both arguments are FALSE.

## Syntax

```
OR(logical1, logical2)
```

OR can also be used as an **operator** between conditions:

```
condition1 OR condition2
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `logical1` | The first logical expression to evaluate. |
| `logical2` | The second logical expression to evaluate. |

## Return value

TRUE if either argument is TRUE, otherwise FALSE.

## Remarks

- OR is available both as a function `OR(a, b)` and as an infix operator `a OR b`. Both produce the same result.
- The function form is useful for nesting: `OR(cond1, OR(cond2, cond3))`.
- The operator form is more readable for simple cases: `SUM(t[a]) > 100 OR SUM(t[b]) > 100`.
- OR generates a SQL `(left OR right)` expression internally.
- Both arguments can contain aggregation functions, comparisons, or other logical functions.

## Example 1: Function syntax in IF

```
DEFINE AnyRevenue = IF(OR(SUM(fact_sales[linetotal]) > 0, COUNT(fact_sales[salesorderdetailid]) > 0), "Active", "Inactive")
```

## Example 2: Operator syntax in IF

```
DEFINE AnyRevenue = IF(SUM(fact_sales[linetotal]) > 0 OR COUNT(fact_sales[salesorderdetailid]) > 0, "Active", "Inactive")
```

## Example 3: Combined with AND

```
DEFINE Criteria = IF(
    OR(AND(SUM(t[a]) > 0, SUM(t[b]) > 0), SUM(t[c]) > 100),
    "Met",
    "Not met"
)
```

## See also

- [AND](AND.md) — returns TRUE if both arguments are TRUE
- [NOT](NOT.md) — negates a logical value
- [XOR](XOR.md) — exclusive OR
- [IF](IF.md) — conditional branching
- [TRUE](TRUE.md) / [FALSE](FALSE.md) — boolean literals
