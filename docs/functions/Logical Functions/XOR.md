# XOR

Returns TRUE when exactly one of two arguments is TRUE, and FALSE when both arguments are TRUE or both are FALSE (exclusive OR).

## Syntax

```
XOR(logical1, logical2)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `logical1` | The first logical expression to evaluate. |
| `logical2` | The second logical expression to evaluate. |

## Return value

TRUE if exactly one argument is TRUE, otherwise FALSE.

| logical1 | logical2 | Result |
|----------|----------|--------|
| TRUE | TRUE | FALSE |
| TRUE | FALSE | TRUE |
| FALSE | TRUE | TRUE |
| FALSE | FALSE | FALSE |

## Remarks

- XOR is available only as a function `XOR(a, b)`. There is no infix operator form.
- XOR is not part of standard DAX. It is a Calcula extension.
- XOR generates SQL as `((A AND NOT B) OR (NOT A AND B))` — the standard logical XOR identity.
- Both arguments can contain aggregation functions, comparisons, or other logical functions.

## Example 1: Exclusive condition

Return "Exclusive" when revenue is high OR quantity is high, but not both.

```
DEFINE ExclusiveHigh = IF(
    XOR(SUM(fact_sales[linetotal]) > 100000, SUM(fact_sales[orderqty]) > 1000),
    "Exclusive",
    "Both or Neither"
)
```

## Example 2: Combined with other logical functions

```
DEFINE Complex = IF(
    AND(XOR(SUM(t[a]) > 0, SUM(t[b]) > 0), SUM(t[c]) > 0),
    "Met",
    "Not met"
)
```

## See also

- [AND](AND.md) — returns TRUE if both arguments are TRUE
- [OR](OR.md) — returns TRUE if either argument is TRUE
- [NOT](NOT.md) — negates a logical value
- [IF](../Conditional%20Functions/IF.md) — conditional branching
