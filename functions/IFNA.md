# IFNA function

## Introduction

The IFNA function evaluates an expression and returns a specified alternative value if the result is the #N/A error; otherwise, it returns the result of the expression. Unlike IFERROR, which catches all error types, IFNA specifically targets only the #N/A error, allowing other errors to surface normally so you can identify and fix genuine problems in your formulas.

IFNA is especially useful when combined with lookup functions such as VLOOKUP, HLOOKUP, MATCH, and INDEX, which return #N/A when a lookup value is not found. By wrapping these functions in IFNA, you can display a meaningful message or default value when no match exists while still being alerted to other unexpected errors.

## Syntax

```
=IFNA(value, value_if_na)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| value | Required | The expression or formula to evaluate. If it does not produce a #N/A error, this result is returned. |
| value_if_na | Required | The value to return if the expression results in a #N/A error. |

## Remarks

- IFNA only catches #N/A errors. Other error types (#VALUE!, #REF!, #DIV/0!, #NAME?, #NULL!, #NUM!) are not handled and will be returned as-is.
- Use IFERROR if you need to catch all error types.
- value_if_na can be a number, text, formula, or cell reference.

## Example

| | A | B | C | D |
|---|---|---|---|---|
| 1 | **Product ID** | **Product Name** | **Lookup ID** | **Result** |
| 2 | 101 | Widget | 103 | =IFNA(VLOOKUP(C2, A2:B4, 2, FALSE), "Not found") |
| 3 | 102 | Gadget | | |
| 4 | 104 | Gizmo | | |

**Result:** Cell D2 returns **"Not found"** because product ID 103 does not exist in the lookup range A2:B4, causing VLOOKUP to return #N/A. If the product existed, the product name would be returned instead.
