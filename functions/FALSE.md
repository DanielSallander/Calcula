# FALSE function

## Introduction

The FALSE function returns the logical value FALSE. Like the TRUE function, it exists primarily for compatibility with other spreadsheet applications. In most situations, you can simply type the word FALSE directly into a formula or cell to achieve the same result.

The FALSE function can be useful when building formulas dynamically or when an explicit function call is needed to produce a boolean value. It is also sometimes used for clarity in complex logical expressions.

## Syntax

```
=FALSE()
```

This function takes no arguments.

## Remarks

- The FALSE function is equivalent to typing the value FALSE directly.
- FALSE is treated as the numeric value 0 in arithmetic operations (e.g., FALSE + 5 = 5).
- The function is provided primarily for compatibility purposes.

## Example

| | A | B |
|---|---|---|
| 1 | **Value** | **Result** |
| 2 | =FALSE() | =IF(A2, "Active", "Inactive") |

**Result:** Cell A2 displays **FALSE** and cell B2 returns **"Inactive"**.

The FALSE function returns the logical value FALSE, which the IF function evaluates to return the value_if_false argument.
