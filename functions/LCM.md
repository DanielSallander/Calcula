# LCM function

## Introduction
The LCM function returns the least common multiple of two or more integers. The least common multiple is the smallest positive integer that is evenly divisible by all the given numbers. LCM is useful in scheduling problems (finding when events coincide), manufacturing (synchronizing production cycles), and mathematical applications involving fractions.

## Syntax
```
=LCM(number1, number2, ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number1 | Required | The first integer. |
| number2, ... | Required | Additional integers. At least two numbers are needed. Up to 255 arguments. |

## Remarks
- If any argument is non-numeric, LCM returns a #VALUE! error.
- If any argument is negative, LCM returns a #NUM! error.
- Decimal portions of arguments are truncated before calculation.
- If any argument is 0, LCM returns 0.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Machine A Cycle** | **Machine B Cycle** | **Coincide Every** |
| 2 | 12 | 18 | =LCM(A2, B2) |

**Result:** 36

Machine A runs on a 12-minute cycle and Machine B on an 18-minute cycle. They will both complete a cycle simultaneously every 36 minutes, allowing synchronized maintenance windows.
