# SEARCH function

## Introduction

The SEARCH function locates the position of a text string within another text string. Unlike FIND, SEARCH is case-insensitive and supports wildcard characters: the question mark (?) matches any single character, and the asterisk (*) matches any sequence of characters. SEARCH returns the position of the first character of the found text.

SEARCH is ideal when you need flexible, case-insensitive text matching. Common uses include finding keywords regardless of capitalization, locating patterns using wildcards, determining if a cell contains a specific word or fragment, and building dynamic text parsing formulas.

## Syntax

```
=SEARCH(find_text, within_text, [start_num])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| find_text | Required | The text string to find. Case-insensitive. Supports ? and * wildcards. |
| within_text | Required | The text string to search within. |
| start_num | Optional | The character position in within_text at which to start searching. Defaults to 1 if omitted. |

## Remarks

- SEARCH is case-insensitive: searching for "apple" will match "Apple", "APPLE", etc.
- Use ? to match any single character and * to match any sequence of characters. To search for a literal ? or *, precede it with a tilde (~).
- If find_text is not found, SEARCH returns a #VALUE! error.
- If start_num is less than 1 or greater than the length of within_text, SEARCH returns a #VALUE! error.

## Example

| | A | B |
|---|---|---|
| 1 | **Product** | **Contains "Pro"** |
| 2 | Widget Pro Max | =ISNUMBER(SEARCH("pro", A2)) |
| 3 | Basic Gadget | =ISNUMBER(SEARCH("pro", A3)) |
| 4 | ProLine 500 | =ISNUMBER(SEARCH("pro", A4)) |

**Result:** Cell B2 returns **TRUE**, cell B3 returns **FALSE**, and cell B4 returns **TRUE**.

SEARCH finds "pro" regardless of case. Wrapping it in ISNUMBER converts the result to a simple TRUE/FALSE check for whether the substring exists.
