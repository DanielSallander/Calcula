# GESTEP function

## Introduction
The GESTEP function returns 1 if a number is greater than or equal to a step value, and 0 otherwise. This implements the Heaviside step function, commonly used in signal processing and control systems to represent on/off thresholds.

## Syntax
```
=GESTEP(number, [step])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The value to test against the step threshold. |
| step | Optional | The threshold value. If omitted, defaults to 0. |

## Remarks
- If either argument is non-numeric, GESTEP returns a #VALUE! error.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Value** | **Step** | **Result** |
| 2 | 5 | 4 | =GESTEP(A2, B2) |
| 3 | 3 | 4 | =GESTEP(A3, B3) |

**Result in C2:** 1 (5 is greater than or equal to 4)
**Result in C3:** 0 (3 is less than 4)
