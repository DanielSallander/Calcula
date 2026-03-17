# CHAR function

## Introduction

The CHAR function returns the character corresponding to a given numeric character code. The code number refers to the character set used by your computer (typically the Windows-1252 character set or Unicode). This function is the inverse of the CODE function.

CHAR is useful for inserting special characters into formulas that cannot be typed directly, such as line breaks (CHAR(10)), tabs (CHAR(9)), or other non-printable or special characters. It is also used to build character sequences programmatically and to work with ASCII-based encoding tasks.

## Syntax

```
=CHAR(number)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | A number between 1 and 255 that specifies the character code. |

## Remarks

- The character returned depends on the character set of your operating system.
- On Windows, this typically corresponds to the Windows-1252 (ANSI) character set.
- Common useful codes: 10 = line feed (newline), 9 = tab, 32 = space, 34 = double quote.
- If number is outside the range 1-255, CHAR returns a #VALUE! error.

## Example

| | A | B |
|---|---|---|
| 1 | **Code** | **Character** |
| 2 | 65 | =CHAR(A2) |
| 3 | 97 | =CHAR(A3) |
| 4 | 36 | =CHAR(A4) |

**Result:** Cell B2 returns **"A"**, cell B3 returns **"a"**, and cell B4 returns **"$"**.

Character code 65 is the uppercase letter A, 97 is the lowercase letter a, and 36 is the dollar sign.
