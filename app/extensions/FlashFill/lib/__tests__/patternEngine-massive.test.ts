import { describe, it, expect } from "vitest";
import { applyProgram, learn, Program, Expression } from "../patternEngine";

// ============================================================================
// 1. applyProgram with constant expression (50 tests)
// ============================================================================

describe("applyProgram - constant expressions", () => {
  const constants = [
    "", " ", "hello", "world", "123", "!@#$%", "newline\n", "tab\there",
    "UPPERCASE", "lowercase", "MiXeD", "with spaces", "with-dashes",
    "with_underscores", "with.dots", "a", "ab", "abc", "abcdefghijklmnop",
    "0", "0123456789", "special: <>", "quotes \"here\"", "single 'quotes'",
    "backslash \\", "forward/slash", "pipe|char", "semicolon;here",
    "comma,separated", "colon:value", "at@sign", "hash#tag", "dollar$bill",
    "percent%age", "caret^up", "ampersand&more", "star*power", "paren(s)",
    "bracket[s]", "brace{s}", "tilde~wave", "backtick`mark", "plus+minus-",
    "equals=sign", "question?mark", "exclaim!point", "unicode\u00e9\u00e8",
    "emoji-free text here", "  leading spaces", "trailing spaces  ", "ALLCAPS123",
  ];

  it.each(constants.map((v, i) => [i, v]))("constant #%i: %j", (_i, value) => {
    const program: Program = { expressions: [{ type: "constant", value: value as string }] };
    expect(applyProgram(program, ["anything"])).toBe(value);
  });
});

// ============================================================================
// 2. applyProgram with substring (100 tests)
// ============================================================================

describe("applyProgram - substring expressions", () => {
  const sources = [
    "Hello World", "abcdefghij", "0123456789", "The Quick Brown Fox",
    "john.doe@example.com", "2024-03-15", "first,last,middle", "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "programming", "spreadsheet",
  ];

  const substringCases: [string, number, number, string][] = [];

  for (let si = 0; si < sources.length; si++) {
    const src = sources[si];
    // Generate 10 substring combos per source
    for (let trial = 0; trial < 10; trial++) {
      const start = Math.min(trial, src.length - 1);
      const end = Math.min(start + trial + 1, src.length);
      substringCases.push([src, start, end, src.substring(start, end)]);
    }
  }

  it.each(substringCases)(
    "substring(%j, %i, %i) -> %j",
    (source, start, end, expected) => {
      const program: Program = {
        expressions: [{ type: "substring", sourceIndex: 0, start, end }],
      };
      expect(applyProgram(program, [source])).toBe(expected);
    },
  );
});

// ============================================================================
// 3. applyProgram with delimSplit (80 tests)
// ============================================================================

describe("applyProgram - delimSplit expressions", () => {
  const delimCases: [string, string, number, string][] = [
    // space delimiter
    ...Array.from({ length: 10 }, (_, i): [string, string, number, string] => {
      const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"];
      const src = words.slice(0, Math.max(2, (i % 8) + 2)).join(" ");
      const idx = i % src.split(" ").length;
      return [src, " ", idx, src.split(" ")[idx]];
    }),
    // comma delimiter
    ...Array.from({ length: 10 }, (_, i): [string, string, number, string] => {
      const items = ["red", "green", "blue", "yellow", "purple", "orange", "pink", "cyan", "white", "black"];
      const src = items.slice(0, Math.max(2, (i % 8) + 2)).join(",");
      const idx = i % src.split(",").length;
      return [src, ",", idx, src.split(",")[idx]];
    }),
    // dash delimiter
    ...Array.from({ length: 10 }, (_, i): [string, string, number, string] => {
      const parts = ["2024", "03", "15", "12", "30", "00", "999", "01", "28", "11"];
      const src = parts.slice(0, Math.max(2, (i % 6) + 2)).join("-");
      const idx = i % src.split("-").length;
      return [src, "-", idx, src.split("-")[idx]];
    }),
    // dot delimiter
    ...Array.from({ length: 10 }, (_, i): [string, string, number, string] => {
      const segs = ["www", "example", "com", "org", "net", "co", "uk", "io", "dev", "app"];
      const src = segs.slice(0, Math.max(2, (i % 7) + 2)).join(".");
      const idx = i % src.split(".").length;
      return [src, ".", idx, src.split(".")[idx]];
    }),
    // underscore delimiter
    ...Array.from({ length: 10 }, (_, i): [string, string, number, string] => {
      const segs = ["my", "variable", "name", "is", "long", "but", "works", "fine", "here", "now"];
      const src = segs.slice(0, Math.max(2, (i % 7) + 2)).join("_");
      const idx = i % src.split("_").length;
      return [src, "_", idx, src.split("_")[idx]];
    }),
    // pipe delimiter
    ...Array.from({ length: 10 }, (_, i): [string, string, number, string] => {
      const segs = ["field1", "field2", "field3", "field4", "field5", "field6", "field7", "field8", "field9", "field10"];
      const src = segs.slice(0, Math.max(2, (i % 8) + 2)).join("|");
      const idx = i % src.split("|").length;
      return [src, "|", idx, src.split("|")[idx]];
    }),
    // semicolon delimiter
    ...Array.from({ length: 10 }, (_, i): [string, string, number, string] => {
      const segs = ["a1", "b2", "c3", "d4", "e5", "f6", "g7", "h8", "i9", "j10"];
      const src = segs.slice(0, Math.max(2, (i % 8) + 2)).join(";");
      const idx = i % src.split(";").length;
      return [src, ";", idx, src.split(";")[idx]];
    }),
    // negative index (last part)
    ...Array.from({ length: 10 }, (_, i): [string, string, number, string] => {
      const words = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
      const src = words.slice(0, Math.max(2, (i % 6) + 2)).join(" ");
      const parts = src.split(" ");
      return [src, " ", -1, parts[parts.length - 1]];
    }),
  ];

  it.each(delimCases)(
    "delimSplit(%j, %j, %i) -> %j",
    (source, delimiter, partIndex, expected) => {
      const program: Program = {
        expressions: [{ type: "delimSplit", sourceIndex: 0, delimiter, partIndex }],
      };
      expect(applyProgram(program, [source])).toBe(expected);
    },
  );
});

// ============================================================================
// 4. applyProgram with upper/lower/capitalize (180 tests)
// ============================================================================

describe("applyProgram - case transformations", () => {
  const inputs = [
    "hello", "WORLD", "mixedCase", "already", "Test", "fOO", "bAr",
    "javascript", "typescript", "spreadsheet", "formula", "calculation",
    "pivot", "chart", "graph", "table", "column", "row", "cell", "range",
    "border", "format", "style", "color", "font", "align", "merge",
    "split", "filter", "sort", "data", "value", "index", "array",
    "matrix", "vector", "scalar", "function", "lambda", "expression",
    "pattern", "engine", "parser", "lexer", "token", "node", "tree",
    "alpha", "BETA", "Gamma", "DELTA", "epsilon", "ZETA", "Eta",
    "THETA", "iota", "KAPPA", "Lambda", "MU", "nu", "XI", "omicron",
    "PI", "rho", "SIGMA", "tau", "UPSILON",
  ];

  describe("upper", () => {
    it.each(inputs.map((s, i) => [i, s]))("#%i: %j", (_i, input) => {
      const program: Program = {
        expressions: [{ type: "upper", inner: { type: "constant", value: input as string } }],
      };
      expect(applyProgram(program, ["x"])).toBe((input as string).toUpperCase());
    });
  });

  describe("lower", () => {
    it.each(inputs.map((s, i) => [i, s]))("#%i: %j", (_i, input) => {
      const program: Program = {
        expressions: [{ type: "lower", inner: { type: "constant", value: input as string } }],
      };
      expect(applyProgram(program, ["x"])).toBe((input as string).toLowerCase());
    });
  });

  describe("capitalize", () => {
    it.each(inputs.map((s, i) => [i, s]))("#%i: %j", (_i, input) => {
      const program: Program = {
        expressions: [{ type: "capitalize", inner: { type: "constant", value: input as string } }],
      };
      const str = input as string;
      const expected = str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
      expect(applyProgram(program, ["x"])).toBe(expected);
    });
  });
});

// ============================================================================
// 5. applyProgram with concat (50 tests)
// ============================================================================

describe("applyProgram - concat expressions", () => {
  const concatCases: [string, string, Expression[], string][] = [
    ...Array.from({ length: 25 }, (_, i): [string, string, Expression[], string] => {
      const src = `Hello World Number ${i}`;
      const parts: Expression[] = [
        { type: "substring", sourceIndex: 0, start: 0, end: 5 },
        { type: "constant", value: "-" },
        { type: "substring", sourceIndex: 0, start: 6, end: 11 },
      ];
      const expected = "Hello-World";
      return [`concat #${i} substring+const+substring`, src, parts, expected];
    }),
    ...Array.from({ length: 25 }, (_, i): [string, string, Expression[], string] => {
      const val1 = `v${i}`;
      const val2 = `w${i}`;
      const sep = i % 2 === 0 ? " " : "_";
      const parts: Expression[] = [
        { type: "constant", value: val1 },
        { type: "constant", value: sep },
        { type: "constant", value: val2 },
      ];
      const expected = val1 + sep + val2;
      return [`concat #${i + 25} constants`, "unused", parts, expected];
    }),
  ];

  it.each(concatCases)("%s", (_desc, source, parts, expected) => {
    const program: Program = { expressions: [{ type: "concat", parts }] };
    expect(applyProgram(program, [source])).toBe(expected);
  });
});

// ============================================================================
// 6. learn accuracy (50 tests)
// ============================================================================

describe("learn accuracy", () => {
  const learnCases: [string, { sources: string[]; output: string }[], string[], string[]][] = [
    // [description, examples, testInputs, expectedOutputs]
    ["first name from full name #1", [{ sources: ["John Smith"], output: "John" }], ["Jane Doe"], ["Jane"]],
    ["first name from full name #2", [{ sources: ["Alice Cooper"], output: "Alice" }], ["Bob Marley"], ["Bob"]],
    ["first name from full name #3", [{ sources: ["Tom Hanks"], output: "Tom" }], ["Tim Cook"], ["Tim"]],
    ["last name from full name #1", [{ sources: ["John Smith"], output: "Smith" }], ["Jane Doe"], ["Doe"]],
    ["last name from full name #2", [{ sources: ["Alice Cooper"], output: "Cooper" }], ["Bob Marley"], ["Marley"]],
    ["domain from email #1", [{ sources: ["user@example.com"], output: "example.com" }], ["admin@test.org"], ["test.org"]],
    ["domain from email #2", [{ sources: ["john@gmail.com"], output: "gmail.com" }], ["jane@yahoo.com"], ["yahoo.com"]],
    ["username from email #1", [{ sources: ["user@example.com"], output: "user" }], ["admin@test.org"], ["admin"]],
    ["username from email #2", [{ sources: ["john.doe@work.com"], output: "john.doe" }], ["jane.smith@corp.io"], ["jane.smith"]],
    ["uppercase #1", [{ sources: ["hello"], output: "HELLO" }], ["world"], ["WORLD"]],
    ["uppercase #2", [{ sources: ["abc"], output: "ABC" }], ["xyz"], ["XYZ"]],
    ["uppercase #3", [{ sources: ["test"], output: "TEST" }], ["data"], ["DATA"]],
    ["lowercase #1", [{ sources: ["HELLO"], output: "hello" }], ["WORLD"], ["world"]],
    ["lowercase #2", [{ sources: ["ABC"], output: "abc" }], ["XYZ"], ["xyz"]],
    ["capitalize #1", [{ sources: ["hello"], output: "Hello" }], ["world"], ["World"]],
    ["capitalize #2", [{ sources: ["jOHN"], output: "John" }], ["mARK"], ["Mark"]],
    ["first 3 chars #1", [{ sources: ["January"], output: "Jan" }], ["February"], ["Feb"]],
    ["first 3 chars #2", [{ sources: ["Monday"], output: "Mon" }], ["Tuesday"], ["Tue"]],
    ["first 3 chars #3", [{ sources: ["December"], output: "Dec" }], ["November"], ["Nov"]],
    ["csv first field #1", [{ sources: ["a,b,c"], output: "a" }], ["x,y,z"], ["x"]],
    ["csv second field #1", [{ sources: ["a,b,c"], output: "b" }], ["x,y,z"], ["y"]],
    ["csv third field #1", [{ sources: ["a,b,c"], output: "c" }], ["x,y,z"], ["z"]],
    ["csv first field #2", [{ sources: ["red,green,blue"], output: "red" }], ["one,two,three"], ["one"]],
    ["csv last field #2", [{ sources: ["red,green,blue"], output: "blue" }], ["one,two,three"], ["three"]],
    ["dash split #1", [{ sources: ["2024-03-15"], output: "2024" }], ["2025-12-01"], ["2025"]],
    ["dash split #2", [{ sources: ["2024-03-15"], output: "03" }], ["2025-12-01"], ["12"]],
    ["dash split #3", [{ sources: ["2024-03-15"], output: "15" }], ["2025-12-01"], ["01"]],
    ["underscore split #1", [{ sources: ["my_var_name"], output: "my" }], ["your_func_call"], ["your"]],
    ["underscore split #2", [{ sources: ["my_var_name"], output: "var" }], ["your_func_call"], ["func"]],
    ["underscore split #3", [{ sources: ["my_var_name"], output: "name" }], ["your_func_call"], ["call"]],
    ["space split first of 4 #1", [{ sources: ["one two three four"], output: "one" }], ["red green blue pink"], ["red"]],
    ["space split second of 4", [{ sources: ["one two three four"], output: "two" }], ["red green blue pink"], ["green"]],
    ["space split third of 4", [{ sources: ["one two three four"], output: "three" }], ["red green blue pink"], ["blue"]],
    ["space split fourth of 4", [{ sources: ["one two three four"], output: "four" }], ["red green blue pink"], ["pink"]],
    ["comma split 4th", [{ sources: ["a,b,c,d,e"], output: "d" }], ["v,w,x,y,z"], ["y"]],
    ["tab split #1", [{ sources: ["col1\tcol2\tcol3"], output: "col1" }], ["data1\tdata2\tdata3"], ["data1"]],
    ["tab split #2", [{ sources: ["col1\tcol2\tcol3"], output: "col2" }], ["data1\tdata2\tdata3"], ["data2"]],
    ["tab split #3", [{ sources: ["col1\tcol2\tcol3"], output: "col3" }], ["data1\tdata2\tdata3"], ["data3"]],
    ["dot split domain #1", [{ sources: ["www.example.com"], output: "example" }], ["www.google.com"], ["google"]],
    ["dot split domain #2", [{ sources: ["www.example.com"], output: "com" }], ["www.google.com"], ["com"]],
    ["pipe split #1", [{ sources: ["a|b|c"], output: "a" }], ["x|y|z"], ["x"]],
    ["pipe split #2", [{ sources: ["a|b|c"], output: "b" }], ["x|y|z"], ["y"]],
    ["pipe split #3", [{ sources: ["a|b|c"], output: "c" }], ["x|y|z"], ["z"]],
    ["semicolon split #1", [{ sources: ["one;two;three"], output: "one" }], ["red;green;blue"], ["red"]],
    ["semicolon split #2", [{ sources: ["one;two;three"], output: "two" }], ["red;green;blue"], ["green"]],
    ["at split #1", [{ sources: ["user@host"], output: "user" }], ["admin@server"], ["admin"]],
    ["at split #2", [{ sources: ["user@host"], output: "host" }], ["admin@server"], ["server"]],
    ["slash split #1", [{ sources: ["path/to/file"], output: "path" }], ["home/user/docs"], ["home"]],
    ["slash split #2", [{ sources: ["path/to/file"], output: "file" }], ["home/user/docs"], ["docs"]],
    ["space last word", [{ sources: ["The Quick Brown"], output: "Brown" }], ["A Fast Red"], ["Red"]],
  ];

  it.each(learnCases)(
    "%s",
    (_desc, examples, testInputs, expectedOutputs) => {
      const program = learn(examples);
      expect(program).not.toBeNull();
      for (let i = 0; i < testInputs.length; i++) {
        const sources = Array.isArray(examples[0].sources) && examples[0].sources.length > 1
          ? [testInputs[i], testInputs[i + 1] || ""].slice(0, examples[0].sources.length)
          : [testInputs[i]];
        // For multi-source, testInputs alternates source values
        if (examples[0].sources.length > 1) {
          const srcCount = examples[0].sources.length;
          const actualSources = testInputs.slice(i * srcCount, (i + 1) * srcCount);
          if (actualSources.length === srcCount) {
            expect(applyProgram(program!, actualSources)).toBe(expectedOutputs[i]);
          }
        } else {
          expect(applyProgram(program!, [testInputs[i]])).toBe(expectedOutputs[i]);
        }
      }
    },
  );
});
