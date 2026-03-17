# XOR function

## Introduction

The XOR (exclusive OR) function returns TRUE if an odd number of its arguments evaluate to TRUE, and FALSE if an even number of arguments evaluate to TRUE (including zero). With two arguments, XOR returns TRUE when exactly one condition is TRUE and the other is FALSE, which is the classic exclusive-or behavior.

XOR is useful in scenarios where you need to detect that exactly one of two conditions is met, but not both. For example, you might verify that an employee selected either a health plan or a stipend, but not both. When applied to more than two arguments, XOR generalizes to the odd-parity rule.

## Syntax

```
=XOR(logical1, [logical2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| logical1 | Required | The first condition to evaluate. |
| logical2, ... | Optional | Additional conditions to evaluate. Up to 255 conditions can be provided. |

## Remarks

- With exactly two arguments, XOR returns TRUE when one is TRUE and the other is FALSE.
- With more than two arguments, XOR returns TRUE if an odd number of the arguments are TRUE.
- Numeric values are interpreted as logical: 0 is FALSE, any non-zero value is TRUE.
- Text values that cannot be interpreted as logical cause a #VALUE! error.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Health Plan** | **Stipend** | **Valid Selection** |
| 2 | TRUE | FALSE | =XOR(A2, B2) |
| 3 | TRUE | TRUE | =XOR(A3, B3) |
| 4 | FALSE | FALSE | =XOR(A4, B4) |

**Result:** Cell C2 returns **TRUE**, cell C3 returns **FALSE**, and cell C4 returns **FALSE**.

Only the employee in row 2 made a valid selection by choosing exactly one benefit. Row 3 selected both (invalid), and row 4 selected neither (also invalid).
