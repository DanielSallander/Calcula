# TRUE function

## Introduction

The TRUE function returns the logical value TRUE. While you can type the word TRUE directly into a formula or cell, the TRUE function exists for compatibility with other spreadsheet applications and for use in situations where a function call is syntactically required.

In practice, most users simply type TRUE as a literal value. However, the TRUE function is useful when constructing formulas programmatically, when you need an explicit function call to return a boolean value, or when providing a guaranteed TRUE condition as the last test in an IFS function to serve as a default catch-all.

## Syntax

```
=TRUE()
```

This function takes no arguments.

## Remarks

- The TRUE function is equivalent to typing the value TRUE directly.
- TRUE is treated as the numeric value 1 in arithmetic operations (e.g., TRUE + TRUE = 2).
- The function is provided primarily for compatibility purposes.

## Example

| | A | B |
|---|---|---|
| 1 | **Value** | **Result** |
| 2 | =TRUE() | =IF(A2, "Active", "Inactive") |

**Result:** Cell A2 displays **TRUE** and cell B2 returns **"Active"**.

The TRUE function returns the logical value TRUE, which the IF function then evaluates to return the corresponding value_if_true argument.
