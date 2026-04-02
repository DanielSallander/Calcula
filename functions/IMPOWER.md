# IMPOWER function

## Introduction
The IMPOWER function returns a complex number raised to an integer power. The computation uses the polar form of the complex number: |z|^n * (cos(n*theta) + sin(n*theta)i).

## Syntax
```
=IMPOWER(inumber, number)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| inumber | Required | A complex number you want to raise to a power. Enter as a text string in the form "x+yi" or "x+yj". |
| number | Required | The power to which you want to raise the complex number. |

## Remarks
- If **inumber** is not a valid complex number, IMPOWER returns a #NUM! error.
- If **number** is non-numeric, IMPOWER returns a #VALUE! error.
- If **inumber** is 0 and **number** is negative, IMPOWER returns a #NUM! error.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Complex** | **Power** | **Result** |
| 2 | 2+3i | 3 | =IMPOWER(A2, B2) |

**Result:** "-46+9i"

The formula raises the complex number 2+3i to the 3rd power, returning -46+9i.
