# NOT function

## Introduction

The NOT function reverses the logical value of its argument. If the argument evaluates to TRUE, NOT returns FALSE, and vice versa. It is useful when you need to negate a condition or invert the result of another logical expression.

NOT is commonly used in combination with other logical functions such as IF, AND, and OR to create inverse conditions. For example, you might use NOT to exclude certain records, check that a value does NOT meet a criterion, or flip the result of a complex logical expression.

## Syntax

```
=NOT(logical)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| logical | Required | A value or expression that evaluates to TRUE or FALSE. |

## Remarks

- If the argument is a number, 0 is treated as FALSE (so NOT returns TRUE), and any non-zero number is treated as TRUE (so NOT returns FALSE).
- If the argument is text that cannot be interpreted as a logical value, the function returns a #VALUE! error.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Status** | **Is Active** | **Needs Follow-Up** |
| 2 | Active | TRUE | =NOT(B2) |
| 3 | Closed | FALSE | =NOT(B3) |

**Result:** Cell C2 returns **FALSE** and cell C3 returns **TRUE**.

The NOT function inverts each value: the active record does not need follow-up (FALSE), while the closed record does (TRUE). This is a simple way to create inverse flags from existing boolean columns.
