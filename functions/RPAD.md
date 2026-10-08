# RPAD function

## Introduction

The RPAD function pads text on the right with a fill string until the result is exactly the length you ask for. This is a Calcula-specific function that is not available in Microsoft Excel or other spreadsheet applications.

Use RPAD to build fixed-width fields for exports and printouts, such as names padded with spaces to a column width, or dot leaders in a table of contents ("Chapter 1" becoming "Chapter 1......"). It follows the rules of RPAD in Snowflake, Oracle and PostgreSQL, which are also the rules of RPAD in Calcula's data model expressions for ordinary text. Unlike SQL, a negative length or a length above 32,767 is a #VALUE! error, and characters are counted as Unicode code points, so a letter written with a separate combining accent, or an emoji with a skin tone, counts as two or more characters here and can pad differently than in a model query.

## Syntax

```
=RPAD(text, length, [pad])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| text | Required | The text to pad. A number or TRUE/FALSE is converted to text first, the same way LEFT converts it. An empty cell counts as empty text. |
| length | Required | The exact number of characters the result has. Decimal values are truncated to integers. Must be from 0 to 32,767. |
| pad | Optional | The text to fill with. It is repeated from its first character as many times as needed and cut where the space runs out. Defaults to a single space if omitted. |

## Remarks

- If text is shorter than length, the pad is added on the right until the result is exactly length characters. A pad of several characters is repeated from its first character and cut: `=RPAD("123.50", 19, "*_")` returns "123.50*_*_*_*_*_*_*".
- If text is already longer than length, it is cut to its first length characters, the same as LEFT: `=RPAD("Twelve Dollars", 10, "$")` returns "Twelve Dol".
- If pad is empty text (""), nothing is added, but a text longer than length is still cut. A pad that refers to an empty cell counts as empty text too. To pad with spaces, leave the argument out or leave its place empty, as in `=RPAD(A2, 12)` or `=RPAD(A2, 12, )`.
- If length is 0, RPAD returns an empty string.
- If length is negative, greater than 32,767 (Excel's cell-text limit) or not a number, RPAD returns a #VALUE! error. The limit applies to the length you ask for, even when the pad is empty and the result would be shorter.
- RPAD counts characters, not bytes: "åäö" is three characters and most emoji are one. An emoji with a skin tone, a flag, or a letter written with a separate combining accent counts as two or more.
- A number is padded as it is written in General format, with the workbook's decimal separator: with a decimal comma, `=RPAD(1.5, 5, "0")` returns "1,500". The cell's number format is not used, so a date pads its serial number. To pad a formatted number, format it first: `=RPAD(TEXT(A2, "0.00"), 8, " ")`.
- If any argument is an error, RPAD returns that error.
- If the workbook has its own RPAD, that one is used instead of this function: a defined name called RPAD (such as a LAMBDA in a workbook made in Excel, which has no RPAD of its own) or a LET or LAMBDA variable called RPAD that holds a LAMBDA. The workbook's own definition may treat a long text differently, for example by keeping its right end.
- If text, length or pad is a range or an array, RPAD returns one result for each element, which spills into neighbouring cells.
- LPAD does the same on the left.

## Example

| | A | B |
|---|---|---|
| 1 | **Section** | **Contents Line** |
| 2 | Chapter 1 | =RPAD(A2, 15, ".") |

**Result:** "Chapter 1......"

The section title is followed by dots up to a fixed width of fifteen characters, the leader of a table of contents line.

### Compatibility Note

This is a Calcula-specific function. It is not available in Microsoft Excel, Google Sheets or LibreOffice Calc. A workbook saved as .xlsx keeps the formula exactly as written, so Excel shows #NAME? in the cell. Excel also keeps the formula when it saves the file again, so Calcula calculates it once more when the file is reopened here. Where the file must calculate in Excel, an equivalent for a one-character pad is `=LEFT(A2 & REPT(".", 15), 15)`.
