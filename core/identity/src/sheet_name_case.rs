//! FILENAME: core/identity/src/sheet_name_case.rs
//! PURPOSE: The ONE rule for when two sheet names are the same name -- Excel's
//!          case rule, measured live -- and the lookup key every sheet-name map
//!          and comparison in the product is built from.
//!
//! WHY IT LIVES HERE. Every crate that compares sheet names (parser, engine,
//! calp, the app) depends on `identity`, and a rule two crates spell twice is two
//! rules on the first change. Before this module the product had three: the
//! uniqueness check folded with `to_uppercase` (Unicode FULL uppercasing, so
//! `Straße` and `STRASSE` were one name -- Excel accepts both), the engine's
//! sheet maps were keyed by `to_uppercase` (so once both existed a formula read
//! whichever registered last), and most other doors compared
//! `eq_ignore_ascii_case` (so an application update could install `ärende`
//! beside `Ärende`, which Excel refuses).
//!
//! WHAT EXCEL DOES [LIVE, Excel 16, 2026-10-30, sv-SE regional settings]. Each of
//! 1,516 pairs -- every pair of code points that Unicode's single-character
//! upper/lower mappings connect, BMP and supplementary -- was tried as two sheet
//! names `q<a>` / `q<b>` in a fresh workbook; Excel refused the second
//! ("already taken") for 1,046 pairs and accepted 470. The refused set is
//! transitive and is the table below: 1,028 classes, 1,037 rows, all in the BMP.
//! It is simple per-character case equivalence, not Unicode full case mapping
//! and not Unicode case folding:
//!
//!   * SAME: `Ärende`/`ärende`, `ß`/`ẞ`, `ς`/`σ`/`Σ`, `Ǆ`/`ǅ`/`ǆ`, full-width
//!     `Ａ`/`ａ`, the Kelvin sign `K`/`k`/`K`, the Ohm sign `Ω`/`ω`, Roman
//!     numerals and circled letters by case, Georgian Asomtavruli/Nuskhuri.
//!   * DIFFERENT: `Straße`/`STRASSE` (no expansion), `i`/`İ` and `ı`/`I`
//!     (no Turkish rule), `µ`/`μ`, `ſ`/`s`, `ϑ`/`θ`, `ͅ`/`ι`, the Angstrom
//!     sign `Å`/`å`, full-width `Ａ` vs `A`, a combining accent vs the
//!     precomposed letter, Cherokee small letters, Georgian Mtavruli, the
//!     Cyrillic/Latin letters Unicode added after Windows' table, and every
//!     supplementary-plane letter (Deseret, Osage, ...).
//!
//! Excel's comparison is in fact `CompareStringEx(user locale, NORM_IGNORECASE)`
//! gated on equal UTF-16 length: it matched all 1,516 pairs with zero
//! mismatches, where `CompareStringOrdinal`, `LCMapStringEx` upper/lower and
//! .NET's ordinal-ignore-case each missed 73 to 122. That linguistic comparison
//! ALSO equates some equal-length strings that differ by more than case --
//! `q` + U+200D against `q` + U+FEFF (two ignorable characters), `ae` against
//! `æ` + U+200D, `A` against the modifier letter `ᴬ`, `qq` against `q〱` (a kana
//! repeat mark). Those are sort-table artefacts of the user's LOCALE, not case,
//! and a document's sheet lookups cannot change with the machine that opens it,
//! so this rule deliberately reproduces the case half only, from a fixed table.
//! The table is the sv-SE one; the only measured locale difference is the
//! Angstrom sign, which an invariant-locale comparison folds into `å`.
//!
//! LENGTH-PRESERVING BY CONSTRUCTION: every row maps one BMP character to one
//! BMP character, so a key has as many characters as its name and two names
//! that differ in length are never the same name -- which is exactly why
//! `Straße` and `STRASSE` are two sheets in Excel.

/// The class representative of `c` under Excel's sheet-name case rule.
///
/// The representative is the class's UPPERCASE member with the lowest code
/// point (or its lowest member when none is uppercase), so an ASCII name's key
/// is simply that name uppercased -- `sheet1` and `Sheet1` both key as `SHEET1`,
/// the spelling every pre-existing uppercase-keyed map already used.
#[inline]
pub fn fold_sheet_name_char(c: char) -> char {
    if c.is_ascii() {
        return c.to_ascii_uppercase();
    }
    match EXCEL_SHEET_NAME_CASE_TABLE.binary_search_by(|(from, _)| from.cmp(&c)) {
        Ok(i) => EXCEL_SHEET_NAME_CASE_TABLE[i].1,
        Err(_) => c,
    }
}

/// The lookup key of a sheet name: two names have the same key exactly when
/// Excel treats them as the same sheet name. Use it for EVERY map keyed by a
/// sheet name and every comparison of two sheet names; never `to_uppercase`
/// (which merges `Straße` with `STRASSE`) and never `eq_ignore_ascii_case`
/// (which keeps `ärende` apart from `Ärende`).
pub fn sheet_name_key(name: &str) -> String {
    name.chars().map(fold_sheet_name_char).collect()
}

/// Whether two sheet names are the same name, by Excel's rule. Allocation-free.
pub fn sheet_names_equal(a: &str, b: &str) -> bool {
    let mut x = a.chars();
    let mut y = b.chars();
    loop {
        match (x.next(), y.next()) {
            (None, None) => return true,
            (Some(p), Some(q)) => {
                if p != q && fold_sheet_name_char(p) != fold_sheet_name_char(q) {
                    return false;
                }
            }
            _ => return false,
        }
    }
}

/// The position of the sheet called `name` in `names`, by Excel's rule.
pub fn position_of_sheet_name<S: AsRef<str>>(names: &[S], name: &str) -> Option<usize> {
    names.iter().position(|n| sheet_names_equal(n.as_ref(), name))
}

/// `(character, class representative)` for every character Excel treats as the
/// same sheet-name character as some OTHER character, sorted by character.
/// Generated from the live probe described in the module note; do not edit by
/// hand -- a row added here is a pair of names Excel was never asked about.
pub static EXCEL_SHEET_NAME_CASE_TABLE: [(char, char); 1037] = [
    ('\u{61}', '\u{41}'), ('\u{62}', '\u{42}'), ('\u{63}', '\u{43}'), ('\u{64}', '\u{44}'),
    ('\u{65}', '\u{45}'), ('\u{66}', '\u{46}'), ('\u{67}', '\u{47}'), ('\u{68}', '\u{48}'),
    ('\u{69}', '\u{49}'), ('\u{6A}', '\u{4A}'), ('\u{6B}', '\u{4B}'), ('\u{6C}', '\u{4C}'),
    ('\u{6D}', '\u{4D}'), ('\u{6E}', '\u{4E}'), ('\u{6F}', '\u{4F}'), ('\u{70}', '\u{50}'),
    ('\u{71}', '\u{51}'), ('\u{72}', '\u{52}'), ('\u{73}', '\u{53}'), ('\u{74}', '\u{54}'),
    ('\u{75}', '\u{55}'), ('\u{76}', '\u{56}'), ('\u{77}', '\u{57}'), ('\u{78}', '\u{58}'),
    ('\u{79}', '\u{59}'), ('\u{7A}', '\u{5A}'), ('\u{DF}', '\u{1E9E}'), ('\u{E0}', '\u{C0}'),
    ('\u{E1}', '\u{C1}'), ('\u{E2}', '\u{C2}'), ('\u{E3}', '\u{C3}'), ('\u{E4}', '\u{C4}'),
    ('\u{E5}', '\u{C5}'), ('\u{E6}', '\u{C6}'), ('\u{E7}', '\u{C7}'), ('\u{E8}', '\u{C8}'),
    ('\u{E9}', '\u{C9}'), ('\u{EA}', '\u{CA}'), ('\u{EB}', '\u{CB}'), ('\u{EC}', '\u{CC}'),
    ('\u{ED}', '\u{CD}'), ('\u{EE}', '\u{CE}'), ('\u{EF}', '\u{CF}'), ('\u{F0}', '\u{D0}'),
    ('\u{F1}', '\u{D1}'), ('\u{F2}', '\u{D2}'), ('\u{F3}', '\u{D3}'), ('\u{F4}', '\u{D4}'),
    ('\u{F5}', '\u{D5}'), ('\u{F6}', '\u{D6}'), ('\u{F8}', '\u{D8}'), ('\u{F9}', '\u{D9}'),
    ('\u{FA}', '\u{DA}'), ('\u{FB}', '\u{DB}'), ('\u{FC}', '\u{DC}'), ('\u{FD}', '\u{DD}'),
    ('\u{FE}', '\u{DE}'), ('\u{FF}', '\u{178}'), ('\u{101}', '\u{100}'), ('\u{103}', '\u{102}'),
    ('\u{105}', '\u{104}'), ('\u{107}', '\u{106}'), ('\u{109}', '\u{108}'), ('\u{10B}', '\u{10A}'),
    ('\u{10D}', '\u{10C}'), ('\u{10F}', '\u{10E}'), ('\u{111}', '\u{110}'), ('\u{113}', '\u{112}'),
    ('\u{115}', '\u{114}'), ('\u{117}', '\u{116}'), ('\u{119}', '\u{118}'), ('\u{11B}', '\u{11A}'),
    ('\u{11D}', '\u{11C}'), ('\u{11F}', '\u{11E}'), ('\u{121}', '\u{120}'), ('\u{123}', '\u{122}'),
    ('\u{125}', '\u{124}'), ('\u{127}', '\u{126}'), ('\u{129}', '\u{128}'), ('\u{12B}', '\u{12A}'),
    ('\u{12D}', '\u{12C}'), ('\u{12F}', '\u{12E}'), ('\u{133}', '\u{132}'), ('\u{135}', '\u{134}'),
    ('\u{137}', '\u{136}'), ('\u{13A}', '\u{139}'), ('\u{13C}', '\u{13B}'), ('\u{13E}', '\u{13D}'),
    ('\u{140}', '\u{13F}'), ('\u{142}', '\u{141}'), ('\u{144}', '\u{143}'), ('\u{146}', '\u{145}'),
    ('\u{148}', '\u{147}'), ('\u{14B}', '\u{14A}'), ('\u{14D}', '\u{14C}'), ('\u{14F}', '\u{14E}'),
    ('\u{151}', '\u{150}'), ('\u{153}', '\u{152}'), ('\u{155}', '\u{154}'), ('\u{157}', '\u{156}'),
    ('\u{159}', '\u{158}'), ('\u{15B}', '\u{15A}'), ('\u{15D}', '\u{15C}'), ('\u{15F}', '\u{15E}'),
    ('\u{161}', '\u{160}'), ('\u{163}', '\u{162}'), ('\u{165}', '\u{164}'), ('\u{167}', '\u{166}'),
    ('\u{169}', '\u{168}'), ('\u{16B}', '\u{16A}'), ('\u{16D}', '\u{16C}'), ('\u{16F}', '\u{16E}'),
    ('\u{171}', '\u{170}'), ('\u{173}', '\u{172}'), ('\u{175}', '\u{174}'), ('\u{177}', '\u{176}'),
    ('\u{17A}', '\u{179}'), ('\u{17C}', '\u{17B}'), ('\u{17E}', '\u{17D}'), ('\u{180}', '\u{243}'),
    ('\u{183}', '\u{182}'), ('\u{185}', '\u{184}'), ('\u{188}', '\u{187}'), ('\u{18C}', '\u{18B}'),
    ('\u{192}', '\u{191}'), ('\u{195}', '\u{1F6}'), ('\u{199}', '\u{198}'), ('\u{19A}', '\u{23D}'),
    ('\u{19E}', '\u{220}'), ('\u{1A1}', '\u{1A0}'), ('\u{1A3}', '\u{1A2}'), ('\u{1A5}', '\u{1A4}'),
    ('\u{1A8}', '\u{1A7}'), ('\u{1AD}', '\u{1AC}'), ('\u{1B0}', '\u{1AF}'), ('\u{1B4}', '\u{1B3}'),
    ('\u{1B6}', '\u{1B5}'), ('\u{1B9}', '\u{1B8}'), ('\u{1BD}', '\u{1BC}'), ('\u{1BF}', '\u{1F7}'),
    ('\u{1C5}', '\u{1C4}'), ('\u{1C6}', '\u{1C4}'), ('\u{1C8}', '\u{1C7}'), ('\u{1C9}', '\u{1C7}'),
    ('\u{1CB}', '\u{1CA}'), ('\u{1CC}', '\u{1CA}'), ('\u{1CE}', '\u{1CD}'), ('\u{1D0}', '\u{1CF}'),
    ('\u{1D2}', '\u{1D1}'), ('\u{1D4}', '\u{1D3}'), ('\u{1D6}', '\u{1D5}'), ('\u{1D8}', '\u{1D7}'),
    ('\u{1DA}', '\u{1D9}'), ('\u{1DC}', '\u{1DB}'), ('\u{1DD}', '\u{18E}'), ('\u{1DF}', '\u{1DE}'),
    ('\u{1E1}', '\u{1E0}'), ('\u{1E3}', '\u{1E2}'), ('\u{1E5}', '\u{1E4}'), ('\u{1E7}', '\u{1E6}'),
    ('\u{1E9}', '\u{1E8}'), ('\u{1EB}', '\u{1EA}'), ('\u{1ED}', '\u{1EC}'), ('\u{1EF}', '\u{1EE}'),
    ('\u{1F2}', '\u{1F1}'), ('\u{1F3}', '\u{1F1}'), ('\u{1F5}', '\u{1F4}'), ('\u{1F9}', '\u{1F8}'),
    ('\u{1FB}', '\u{1FA}'), ('\u{1FD}', '\u{1FC}'), ('\u{1FF}', '\u{1FE}'), ('\u{201}', '\u{200}'),
    ('\u{203}', '\u{202}'), ('\u{205}', '\u{204}'), ('\u{207}', '\u{206}'), ('\u{209}', '\u{208}'),
    ('\u{20B}', '\u{20A}'), ('\u{20D}', '\u{20C}'), ('\u{20F}', '\u{20E}'), ('\u{211}', '\u{210}'),
    ('\u{213}', '\u{212}'), ('\u{215}', '\u{214}'), ('\u{217}', '\u{216}'), ('\u{219}', '\u{218}'),
    ('\u{21B}', '\u{21A}'), ('\u{21D}', '\u{21C}'), ('\u{21F}', '\u{21E}'), ('\u{223}', '\u{222}'),
    ('\u{225}', '\u{224}'), ('\u{227}', '\u{226}'), ('\u{229}', '\u{228}'), ('\u{22B}', '\u{22A}'),
    ('\u{22D}', '\u{22C}'), ('\u{22F}', '\u{22E}'), ('\u{231}', '\u{230}'), ('\u{233}', '\u{232}'),
    ('\u{23C}', '\u{23B}'), ('\u{23F}', '\u{2C7E}'), ('\u{240}', '\u{2C7F}'), ('\u{242}', '\u{241}'),
    ('\u{247}', '\u{246}'), ('\u{249}', '\u{248}'), ('\u{24B}', '\u{24A}'), ('\u{24D}', '\u{24C}'),
    ('\u{24F}', '\u{24E}'), ('\u{250}', '\u{2C6F}'), ('\u{251}', '\u{2C6D}'), ('\u{253}', '\u{181}'),
    ('\u{254}', '\u{186}'), ('\u{256}', '\u{189}'), ('\u{257}', '\u{18A}'), ('\u{259}', '\u{18F}'),
    ('\u{25B}', '\u{190}'), ('\u{260}', '\u{193}'), ('\u{263}', '\u{194}'), ('\u{268}', '\u{197}'),
    ('\u{269}', '\u{196}'), ('\u{26B}', '\u{2C62}'), ('\u{26F}', '\u{19C}'), ('\u{271}', '\u{2C6E}'),
    ('\u{272}', '\u{19D}'), ('\u{275}', '\u{19F}'), ('\u{27D}', '\u{2C64}'), ('\u{280}', '\u{1A6}'),
    ('\u{283}', '\u{1A9}'), ('\u{288}', '\u{1AE}'), ('\u{289}', '\u{244}'), ('\u{28A}', '\u{1B1}'),
    ('\u{28B}', '\u{1B2}'), ('\u{28C}', '\u{245}'), ('\u{292}', '\u{1B7}'), ('\u{371}', '\u{370}'),
    ('\u{373}', '\u{372}'), ('\u{377}', '\u{376}'), ('\u{37B}', '\u{3FD}'), ('\u{37C}', '\u{3FE}'),
    ('\u{37D}', '\u{3FF}'), ('\u{3AC}', '\u{386}'), ('\u{3AD}', '\u{388}'), ('\u{3AE}', '\u{389}'),
    ('\u{3AF}', '\u{38A}'), ('\u{3B1}', '\u{391}'), ('\u{3B2}', '\u{392}'), ('\u{3B3}', '\u{393}'),
    ('\u{3B4}', '\u{394}'), ('\u{3B5}', '\u{395}'), ('\u{3B6}', '\u{396}'), ('\u{3B7}', '\u{397}'),
    ('\u{3B8}', '\u{398}'), ('\u{3B9}', '\u{399}'), ('\u{3BA}', '\u{39A}'), ('\u{3BB}', '\u{39B}'),
    ('\u{3BC}', '\u{39C}'), ('\u{3BD}', '\u{39D}'), ('\u{3BE}', '\u{39E}'), ('\u{3BF}', '\u{39F}'),
    ('\u{3C0}', '\u{3A0}'), ('\u{3C1}', '\u{3A1}'), ('\u{3C2}', '\u{3A3}'), ('\u{3C3}', '\u{3A3}'),
    ('\u{3C4}', '\u{3A4}'), ('\u{3C5}', '\u{3A5}'), ('\u{3C6}', '\u{3A6}'), ('\u{3C7}', '\u{3A7}'),
    ('\u{3C8}', '\u{3A8}'), ('\u{3C9}', '\u{3A9}'), ('\u{3CA}', '\u{3AA}'), ('\u{3CB}', '\u{3AB}'),
    ('\u{3CC}', '\u{38C}'), ('\u{3CD}', '\u{38E}'), ('\u{3CE}', '\u{38F}'), ('\u{3D1}', '\u{3F4}'),
    ('\u{3D7}', '\u{3CF}'), ('\u{3D9}', '\u{3D8}'), ('\u{3DB}', '\u{3DA}'), ('\u{3DD}', '\u{3DC}'),
    ('\u{3DF}', '\u{3DE}'), ('\u{3E1}', '\u{3E0}'), ('\u{3E3}', '\u{3E2}'), ('\u{3E5}', '\u{3E4}'),
    ('\u{3E7}', '\u{3E6}'), ('\u{3E9}', '\u{3E8}'), ('\u{3EB}', '\u{3EA}'), ('\u{3ED}', '\u{3EC}'),
    ('\u{3EF}', '\u{3EE}'), ('\u{3F2}', '\u{3F9}'), ('\u{3F5}', '\u{395}'), ('\u{3F8}', '\u{3F7}'),
    ('\u{3FB}', '\u{3FA}'), ('\u{430}', '\u{410}'), ('\u{431}', '\u{411}'), ('\u{432}', '\u{412}'),
    ('\u{433}', '\u{413}'), ('\u{434}', '\u{414}'), ('\u{435}', '\u{415}'), ('\u{436}', '\u{416}'),
    ('\u{437}', '\u{417}'), ('\u{438}', '\u{418}'), ('\u{439}', '\u{419}'), ('\u{43A}', '\u{41A}'),
    ('\u{43B}', '\u{41B}'), ('\u{43C}', '\u{41C}'), ('\u{43D}', '\u{41D}'), ('\u{43E}', '\u{41E}'),
    ('\u{43F}', '\u{41F}'), ('\u{440}', '\u{420}'), ('\u{441}', '\u{421}'), ('\u{442}', '\u{422}'),
    ('\u{443}', '\u{423}'), ('\u{444}', '\u{424}'), ('\u{445}', '\u{425}'), ('\u{446}', '\u{426}'),
    ('\u{447}', '\u{427}'), ('\u{448}', '\u{428}'), ('\u{449}', '\u{429}'), ('\u{44A}', '\u{42A}'),
    ('\u{44B}', '\u{42B}'), ('\u{44C}', '\u{42C}'), ('\u{44D}', '\u{42D}'), ('\u{44E}', '\u{42E}'),
    ('\u{44F}', '\u{42F}'), ('\u{450}', '\u{400}'), ('\u{451}', '\u{401}'), ('\u{452}', '\u{402}'),
    ('\u{453}', '\u{403}'), ('\u{454}', '\u{404}'), ('\u{455}', '\u{405}'), ('\u{456}', '\u{406}'),
    ('\u{457}', '\u{407}'), ('\u{458}', '\u{408}'), ('\u{459}', '\u{409}'), ('\u{45A}', '\u{40A}'),
    ('\u{45B}', '\u{40B}'), ('\u{45C}', '\u{40C}'), ('\u{45D}', '\u{40D}'), ('\u{45E}', '\u{40E}'),
    ('\u{45F}', '\u{40F}'), ('\u{461}', '\u{460}'), ('\u{463}', '\u{462}'), ('\u{465}', '\u{464}'),
    ('\u{467}', '\u{466}'), ('\u{469}', '\u{468}'), ('\u{46B}', '\u{46A}'), ('\u{46D}', '\u{46C}'),
    ('\u{46F}', '\u{46E}'), ('\u{471}', '\u{470}'), ('\u{473}', '\u{472}'), ('\u{475}', '\u{474}'),
    ('\u{477}', '\u{476}'), ('\u{479}', '\u{478}'), ('\u{47B}', '\u{47A}'), ('\u{47D}', '\u{47C}'),
    ('\u{47F}', '\u{47E}'), ('\u{481}', '\u{480}'), ('\u{48B}', '\u{48A}'), ('\u{48D}', '\u{48C}'),
    ('\u{48F}', '\u{48E}'), ('\u{491}', '\u{490}'), ('\u{493}', '\u{492}'), ('\u{495}', '\u{494}'),
    ('\u{497}', '\u{496}'), ('\u{499}', '\u{498}'), ('\u{49B}', '\u{49A}'), ('\u{49D}', '\u{49C}'),
    ('\u{49F}', '\u{49E}'), ('\u{4A1}', '\u{4A0}'), ('\u{4A3}', '\u{4A2}'), ('\u{4A5}', '\u{4A4}'),
    ('\u{4A7}', '\u{4A6}'), ('\u{4A9}', '\u{4A8}'), ('\u{4AB}', '\u{4AA}'), ('\u{4AD}', '\u{4AC}'),
    ('\u{4AF}', '\u{4AE}'), ('\u{4B1}', '\u{4B0}'), ('\u{4B3}', '\u{4B2}'), ('\u{4B5}', '\u{4B4}'),
    ('\u{4B7}', '\u{4B6}'), ('\u{4B9}', '\u{4B8}'), ('\u{4BB}', '\u{4BA}'), ('\u{4BD}', '\u{4BC}'),
    ('\u{4BF}', '\u{4BE}'), ('\u{4C2}', '\u{4C1}'), ('\u{4C4}', '\u{4C3}'), ('\u{4C6}', '\u{4C5}'),
    ('\u{4C8}', '\u{4C7}'), ('\u{4CA}', '\u{4C9}'), ('\u{4CC}', '\u{4CB}'), ('\u{4CE}', '\u{4CD}'),
    ('\u{4CF}', '\u{4C0}'), ('\u{4D1}', '\u{4D0}'), ('\u{4D3}', '\u{4D2}'), ('\u{4D5}', '\u{4D4}'),
    ('\u{4D7}', '\u{4D6}'), ('\u{4D9}', '\u{4D8}'), ('\u{4DB}', '\u{4DA}'), ('\u{4DD}', '\u{4DC}'),
    ('\u{4DF}', '\u{4DE}'), ('\u{4E1}', '\u{4E0}'), ('\u{4E3}', '\u{4E2}'), ('\u{4E5}', '\u{4E4}'),
    ('\u{4E7}', '\u{4E6}'), ('\u{4E9}', '\u{4E8}'), ('\u{4EB}', '\u{4EA}'), ('\u{4ED}', '\u{4EC}'),
    ('\u{4EF}', '\u{4EE}'), ('\u{4F1}', '\u{4F0}'), ('\u{4F3}', '\u{4F2}'), ('\u{4F5}', '\u{4F4}'),
    ('\u{4F7}', '\u{4F6}'), ('\u{4F9}', '\u{4F8}'), ('\u{4FB}', '\u{4FA}'), ('\u{4FD}', '\u{4FC}'),
    ('\u{4FF}', '\u{4FE}'), ('\u{501}', '\u{500}'), ('\u{503}', '\u{502}'), ('\u{505}', '\u{504}'),
    ('\u{507}', '\u{506}'), ('\u{509}', '\u{508}'), ('\u{50B}', '\u{50A}'), ('\u{50D}', '\u{50C}'),
    ('\u{50F}', '\u{50E}'), ('\u{511}', '\u{510}'), ('\u{513}', '\u{512}'), ('\u{515}', '\u{514}'),
    ('\u{517}', '\u{516}'), ('\u{519}', '\u{518}'), ('\u{51B}', '\u{51A}'), ('\u{51D}', '\u{51C}'),
    ('\u{51F}', '\u{51E}'), ('\u{521}', '\u{520}'), ('\u{523}', '\u{522}'), ('\u{525}', '\u{524}'),
    ('\u{527}', '\u{526}'), ('\u{529}', '\u{528}'), ('\u{52B}', '\u{52A}'), ('\u{52D}', '\u{52C}'),
    ('\u{52F}', '\u{52E}'), ('\u{561}', '\u{531}'), ('\u{562}', '\u{532}'), ('\u{563}', '\u{533}'),
    ('\u{564}', '\u{534}'), ('\u{565}', '\u{535}'), ('\u{566}', '\u{536}'), ('\u{567}', '\u{537}'),
    ('\u{568}', '\u{538}'), ('\u{569}', '\u{539}'), ('\u{56A}', '\u{53A}'), ('\u{56B}', '\u{53B}'),
    ('\u{56C}', '\u{53C}'), ('\u{56D}', '\u{53D}'), ('\u{56E}', '\u{53E}'), ('\u{56F}', '\u{53F}'),
    ('\u{570}', '\u{540}'), ('\u{571}', '\u{541}'), ('\u{572}', '\u{542}'), ('\u{573}', '\u{543}'),
    ('\u{574}', '\u{544}'), ('\u{575}', '\u{545}'), ('\u{576}', '\u{546}'), ('\u{577}', '\u{547}'),
    ('\u{578}', '\u{548}'), ('\u{579}', '\u{549}'), ('\u{57A}', '\u{54A}'), ('\u{57B}', '\u{54B}'),
    ('\u{57C}', '\u{54C}'), ('\u{57D}', '\u{54D}'), ('\u{57E}', '\u{54E}'), ('\u{57F}', '\u{54F}'),
    ('\u{580}', '\u{550}'), ('\u{581}', '\u{551}'), ('\u{582}', '\u{552}'), ('\u{583}', '\u{553}'),
    ('\u{584}', '\u{554}'), ('\u{585}', '\u{555}'), ('\u{586}', '\u{556}'), ('\u{10FD}', '\u{1CBD}'),
    ('\u{10FE}', '\u{1CBE}'), ('\u{10FF}', '\u{1CBF}'), ('\u{13FD}', '\u{13F5}'), ('\u{1C85}', '\u{1C84}'),
    ('\u{1C8A}', '\u{1C89}'), ('\u{1D79}', '\u{A77D}'), ('\u{1D7D}', '\u{2C63}'), ('\u{1E01}', '\u{1E00}'),
    ('\u{1E03}', '\u{1E02}'), ('\u{1E05}', '\u{1E04}'), ('\u{1E07}', '\u{1E06}'), ('\u{1E09}', '\u{1E08}'),
    ('\u{1E0B}', '\u{1E0A}'), ('\u{1E0D}', '\u{1E0C}'), ('\u{1E0F}', '\u{1E0E}'), ('\u{1E11}', '\u{1E10}'),
    ('\u{1E13}', '\u{1E12}'), ('\u{1E15}', '\u{1E14}'), ('\u{1E17}', '\u{1E16}'), ('\u{1E19}', '\u{1E18}'),
    ('\u{1E1B}', '\u{1E1A}'), ('\u{1E1D}', '\u{1E1C}'), ('\u{1E1F}', '\u{1E1E}'), ('\u{1E21}', '\u{1E20}'),
    ('\u{1E23}', '\u{1E22}'), ('\u{1E25}', '\u{1E24}'), ('\u{1E27}', '\u{1E26}'), ('\u{1E29}', '\u{1E28}'),
    ('\u{1E2B}', '\u{1E2A}'), ('\u{1E2D}', '\u{1E2C}'), ('\u{1E2F}', '\u{1E2E}'), ('\u{1E31}', '\u{1E30}'),
    ('\u{1E33}', '\u{1E32}'), ('\u{1E35}', '\u{1E34}'), ('\u{1E37}', '\u{1E36}'), ('\u{1E39}', '\u{1E38}'),
    ('\u{1E3B}', '\u{1E3A}'), ('\u{1E3D}', '\u{1E3C}'), ('\u{1E3F}', '\u{1E3E}'), ('\u{1E41}', '\u{1E40}'),
    ('\u{1E43}', '\u{1E42}'), ('\u{1E45}', '\u{1E44}'), ('\u{1E47}', '\u{1E46}'), ('\u{1E49}', '\u{1E48}'),
    ('\u{1E4B}', '\u{1E4A}'), ('\u{1E4D}', '\u{1E4C}'), ('\u{1E4F}', '\u{1E4E}'), ('\u{1E51}', '\u{1E50}'),
    ('\u{1E53}', '\u{1E52}'), ('\u{1E55}', '\u{1E54}'), ('\u{1E57}', '\u{1E56}'), ('\u{1E59}', '\u{1E58}'),
    ('\u{1E5B}', '\u{1E5A}'), ('\u{1E5D}', '\u{1E5C}'), ('\u{1E5F}', '\u{1E5E}'), ('\u{1E61}', '\u{1E60}'),
    ('\u{1E63}', '\u{1E62}'), ('\u{1E65}', '\u{1E64}'), ('\u{1E67}', '\u{1E66}'), ('\u{1E69}', '\u{1E68}'),
    ('\u{1E6B}', '\u{1E6A}'), ('\u{1E6D}', '\u{1E6C}'), ('\u{1E6F}', '\u{1E6E}'), ('\u{1E71}', '\u{1E70}'),
    ('\u{1E73}', '\u{1E72}'), ('\u{1E75}', '\u{1E74}'), ('\u{1E77}', '\u{1E76}'), ('\u{1E79}', '\u{1E78}'),
    ('\u{1E7B}', '\u{1E7A}'), ('\u{1E7D}', '\u{1E7C}'), ('\u{1E7F}', '\u{1E7E}'), ('\u{1E81}', '\u{1E80}'),
    ('\u{1E83}', '\u{1E82}'), ('\u{1E85}', '\u{1E84}'), ('\u{1E87}', '\u{1E86}'), ('\u{1E89}', '\u{1E88}'),
    ('\u{1E8B}', '\u{1E8A}'), ('\u{1E8D}', '\u{1E8C}'), ('\u{1E8F}', '\u{1E8E}'), ('\u{1E91}', '\u{1E90}'),
    ('\u{1E93}', '\u{1E92}'), ('\u{1E95}', '\u{1E94}'), ('\u{1EA1}', '\u{1EA0}'), ('\u{1EA3}', '\u{1EA2}'),
    ('\u{1EA5}', '\u{1EA4}'), ('\u{1EA7}', '\u{1EA6}'), ('\u{1EA9}', '\u{1EA8}'), ('\u{1EAB}', '\u{1EAA}'),
    ('\u{1EAD}', '\u{1EAC}'), ('\u{1EAF}', '\u{1EAE}'), ('\u{1EB1}', '\u{1EB0}'), ('\u{1EB3}', '\u{1EB2}'),
    ('\u{1EB5}', '\u{1EB4}'), ('\u{1EB7}', '\u{1EB6}'), ('\u{1EB9}', '\u{1EB8}'), ('\u{1EBB}', '\u{1EBA}'),
    ('\u{1EBD}', '\u{1EBC}'), ('\u{1EBF}', '\u{1EBE}'), ('\u{1EC1}', '\u{1EC0}'), ('\u{1EC3}', '\u{1EC2}'),
    ('\u{1EC5}', '\u{1EC4}'), ('\u{1EC7}', '\u{1EC6}'), ('\u{1EC9}', '\u{1EC8}'), ('\u{1ECB}', '\u{1ECA}'),
    ('\u{1ECD}', '\u{1ECC}'), ('\u{1ECF}', '\u{1ECE}'), ('\u{1ED1}', '\u{1ED0}'), ('\u{1ED3}', '\u{1ED2}'),
    ('\u{1ED5}', '\u{1ED4}'), ('\u{1ED7}', '\u{1ED6}'), ('\u{1ED9}', '\u{1ED8}'), ('\u{1EDB}', '\u{1EDA}'),
    ('\u{1EDD}', '\u{1EDC}'), ('\u{1EDF}', '\u{1EDE}'), ('\u{1EE1}', '\u{1EE0}'), ('\u{1EE3}', '\u{1EE2}'),
    ('\u{1EE5}', '\u{1EE4}'), ('\u{1EE7}', '\u{1EE6}'), ('\u{1EE9}', '\u{1EE8}'), ('\u{1EEB}', '\u{1EEA}'),
    ('\u{1EED}', '\u{1EEC}'), ('\u{1EEF}', '\u{1EEE}'), ('\u{1EF1}', '\u{1EF0}'), ('\u{1EF3}', '\u{1EF2}'),
    ('\u{1EF5}', '\u{1EF4}'), ('\u{1EF7}', '\u{1EF6}'), ('\u{1EF9}', '\u{1EF8}'), ('\u{1EFB}', '\u{1EFA}'),
    ('\u{1EFD}', '\u{1EFC}'), ('\u{1EFF}', '\u{1EFE}'), ('\u{1F00}', '\u{1F08}'), ('\u{1F01}', '\u{1F09}'),
    ('\u{1F02}', '\u{1F0A}'), ('\u{1F03}', '\u{1F0B}'), ('\u{1F04}', '\u{1F0C}'), ('\u{1F05}', '\u{1F0D}'),
    ('\u{1F06}', '\u{1F0E}'), ('\u{1F07}', '\u{1F0F}'), ('\u{1F10}', '\u{1F18}'), ('\u{1F11}', '\u{1F19}'),
    ('\u{1F12}', '\u{1F1A}'), ('\u{1F13}', '\u{1F1B}'), ('\u{1F14}', '\u{1F1C}'), ('\u{1F15}', '\u{1F1D}'),
    ('\u{1F20}', '\u{1F28}'), ('\u{1F21}', '\u{1F29}'), ('\u{1F22}', '\u{1F2A}'), ('\u{1F23}', '\u{1F2B}'),
    ('\u{1F24}', '\u{1F2C}'), ('\u{1F25}', '\u{1F2D}'), ('\u{1F26}', '\u{1F2E}'), ('\u{1F27}', '\u{1F2F}'),
    ('\u{1F30}', '\u{1F38}'), ('\u{1F31}', '\u{1F39}'), ('\u{1F32}', '\u{1F3A}'), ('\u{1F33}', '\u{1F3B}'),
    ('\u{1F34}', '\u{1F3C}'), ('\u{1F35}', '\u{1F3D}'), ('\u{1F36}', '\u{1F3E}'), ('\u{1F37}', '\u{1F3F}'),
    ('\u{1F40}', '\u{1F48}'), ('\u{1F41}', '\u{1F49}'), ('\u{1F42}', '\u{1F4A}'), ('\u{1F43}', '\u{1F4B}'),
    ('\u{1F44}', '\u{1F4C}'), ('\u{1F45}', '\u{1F4D}'), ('\u{1F51}', '\u{1F59}'), ('\u{1F53}', '\u{1F5B}'),
    ('\u{1F55}', '\u{1F5D}'), ('\u{1F57}', '\u{1F5F}'), ('\u{1F60}', '\u{1F68}'), ('\u{1F61}', '\u{1F69}'),
    ('\u{1F62}', '\u{1F6A}'), ('\u{1F63}', '\u{1F6B}'), ('\u{1F64}', '\u{1F6C}'), ('\u{1F65}', '\u{1F6D}'),
    ('\u{1F66}', '\u{1F6E}'), ('\u{1F67}', '\u{1F6F}'), ('\u{1F70}', '\u{1FBA}'), ('\u{1F71}', '\u{1FBB}'),
    ('\u{1F72}', '\u{1FC8}'), ('\u{1F73}', '\u{1FC9}'), ('\u{1F74}', '\u{1FCA}'), ('\u{1F75}', '\u{1FCB}'),
    ('\u{1F76}', '\u{1FDA}'), ('\u{1F77}', '\u{1FDB}'), ('\u{1F78}', '\u{1FF8}'), ('\u{1F79}', '\u{1FF9}'),
    ('\u{1F7A}', '\u{1FEA}'), ('\u{1F7B}', '\u{1FEB}'), ('\u{1F7C}', '\u{1FFA}'), ('\u{1F7D}', '\u{1FFB}'),
    ('\u{1F88}', '\u{1F80}'), ('\u{1F89}', '\u{1F81}'), ('\u{1F8A}', '\u{1F82}'), ('\u{1F8B}', '\u{1F83}'),
    ('\u{1F8C}', '\u{1F84}'), ('\u{1F8D}', '\u{1F85}'), ('\u{1F8E}', '\u{1F86}'), ('\u{1F8F}', '\u{1F87}'),
    ('\u{1F98}', '\u{1F90}'), ('\u{1F99}', '\u{1F91}'), ('\u{1F9A}', '\u{1F92}'), ('\u{1F9B}', '\u{1F93}'),
    ('\u{1F9C}', '\u{1F94}'), ('\u{1F9D}', '\u{1F95}'), ('\u{1F9E}', '\u{1F96}'), ('\u{1F9F}', '\u{1F97}'),
    ('\u{1FA8}', '\u{1FA0}'), ('\u{1FA9}', '\u{1FA1}'), ('\u{1FAA}', '\u{1FA2}'), ('\u{1FAB}', '\u{1FA3}'),
    ('\u{1FAC}', '\u{1FA4}'), ('\u{1FAD}', '\u{1FA5}'), ('\u{1FAE}', '\u{1FA6}'), ('\u{1FAF}', '\u{1FA7}'),
    ('\u{1FB0}', '\u{1FB8}'), ('\u{1FB1}', '\u{1FB9}'), ('\u{1FBC}', '\u{1FB3}'), ('\u{1FBE}', '\u{399}'),
    ('\u{1FCC}', '\u{1FC3}'), ('\u{1FD0}', '\u{1FD8}'), ('\u{1FD1}', '\u{1FD9}'), ('\u{1FE0}', '\u{1FE8}'),
    ('\u{1FE1}', '\u{1FE9}'), ('\u{1FE5}', '\u{1FEC}'), ('\u{1FFC}', '\u{1FF3}'), ('\u{2126}', '\u{3A9}'),
    ('\u{212A}', '\u{4B}'), ('\u{214E}', '\u{2132}'), ('\u{2170}', '\u{2160}'), ('\u{2171}', '\u{2161}'),
    ('\u{2172}', '\u{2162}'), ('\u{2173}', '\u{2163}'), ('\u{2174}', '\u{2164}'), ('\u{2175}', '\u{2165}'),
    ('\u{2176}', '\u{2166}'), ('\u{2177}', '\u{2167}'), ('\u{2178}', '\u{2168}'), ('\u{2179}', '\u{2169}'),
    ('\u{217A}', '\u{216A}'), ('\u{217B}', '\u{216B}'), ('\u{217C}', '\u{216C}'), ('\u{217D}', '\u{216D}'),
    ('\u{217E}', '\u{216E}'), ('\u{217F}', '\u{216F}'), ('\u{2184}', '\u{2183}'), ('\u{24D0}', '\u{24B6}'),
    ('\u{24D1}', '\u{24B7}'), ('\u{24D2}', '\u{24B8}'), ('\u{24D3}', '\u{24B9}'), ('\u{24D4}', '\u{24BA}'),
    ('\u{24D5}', '\u{24BB}'), ('\u{24D6}', '\u{24BC}'), ('\u{24D7}', '\u{24BD}'), ('\u{24D8}', '\u{24BE}'),
    ('\u{24D9}', '\u{24BF}'), ('\u{24DA}', '\u{24C0}'), ('\u{24DB}', '\u{24C1}'), ('\u{24DC}', '\u{24C2}'),
    ('\u{24DD}', '\u{24C3}'), ('\u{24DE}', '\u{24C4}'), ('\u{24DF}', '\u{24C5}'), ('\u{24E0}', '\u{24C6}'),
    ('\u{24E1}', '\u{24C7}'), ('\u{24E2}', '\u{24C8}'), ('\u{24E3}', '\u{24C9}'), ('\u{24E4}', '\u{24CA}'),
    ('\u{24E5}', '\u{24CB}'), ('\u{24E6}', '\u{24CC}'), ('\u{24E7}', '\u{24CD}'), ('\u{24E8}', '\u{24CE}'),
    ('\u{24E9}', '\u{24CF}'), ('\u{2C30}', '\u{2C00}'), ('\u{2C31}', '\u{2C01}'), ('\u{2C32}', '\u{2C02}'),
    ('\u{2C33}', '\u{2C03}'), ('\u{2C34}', '\u{2C04}'), ('\u{2C35}', '\u{2C05}'), ('\u{2C36}', '\u{2C06}'),
    ('\u{2C37}', '\u{2C07}'), ('\u{2C38}', '\u{2C08}'), ('\u{2C39}', '\u{2C09}'), ('\u{2C3A}', '\u{2C0A}'),
    ('\u{2C3B}', '\u{2C0B}'), ('\u{2C3C}', '\u{2C0C}'), ('\u{2C3D}', '\u{2C0D}'), ('\u{2C3E}', '\u{2C0E}'),
    ('\u{2C3F}', '\u{2C0F}'), ('\u{2C40}', '\u{2C10}'), ('\u{2C41}', '\u{2C11}'), ('\u{2C42}', '\u{2C12}'),
    ('\u{2C43}', '\u{2C13}'), ('\u{2C44}', '\u{2C14}'), ('\u{2C45}', '\u{2C15}'), ('\u{2C46}', '\u{2C16}'),
    ('\u{2C47}', '\u{2C17}'), ('\u{2C48}', '\u{2C18}'), ('\u{2C49}', '\u{2C19}'), ('\u{2C4A}', '\u{2C1A}'),
    ('\u{2C4B}', '\u{2C1B}'), ('\u{2C4C}', '\u{2C1C}'), ('\u{2C4D}', '\u{2C1D}'), ('\u{2C4E}', '\u{2C1E}'),
    ('\u{2C4F}', '\u{2C1F}'), ('\u{2C50}', '\u{2C20}'), ('\u{2C51}', '\u{2C21}'), ('\u{2C52}', '\u{2C22}'),
    ('\u{2C53}', '\u{2C23}'), ('\u{2C54}', '\u{2C24}'), ('\u{2C55}', '\u{2C25}'), ('\u{2C56}', '\u{2C26}'),
    ('\u{2C57}', '\u{2C27}'), ('\u{2C58}', '\u{2C28}'), ('\u{2C59}', '\u{2C29}'), ('\u{2C5A}', '\u{2C2A}'),
    ('\u{2C5B}', '\u{2C2B}'), ('\u{2C5C}', '\u{2C2C}'), ('\u{2C5D}', '\u{2C2D}'), ('\u{2C5E}', '\u{2C2E}'),
    ('\u{2C5F}', '\u{2C2F}'), ('\u{2C61}', '\u{2C60}'), ('\u{2C65}', '\u{23A}'), ('\u{2C66}', '\u{23E}'),
    ('\u{2C68}', '\u{2C67}'), ('\u{2C6A}', '\u{2C69}'), ('\u{2C6C}', '\u{2C6B}'), ('\u{2C73}', '\u{2C72}'),
    ('\u{2C76}', '\u{2C75}'), ('\u{2C81}', '\u{2C80}'), ('\u{2C83}', '\u{2C82}'), ('\u{2C85}', '\u{2C84}'),
    ('\u{2C87}', '\u{2C86}'), ('\u{2C89}', '\u{2C88}'), ('\u{2C8B}', '\u{2C8A}'), ('\u{2C8D}', '\u{2C8C}'),
    ('\u{2C8F}', '\u{2C8E}'), ('\u{2C91}', '\u{2C90}'), ('\u{2C93}', '\u{2C92}'), ('\u{2C95}', '\u{2C94}'),
    ('\u{2C97}', '\u{2C96}'), ('\u{2C99}', '\u{2C98}'), ('\u{2C9B}', '\u{2C9A}'), ('\u{2C9D}', '\u{2C9C}'),
    ('\u{2C9F}', '\u{2C9E}'), ('\u{2CA1}', '\u{2CA0}'), ('\u{2CA3}', '\u{2CA2}'), ('\u{2CA5}', '\u{2CA4}'),
    ('\u{2CA7}', '\u{2CA6}'), ('\u{2CA9}', '\u{2CA8}'), ('\u{2CAB}', '\u{2CAA}'), ('\u{2CAD}', '\u{2CAC}'),
    ('\u{2CAF}', '\u{2CAE}'), ('\u{2CB1}', '\u{2CB0}'), ('\u{2CB3}', '\u{2CB2}'), ('\u{2CB5}', '\u{2CB4}'),
    ('\u{2CB7}', '\u{2CB6}'), ('\u{2CB9}', '\u{2CB8}'), ('\u{2CBB}', '\u{2CBA}'), ('\u{2CBD}', '\u{2CBC}'),
    ('\u{2CBF}', '\u{2CBE}'), ('\u{2CC1}', '\u{2CC0}'), ('\u{2CC3}', '\u{2CC2}'), ('\u{2CC5}', '\u{2CC4}'),
    ('\u{2CC7}', '\u{2CC6}'), ('\u{2CC9}', '\u{2CC8}'), ('\u{2CCB}', '\u{2CCA}'), ('\u{2CCD}', '\u{2CCC}'),
    ('\u{2CCF}', '\u{2CCE}'), ('\u{2CD1}', '\u{2CD0}'), ('\u{2CD3}', '\u{2CD2}'), ('\u{2CD5}', '\u{2CD4}'),
    ('\u{2CD7}', '\u{2CD6}'), ('\u{2CD9}', '\u{2CD8}'), ('\u{2CDB}', '\u{2CDA}'), ('\u{2CDD}', '\u{2CDC}'),
    ('\u{2CDF}', '\u{2CDE}'), ('\u{2CE1}', '\u{2CE0}'), ('\u{2CE3}', '\u{2CE2}'), ('\u{2CEC}', '\u{2CEB}'),
    ('\u{2CEE}', '\u{2CED}'), ('\u{2CF3}', '\u{2CF2}'), ('\u{2D00}', '\u{10A0}'), ('\u{2D01}', '\u{10A1}'),
    ('\u{2D02}', '\u{10A2}'), ('\u{2D03}', '\u{10A3}'), ('\u{2D04}', '\u{10A4}'), ('\u{2D05}', '\u{10A5}'),
    ('\u{2D06}', '\u{10A6}'), ('\u{2D07}', '\u{10A7}'), ('\u{2D08}', '\u{10A8}'), ('\u{2D09}', '\u{10A9}'),
    ('\u{2D0A}', '\u{10AA}'), ('\u{2D0B}', '\u{10AB}'), ('\u{2D0C}', '\u{10AC}'), ('\u{2D0D}', '\u{10AD}'),
    ('\u{2D0E}', '\u{10AE}'), ('\u{2D0F}', '\u{10AF}'), ('\u{2D10}', '\u{10B0}'), ('\u{2D11}', '\u{10B1}'),
    ('\u{2D12}', '\u{10B2}'), ('\u{2D13}', '\u{10B3}'), ('\u{2D14}', '\u{10B4}'), ('\u{2D15}', '\u{10B5}'),
    ('\u{2D16}', '\u{10B6}'), ('\u{2D17}', '\u{10B7}'), ('\u{2D18}', '\u{10B8}'), ('\u{2D19}', '\u{10B9}'),
    ('\u{2D1A}', '\u{10BA}'), ('\u{2D1B}', '\u{10BB}'), ('\u{2D1C}', '\u{10BC}'), ('\u{2D1D}', '\u{10BD}'),
    ('\u{2D1E}', '\u{10BE}'), ('\u{2D1F}', '\u{10BF}'), ('\u{2D20}', '\u{10C0}'), ('\u{2D21}', '\u{10C1}'),
    ('\u{2D22}', '\u{10C2}'), ('\u{2D23}', '\u{10C3}'), ('\u{2D24}', '\u{10C4}'), ('\u{2D25}', '\u{10C5}'),
    ('\u{2D27}', '\u{10C7}'), ('\u{2D2D}', '\u{10CD}'), ('\u{A641}', '\u{A640}'), ('\u{A643}', '\u{A642}'),
    ('\u{A645}', '\u{A644}'), ('\u{A647}', '\u{A646}'), ('\u{A649}', '\u{A648}'), ('\u{A64B}', '\u{A64A}'),
    ('\u{A64D}', '\u{A64C}'), ('\u{A64F}', '\u{A64E}'), ('\u{A651}', '\u{A650}'), ('\u{A653}', '\u{A652}'),
    ('\u{A655}', '\u{A654}'), ('\u{A657}', '\u{A656}'), ('\u{A659}', '\u{A658}'), ('\u{A65B}', '\u{A65A}'),
    ('\u{A65D}', '\u{A65C}'), ('\u{A65F}', '\u{A65E}'), ('\u{A661}', '\u{A660}'), ('\u{A663}', '\u{A662}'),
    ('\u{A665}', '\u{A664}'), ('\u{A667}', '\u{A666}'), ('\u{A669}', '\u{A668}'), ('\u{A66B}', '\u{A66A}'),
    ('\u{A66D}', '\u{A66C}'), ('\u{A681}', '\u{A680}'), ('\u{A683}', '\u{A682}'), ('\u{A685}', '\u{A684}'),
    ('\u{A687}', '\u{A686}'), ('\u{A689}', '\u{A688}'), ('\u{A68B}', '\u{A68A}'), ('\u{A68D}', '\u{A68C}'),
    ('\u{A68F}', '\u{A68E}'), ('\u{A691}', '\u{A690}'), ('\u{A693}', '\u{A692}'), ('\u{A695}', '\u{A694}'),
    ('\u{A697}', '\u{A696}'), ('\u{A699}', '\u{A698}'), ('\u{A69B}', '\u{A69A}'), ('\u{A723}', '\u{A722}'),
    ('\u{A725}', '\u{A724}'), ('\u{A727}', '\u{A726}'), ('\u{A729}', '\u{A728}'), ('\u{A72B}', '\u{A72A}'),
    ('\u{A72D}', '\u{A72C}'), ('\u{A72F}', '\u{A72E}'), ('\u{A733}', '\u{A732}'), ('\u{A735}', '\u{A734}'),
    ('\u{A737}', '\u{A736}'), ('\u{A739}', '\u{A738}'), ('\u{A73B}', '\u{A73A}'), ('\u{A73D}', '\u{A73C}'),
    ('\u{A73F}', '\u{A73E}'), ('\u{A741}', '\u{A740}'), ('\u{A743}', '\u{A742}'), ('\u{A745}', '\u{A744}'),
    ('\u{A747}', '\u{A746}'), ('\u{A749}', '\u{A748}'), ('\u{A74B}', '\u{A74A}'), ('\u{A74D}', '\u{A74C}'),
    ('\u{A74F}', '\u{A74E}'), ('\u{A751}', '\u{A750}'), ('\u{A753}', '\u{A752}'), ('\u{A755}', '\u{A754}'),
    ('\u{A757}', '\u{A756}'), ('\u{A759}', '\u{A758}'), ('\u{A75B}', '\u{A75A}'), ('\u{A75D}', '\u{A75C}'),
    ('\u{A75F}', '\u{A75E}'), ('\u{A761}', '\u{A760}'), ('\u{A763}', '\u{A762}'), ('\u{A765}', '\u{A764}'),
    ('\u{A767}', '\u{A766}'), ('\u{A769}', '\u{A768}'), ('\u{A76B}', '\u{A76A}'), ('\u{A76D}', '\u{A76C}'),
    ('\u{A76F}', '\u{A76E}'), ('\u{A77A}', '\u{A779}'), ('\u{A77C}', '\u{A77B}'), ('\u{A77F}', '\u{A77E}'),
    ('\u{A781}', '\u{A780}'), ('\u{A783}', '\u{A782}'), ('\u{A785}', '\u{A784}'), ('\u{A787}', '\u{A786}'),
    ('\u{A78C}', '\u{A78B}'), ('\u{A791}', '\u{A790}'), ('\u{A793}', '\u{A792}'), ('\u{A794}', '\u{A7C4}'),
    ('\u{A797}', '\u{A796}'), ('\u{A799}', '\u{A798}'), ('\u{A79B}', '\u{A79A}'), ('\u{A79D}', '\u{A79C}'),
    ('\u{A79F}', '\u{A79E}'), ('\u{A7A1}', '\u{A7A0}'), ('\u{A7A3}', '\u{A7A2}'), ('\u{A7A5}', '\u{A7A4}'),
    ('\u{A7A7}', '\u{A7A6}'), ('\u{A7A9}', '\u{A7A8}'), ('\u{A7B5}', '\u{A7B4}'), ('\u{A7B7}', '\u{A7B6}'),
    ('\u{A7B9}', '\u{A7B8}'), ('\u{A7BB}', '\u{A7BA}'), ('\u{A7BD}', '\u{A7BC}'), ('\u{A7BF}', '\u{A7BE}'),
    ('\u{A7C1}', '\u{A7C0}'), ('\u{A7C3}', '\u{A7C2}'), ('\u{A7C8}', '\u{A7C7}'), ('\u{A7CA}', '\u{A7C9}'),
    ('\u{A7CD}', '\u{A7CC}'), ('\u{A7D1}', '\u{A7D0}'), ('\u{A7D7}', '\u{A7D6}'), ('\u{A7D9}', '\u{A7D8}'),
    ('\u{A7DB}', '\u{A7DA}'), ('\u{A7F6}', '\u{A7F5}'), ('\u{AB53}', '\u{A7B3}'), ('\u{FF41}', '\u{FF21}'),
    ('\u{FF42}', '\u{FF22}'), ('\u{FF43}', '\u{FF23}'), ('\u{FF44}', '\u{FF24}'), ('\u{FF45}', '\u{FF25}'),
    ('\u{FF46}', '\u{FF26}'), ('\u{FF47}', '\u{FF27}'), ('\u{FF48}', '\u{FF28}'), ('\u{FF49}', '\u{FF29}'),
    ('\u{FF4A}', '\u{FF2A}'), ('\u{FF4B}', '\u{FF2B}'), ('\u{FF4C}', '\u{FF2C}'), ('\u{FF4D}', '\u{FF2D}'),
    ('\u{FF4E}', '\u{FF2E}'), ('\u{FF4F}', '\u{FF2F}'), ('\u{FF50}', '\u{FF30}'), ('\u{FF51}', '\u{FF31}'),
    ('\u{FF52}', '\u{FF32}'), ('\u{FF53}', '\u{FF33}'), ('\u{FF54}', '\u{FF34}'), ('\u{FF55}', '\u{FF35}'),
    ('\u{FF56}', '\u{FF36}'), ('\u{FF57}', '\u{FF37}'), ('\u{FF58}', '\u{FF38}'), ('\u{FF59}', '\u{FF39}'),
    ('\u{FF5A}', '\u{FF3A}'),
];

#[cfg(test)]
mod tests {
    use super::*;

    /// The pairs the live probe settled, each as Excel answered it. A rule that
    /// gets any of these wrong either refuses a name Excel accepts or lets two
    /// sheets share a name Excel would not.
    #[test]
    fn the_measured_pairs_follow_excel() {
        let same: [(&str, &str, &str); 14] = [
            ("\u{c4}rende", "\u{e4}rende", "A-umlaut by case"),
            ("Sheet1", "SHEET1", "ASCII by case"),
            ("\u{df}", "\u{1e9e}", "sharp s and capital sharp s"),
            ("\u{3c2}", "\u{3a3}", "final sigma and capital sigma"),
            ("\u{3c2}", "\u{3c3}", "final sigma and sigma"),
            ("\u{1c4}", "\u{1c5}", "DZ caron and its titlecase"),
            ("\u{1c5}", "\u{1c6}", "Dz caron titlecase and lowercase"),
            ("\u{ff21}", "\u{ff41}", "full-width A by case"),
            ("\u{212a}", "k", "Kelvin sign and k"),
            ("\u{212a}", "K", "Kelvin sign and K"),
            ("\u{2126}", "\u{3c9}", "Ohm sign and omega"),
            ("\u{2160}", "\u{2170}", "Roman numeral one by case"),
            ("\u{24b6}", "\u{24d0}", "circled A by case"),
            ("\u{10a0}", "\u{2d00}", "Georgian Asomtavruli and Nuskhuri"),
        ];
        for (a, b, what) in same {
            assert!(sheet_names_equal(a, b), "{what}: Excel refuses {a:?} beside {b:?}");
            assert_eq!(sheet_name_key(a), sheet_name_key(b), "{what}: keys differ");
        }
        let different: [(&str, &str, &str); 16] = [
            ("Stra\u{df}e", "STRASSE", "no expansion of sharp s"),
            ("Stra\u{df}e", "strasse", "no expansion of sharp s"),
            ("i", "\u{130}", "no Turkish dotted capital I"),
            ("\u{131}", "I", "no Turkish dotless i"),
            ("\u{b5}", "\u{3bc}", "micro sign is not mu"),
            ("s", "\u{17f}", "long s is not s"),
            ("\u{3d1}", "\u{3b8}", "theta symbol is not theta"),
            ("\u{345}", "\u{3b9}", "ypogegrammeni is not iota"),
            ("\u{212b}", "\u{e5}", "Angstrom sign is not a-ring"),
            ("\u{ff21}", "A", "full-width is not ASCII"),
            ("e\u{301}", "\u{e9}", "combining accent is not precomposed"),
            ("\u{13a0}", "\u{ab70}", "Cherokee small letters"),
            ("\u{10d0}", "\u{1c90}", "Georgian Mtavruli"),
            ("\u{10400}", "\u{10428}", "Deseret (supplementary plane)"),
            ("\u{c4}rende", "\u{c5}rende", "another letter is another name"),
            ("\u{e6}", "ae", "no ligature expansion"),
        ];
        for (a, b, what) in different {
            assert!(!sheet_names_equal(a, b), "{what}: Excel accepts {a:?} beside {b:?}");
            assert_ne!(sheet_name_key(a), sheet_name_key(b), "{what}: keys collide");
        }
    }

    /// `fold_sheet_name_char` binary-searches the table, which is only correct
    /// on a table sorted by its first column with no repeats.
    #[test]
    fn the_table_is_sorted_and_every_row_lands_on_a_fixed_point() {
        for pair in EXCEL_SHEET_NAME_CASE_TABLE.windows(2) {
            assert!(pair[0].0 < pair[1].0, "table not strictly sorted at {:?}", pair);
        }
        for (from, rep) in EXCEL_SHEET_NAME_CASE_TABLE.iter() {
            assert_ne!(from, rep, "a row maps {from:?} to itself");
            assert_eq!(fold_sheet_name_char(*from), *rep, "{from:?} does not fold to its row");
            assert_eq!(fold_sheet_name_char(*rep), *rep, "the representative {rep:?} folds on");
            assert!((*from as u32) < 0x10000 && (*rep as u32) < 0x10000, "a row leaves the BMP");
        }
        // ASCII is answered without the table; the table must agree with it.
        for c in 'a'..='z' {
            assert_eq!(fold_sheet_name_char(c), c.to_ascii_uppercase());
        }
    }

    #[test]
    fn a_key_keeps_the_length_and_ascii_keys_are_plain_uppercase() {
        assert_eq!(sheet_name_key("Sheet1"), "SHEET1");
        assert_eq!(sheet_name_key("Q1-2026 data"), "Q1-2026 DATA");
        assert_eq!(sheet_name_key("Stra\u{df}e").chars().count(), 6);
        assert_eq!(position_of_sheet_name(&["Data", "\u{c4}rende"], "\u{e4}RENDE"), Some(1));
        assert_eq!(position_of_sheet_name(&["Stra\u{df}e", "STRASSE"], "strasse"), Some(1));
        assert_eq!(position_of_sheet_name(&["Stra\u{df}e", "STRASSE"], "STRA\u{1e9e}E"), Some(0));
    }
}
