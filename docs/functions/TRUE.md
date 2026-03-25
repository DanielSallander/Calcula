# TRUE

Returns the boolean value TRUE.

## Syntax

```
TRUE()
```

or simply:

```
TRUE
```

### Parameters

None.

## Return value

The boolean value TRUE.

## Remarks

- TRUE can be used with or without parentheses: both `TRUE()` and `TRUE` are valid.
- TRUE generates the SQL keyword `TRUE` internally.
- Useful as arguments to IF, SWITCH, or logical functions when you need an explicit boolean literal.
- In DAX, TRUE() returns the boolean value TRUE. Calcula follows the same convention.

## Example 1: As IF return value

```
DEFINE IsActive = IF(SUM(fact_sales[linetotal]) > 0, TRUE(), FALSE())
```

## Example 2: Without parentheses

```
DEFINE IsActive = IF(SUM(fact_sales[linetotal]) > 0, TRUE, FALSE)
```

## Example 3: In SWITCH

```
DEFINE Flag = SWITCH(TRUE,
    SUM(t[a]) > 1000, "High",
    SUM(t[a]) > 100, "Medium",
    "Low"
)
```

## See also

- [FALSE](FALSE.md) — returns the boolean value FALSE
- [IF](IF.md) — conditional branching
- [AND](AND.md), [OR](OR.md), [NOT](NOT.md) — logical operators
