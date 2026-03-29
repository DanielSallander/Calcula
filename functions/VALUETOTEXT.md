# VALUETOTEXT function

## Introduction
The VALUETOTEXT function converts any value to its text representation. It is useful for displaying values as text strings, particularly when you need to show formulas results in a specific text format or concatenate values that include different data types.

## Syntax
```
=VALUETOTEXT(value, [format])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| value | Required | The value to convert to text. |
| format | Optional | 0 = concise format (default), 1 = strict format with quotes and escape characters. |

## Remarks
- In concise format (0), text values are returned as-is, numbers as their string equivalent.
- In strict format (1), text values are wrapped in double quotes, making the output suitable for re-entry as a formula.
- Error values are returned as their error text (e.g., "#N/A").

## Example

| | A | B |
|---|---|---|
| 1 | **Value** | **As Text** |
| 2 | 100 | =VALUETOTEXT(A2, 0) |
| 3 | Hello | =VALUETOTEXT(A3, 1) |

**Result:** B2 = "100", B3 = "\"Hello\""
