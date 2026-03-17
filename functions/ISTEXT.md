# ISTEXT function

## Introduction

The ISTEXT function checks whether a value is text and returns TRUE or FALSE. It tests any value, cell reference, or expression and determines if the result is a text string.

Use ISTEXT to validate that cells contain text data, build conditional logic that handles text differently from numbers, or verify imported data types. It is useful for data cleaning workflows and input validation.

## Syntax

```
=ISTEXT(value)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| value | Required | The value, cell reference, or expression to test. |

## Remarks

- ISTEXT returns TRUE for any text string, including an empty string ("").
- Numbers, logical values (TRUE/FALSE), errors, and blank cells return FALSE.
- A cell containing a number formatted as text will return TRUE.

## Example

| | A | B |
|---|---|---|
| 1 | **Value** | **Is Text?** |
| 2 | Hello | =ISTEXT(A2) |
| 3 | 42 | =ISTEXT(A3) |
| 4 | | =ISTEXT(A4) |

**Result (B2):** TRUE
**Result (B3):** FALSE
**Result (B4):** FALSE

"Hello" is text so the function returns TRUE. The number 42 and the blank cell both return FALSE.
