# RPAD

Right-pads a text string to a specified length.

## Syntax

```
RPAD(text, length [, pad])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `text` | The text expression to pad. |
| `length` | The desired total length of the result. |
| `pad` | *(Optional)* The text to use for padding. Default is a single space `' '`. |

## Return value

The input text padded on the right to the specified length. If the input is longer than `length`, it is truncated to `length`.

## Remarks

- RPAD is not part of standard DAX. It is a Calcula extension (available in Snowflake SQL).
- When `pad` is omitted, spaces are used for padding.
- If the pad string is longer than one character, it repeats as needed and excess characters are truncated.
- If the input text is already longer than `length`, the result is truncated to `length` characters.
- RPAD generates SQL as `RPAD(text, length)` or `RPAD(text, length, pad)`.

## Example 1: Pad with spaces (default)

```
DEFINE PaddedCode = RPAD(t[code], 10)
```

## Example 2: Pad with asterisks

```
DEFINE MaskedNum = RPAD(LEFT(t[card_number], 4), 16, "*")
```

If `card_number` starts with `"4532"`, the result is `"4532************"`.

## See also

- [LPAD](LPAD.md) — left-pads a text string
- [LEFT](LEFT.md) — returns characters from the start of a text string
- [RIGHT](RIGHT.md) — returns characters from the end of a text string
