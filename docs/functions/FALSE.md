# FALSE

Returns the boolean value FALSE.

## Syntax

```
FALSE()
```

or simply:

```
FALSE
```

### Parameters

None.

## Return value

The boolean value FALSE.

## Remarks

- FALSE can be used with or without parentheses: both `FALSE()` and `FALSE` are valid.
- FALSE generates the SQL keyword `FALSE` internally.
- Useful as arguments to IF, SWITCH, or logical functions when you need an explicit boolean literal.
- In DAX, FALSE() returns the boolean value FALSE. Calcula follows the same convention.

## Example 1: As IF return value

```
DEFINE IsActive = IF(SUM(fact_sales[linetotal]) > 0, TRUE(), FALSE())
```

## Example 2: Without parentheses

```
DEFINE HasRevenue = IF(SUM(fact_sales[linetotal]) > 0, TRUE, FALSE)
```

## See also

- [TRUE](TRUE.md) — returns the boolean value TRUE
- [IF](IF.md) — conditional branching
- [AND](AND.md), [OR](OR.md), [NOT](NOT.md) — logical operators
