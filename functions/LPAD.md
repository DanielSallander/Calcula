# LPAD function

## Introduction

The LPAD function pads text on the left with a fill string until the result is exactly the length you ask for. This is a Calcula-specific function that is not available in Microsoft Excel or other spreadsheet applications.

Use LPAD to build fixed-width codes and identifiers, such as zero-padded invoice numbers, account numbers and SKU codes (42 becoming "000042"), or to right-align text in a fixed-width export. It follows the rules of LPAD in Snowflake, Oracle and PostgreSQL, which are also the rules of LPAD in Calcula's data model expressions for ordinary text. Unlike SQL, a negative length or a length above 32,767 is a #VALUE! error, and characters are counted as Unicode code points, so a letter written with a separate combining accent, or an emoji with a skin tone, counts as two or more characters here and can pad differently than in a model query.

## Syntax

```
=LPAD(text, length, [pad])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| text | Required | The text to pad. A number or TRUE/FALSE is converted to text first, the same way LEFT converts it. An empty cell counts as empty text. |
| length | Required | The exact number of characters the result has. Decimal values are truncated to integers. Must be from 0 to 32,767. |
| pad | Optional | The text to fill with. It is repeated from its first character as many times as needed and cut where the space runs out. Defaults to a single space if omitted. |

## Remarks

- If text is shorter than length, the pad is added on the left until the result is exactly length characters. A pad of several characters is repeated and cut: `=LPAD("123.50", 19, "*_")` returns "*_*_*_*_*_*_*123.50".
- If text is already longer than length, it is cut to its FIRST length characters. The right end is dropped, even though LPAD pads on the left: `=LPAD("Twelve Dollars", 10, "$")` returns "Twelve Dol". This is the rule in Snowflake, Oracle and PostgreSQL. To keep the right end of a long text instead, use `=IF(LEN(A2)>6, RIGHT(A2, 6), LPAD(A2, 6, "0"))`.
- If pad is empty text (""), nothing is added, but a text longer than length is still cut. A pad that refers to an empty cell counts as empty text too. To pad with spaces, leave the argument out or leave its place empty, as in `=LPAD(A2, 6)` or `=LPAD(A2, 6, )`.
- If length is 0, LPAD returns an empty string.
- If length is negative, greater than 32,767 (Excel's cell-text limit) or not a number, LPAD returns a #VALUE! error. The limit applies to the length you ask for, even when the pad is empty and the result would be shorter.
- LPAD counts characters, not bytes: "åäö" is three characters and most emoji are one. An emoji with a skin tone, a flag, or a letter written with a separate combining accent counts as two or more.
- A number is padded as it is written in General format, with the workbook's decimal separator: with a decimal comma, `=LPAD(1.5, 5, "0")` returns "001,5". The cell's number format is not used, so a date pads its serial number. To pad a formatted number, format it first: `=LPAD(TEXT(A2, "0.00"), 8, "0")`.
- If any argument is an error, LPAD returns that error.
- If the workbook has its own LPAD, that one is used instead of this function: a defined name called LPAD (such as a LAMBDA in a workbook made in Excel, which has no LPAD of its own) or a LET or LAMBDA variable called LPAD that holds a LAMBDA. The workbook's own definition may treat a long text differently, for example by keeping its right end.
- If text, length or pad is a range or an array, LPAD returns one result for each element, which spills into neighbouring cells.
- RPAD does the same on the right.

## Example

| | A | B |
|---|---|---|
| 1 | **Invoice** | **Invoice Code** |
| 2 | 42 | =LPAD(A2, 6, "0") |

**Result:** "000042"

The invoice number is padded on the left with zeros to a fixed six-character code.

### Compatibility Note

This is a Calcula-specific function. It is not available in Microsoft Excel, Google Sheets or LibreOffice Calc. A workbook saved as .xlsx keeps the formula exactly as written, so Excel shows #NAME? in the cell. Excel also keeps the formula when it saves the file again, so Calcula calculates it once more when the file is reopened here. Where the file must calculate in Excel, an equivalent for a one-character pad is `=IF(LEN(A2)>=6, LEFT(A2, 6), RIGHT(REPT("0", 6) & A2, 6))`.
