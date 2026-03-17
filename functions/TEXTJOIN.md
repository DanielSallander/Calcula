# TEXTJOIN function

## Introduction
The TEXTJOIN function combines text from multiple ranges or strings, using a specified delimiter between each value. It provides a flexible way to concatenate values with separators, and can optionally skip empty cells.

TEXTJOIN is ideal for building comma-separated lists, assembling addresses from separate fields, or any scenario where you need to join multiple values with a consistent separator. Unlike CONCATENATE, TEXTJOIN accepts ranges and handles delimiters automatically.

## Syntax
```
=TEXTJOIN(delimiter, ignore_empty, text1, [text2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| delimiter | Required | The text string to insert between each value. Can be empty ("") for no separator. If a number is provided, it is treated as text. |
| ignore_empty | Required | A boolean value. If TRUE, empty cells are skipped. If FALSE, empty cells are included in the result (producing consecutive delimiters). |
| text1 | Required | The first text item to join. Can be a text string, a number, or a cell range. |
| text2, ... | Optional | Additional text items to join. Up to 252 text arguments can be provided. |

## Remarks
- If the resulting string exceeds 32,767 characters, TEXTJOIN returns a #VALUE! error.
- When **ignore_empty** is TRUE, empty cells and empty strings within ranges are omitted from the output.
- When **ignore_empty** is FALSE, empty cells produce empty entries in the result, leading to consecutive delimiters (e.g., "a,,b").
- Numbers in ranges are automatically converted to their text representation.
- Boolean values are converted to "TRUE" or "FALSE".

## Example 1 - Basic list

| | A |
|---|---|
| 1 | **Fruit** |
| 2 | Apple |
| 3 | Banana |
| 4 | Cherry |
| 5 | **Result** |
| 6 | =TEXTJOIN(", ", TRUE, A2:A4) |

**Result:** "Apple, Banana, Cherry"

The formula joins all fruit names with a comma and space as the delimiter.

## Example 2 - Ignoring empty cells

| | A |
|---|---|
| 1 | **Items** |
| 2 | Red |
| 3 | |
| 4 | Blue |
| 5 | |
| 6 | Green |
| 7 | **Result (ignore)** |
| 8 | =TEXTJOIN("-", TRUE, A2:A6) |
| 9 | **Result (keep)** |
| 10 | =TEXTJOIN("-", FALSE, A2:A6) |

**Result (row 8):** "Red-Blue-Green"

**Result (row 10):** "Red--Blue--Green"

With ignore_empty set to TRUE, the empty cells in A3 and A5 are skipped. With FALSE, they produce consecutive delimiters.

## Example 3 - Multiple ranges

| | A | B |
|---|---|---|
| 1 | **First** | **Last** |
| 2 | John | Smith |
| 3 | Jane | Doe |
| 4 | **Result** | =TEXTJOIN(" ", TRUE, A2, B2) |

**Result:** "John Smith"

The formula joins the first name and last name with a space.

## Example 4 - Empty delimiter

| | A |
|---|---|
| 1 | **Code Parts** |
| 2 | AB |
| 3 | 12 |
| 4 | XY |
| 5 | **Result** |
| 6 | =TEXTJOIN("", TRUE, A2:A4) |

**Result:** "AB12XY"

Using an empty string as the delimiter concatenates all values without any separator.
