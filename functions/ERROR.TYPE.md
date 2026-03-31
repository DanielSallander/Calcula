# ERROR.TYPE function

## Introduction

The ERROR.TYPE function returns a number corresponding to the type of error in a cell. This is useful for programmatically handling different error types in formulas.

## Syntax

```
=ERROR.TYPE(error_val)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| error_val | Required | The error value to identify, or a reference to a cell containing an error. |

## Remarks

- If error_val is not an error, ERROR.TYPE returns #N/A.
- The return values are:
  - 2 = #DIV/0!
  - 3 = #VALUE!
  - 4 = #REF!
  - 5 = #NAME?
  - 7 = #N/A

## Example

| | A | B |
|---|---|---|
| 1 | **Error** | **Type** |
| 2 | =1/0 | =ERROR.TYPE(A2) |
| 3 | =NA() | =ERROR.TYPE(A3) |

**Result:** Cell B2 returns **2** (#DIV/0! error type) and cell B3 returns **7** (#N/A error type).
