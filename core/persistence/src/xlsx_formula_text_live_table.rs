//! FILENAME: core/persistence/src/xlsx_formula_text_live_table.rs
//!
//! Round 20 (rev18x, five MAJORs CONFIRMED LIVE): the .xlsx export's formula
//! text, driven through the REAL path -- `engine::Cell::new_formula` (the text
//! Calcula stores), `SavedCell::from_cell`, `save_xlsx` -- against live
//! Excel 16's own file text for the same formula.
//!
//! Column 4 is Excel's `<f>` verbatim: each formula was typed (`Formula2`) into
//! a fresh Excel 16 instance's new workbook -- Sheet1 A1:C5 = 1..5 / 10..50 /
//! 100..500, Table1 on H1:H6 (`Col`), sheets Sheet2, `My Sheet`, `Översikt`;
//! set 3 also Table2 on L1:M200 (`P`, `Q`) -- in column J of the row given,
//! saved, and read back from the sheet XML. Sets 1 and 2 are rev18x's probes
//! (round 19), set 3 is xlsxmod's (round 20), sets 4-9 the round-20
//! verifier's, sets 10-11 lane xlsxfmt's probes (2026-11-04), set 13 lane
//! legacystats's compatibility functions (2026-11-05). The comparison ignores case
//! only: Calcula's stored text folds every identifier to upper case, Excel
//! keeps the user's spelling, and both name the same thing.
//!
//! Column 5, when not empty, is what Calcula writes where it deliberately
//! differs, each with its reason. Column 6 is whether the file reads back to
//! the formula Calcula stored: a bare `C` / `R` cannot, because Excel's file
//! holds the cell's own column or row in its place.
//!
//! Not here: what Excel refused to TYPE (`LET(b,2,SUM(B:$B)*b)`,
//! `LET(a,1,SUM(A:.A)+a)`, `LET(a,A1:A5,SUM(a:.a))`, `LET(if,..)`,
//! `LET(E5,2,$E$5+E5)`) -- the ones Excel cannot even open are in
//! `a_formula_excel_cannot_hold_keeps_its_value_and_is_reported` -- and what
//! Calcula's parser still holds no formula for (`SUM(Sheet2!C)`,
//! `R[1]C*0`, `SUM((A1:A3,B1:B3))`, `SUM(A1:A3:B2)`, `SUM(Seq(3)#)`).
//!
//! The live probe: with `CALCULA_XLSX_PROBE_DIR` set, the test leaves each
//! set's real export there (`calcula-set{n}.xlsx`) for Excel to open.

use crate::{SavedCell, SavedCellValue, Sheet, Workbook};
use std::io::Read;

/// (set, row of column J, the formula typed, Excel's own `<f>`, Calcula's
/// deliberate text or "", whether the file reads back to the stored formula).
const ROWS: &[(u8, u32, &str, &str, &str, bool)] = &[
    (1, 2, "LET(a,1,SUM(A:C)+a)", "_xlfn.LET(_xlpm.a,1,SUM(_xlpm.a:J:J)+_xlpm.a)", "", false),
    (1, 3, "LET(a,1,SUM(A:D)+a)", "_xlfn.LET(_xlpm.a,1,SUM(_xlpm.a:D)+_xlpm.a)", "", true),
    (1, 4, "LET(a,1,SUM(A:B)+a)", "_xlfn.LET(_xlpm.a,1,SUM(_xlpm.a:B)+_xlpm.a)", "", true),
    (1, 5, "LET(a,1,b,2,SUM(A:B)+a+b)", "_xlfn.LET(_xlpm.a,1,_xlpm.b,2,SUM(_xlpm.a:_xlpm.b)+_xlpm.a+_xlpm.b)", "", true),
    (1, 7, "LET(b,2,SUM(b:C)*b)", "_xlfn.LET(_xlpm.b,2,SUM(_xlpm.b:J:J)*_xlpm.b)", "", false),
    (1, 8, "LAMBDA(b,SUM(B:C)*b)(2)", "_xlfn.LAMBDA(_xlpm.b,SUM(_xlpm.b:J:J)*_xlpm.b)(2)", "", false),
    (1, 9, "LAMBDA(b,SUM(B:R)*b)(2)", "_xlfn.LAMBDA(_xlpm.b,SUM(_xlpm.b:9:9)*_xlpm.b)(2)", "", false),
    (1, 10, "LET(c,2,SUM(C:C)*c)", "_xlfn.LET(_xlpm.c,2,SUM(_xlpm.c:_xlpm.c)*_xlpm.c)", "", true),
    (1, 11, "LET(r,2,SUM(R:R)*r)", "_xlfn.LET(_xlpm.r,2,SUM(_xlpm.r:_xlpm.r)*_xlpm.r)", "", true),
    (1, 14, "LET(a,A1:A3,b,B1:B3,SUM(a:b))", "_xlfn.LET(_xlpm.a,A1:A3,_xlpm.b,B1:B3,SUM(_xlpm.a:_xlpm.b))", "", true),
    (1, 15, "LET(a,1,SUM(A1:.A5)+a)", "_xlfn.LET(_xlpm.a,1,SUM(_xlfn._TRO_TRAILING(A1:A5))+_xlpm.a)", "", true),
    (1, 16, "LET(a,1,SUM(A1.:A5)+a)", "_xlfn.LET(_xlpm.a,1,SUM(_xlfn._TRO_LEADING(A1:A5))+_xlpm.a)", "", true),
    (1, 19, "LET(sum,LAMBDA(x,x*2),sum(3))", "_xlfn.LET(_xlpm.sum,_xlfn.LAMBDA(_xlpm.x,_xlpm.x*2),SUM(3))", "", true),
    (1, 20, "LET(abs,LAMBDA(x,x+10),abs(5))", "_xlfn.LET(_xlpm.abs,_xlfn.LAMBDA(_xlpm.x,_xlpm.x+10),ABS(5))", "", true),
    (1, 21, "LET(max,LAMBDA(x,y,x*y),max(3,4))", "_xlfn.LET(_xlpm.max,_xlfn.LAMBDA(_xlpm.x,_xlpm.y,_xlpm.x*_xlpm.y),MAX(3,4))", "", true),
    (1, 23, "LAMBDA(sum,sum(4))(LAMBDA(x,x*5))", "_xlfn.LAMBDA(_xlpm.sum,SUM(4))(_xlfn.LAMBDA(_xlpm.x,_xlpm.x*5))", "", true),
    (1, 24, "LAMBDA(x,[y],IF(ISOMITTED(y),x,x+y))(1)", "_xlfn.LAMBDA(_xlpm.x,_xlop.y,IF(_xlfn.ISOMITTED(_xlpm.y),_xlpm.x,_xlpm.x+_xlpm.y))(1)", "", true),
    (1, 25, "LAMBDA(x,[y],IF(ISOMITTED(y),x,x+y))(1,2)", "_xlfn.LAMBDA(_xlpm.x,_xlop.y,IF(_xlfn.ISOMITTED(_xlpm.y),_xlpm.x,_xlpm.x+_xlpm.y))(1,2)", "", true),
    (1, 26, "LET(a,A1:A3,SUM(@a))", "_xlfn.LET(_xlpm.a,A1:A3,SUM(_xlfn.SINGLE(_xlpm.a)))", "", true),
    (1, 27, "LET(a,1,SUM(A1#)+a)", "_xlfn.LET(_xlpm.a,1,SUM(_xlfn.ANCHORARRAY(A1))+_xlpm.a)", "", true),
    (1, 29, "LET(x,1,'My Sheet'!A1+x)", "_xlfn.LET(_xlpm.x,1,'My Sheet'!A1+_xlpm.x)", "", true),
    (1, 30, "LET(My,1,'My Sheet'!A1+My)", "_xlfn.LET(_xlpm.My,1,'My Sheet'!A1+_xlpm.My)", "", true),
    (1, 31, "LET(Sheet,1,'My Sheet'!B2+Sheet)", "_xlfn.LET(_xlpm.Sheet,1,'My Sheet'!B2+_xlpm.Sheet)", "", true),
    (1, 32, "LET(a,1,Sheet2!A1+a)", "_xlfn.LET(_xlpm.a,1,Sheet2!A1+_xlpm.a)", "", true),
    (1, 33, "LET(A1x,1,Sheet2!A1+A1x)", "_xlfn.LET(_xlpm.A1x,1,Sheet2!A1+_xlpm.A1x)", "", true),
    (1, 34, "LET(sheet2,1,Sheet2!A1+sheet2)", "_xlfn.LET(_xlpm.sheet2,1,Sheet2!A1+_xlpm.sheet2)", "", true),
    (1, 35, "LET(Ö,1,ö+Ö)", "_xlfn.LET(_xlpm.Ö,1,_xlpm.Ö+_xlpm.Ö)", "", true),
    (1, 36, "LET(ö,2,Översikt!A1*Ö)", "_xlfn.LET(_xlpm.ö,2,Översikt!A1*_xlpm.ö)", "", true),
    (1, 37, "LET(versikt,2,Översikt!A1*versikt)", "_xlfn.LET(_xlpm.versikt,2,Översikt!A1*_xlpm.versikt)", "", true),
    (1, 38, "LET(straße,2,straße+STRASSE)", "_xlfn.LET(_xlpm.straße,2,_xlpm.straße+STRASSE)", "", true),
    (1, 39, "LET(a1048577,2,a1048577+1)", "_xlfn.LET(_xlpm.a1048577,2,_xlpm.a1048577+1)", "", true),
    (1, 40, "LET(xfe1,2,xfe1+1)", "_xlfn.LET(_xlpm.xfe1,2,_xlpm.xfe1+1)", "", true),
    (1, 41, "LET(a0,2,a0+1)", "_xlfn.LET(_xlpm.a0,2,_xlpm.a0+1)", "", true),
    (1, 42, "LET(xfd,2,SUM(XFD:XFD)+xfd)", "_xlfn.LET(_xlpm.xfd,2,SUM(_xlpm.xfd:_xlpm.xfd)+_xlpm.xfd)", "", true),
    (1, 43, "LET(xfe,2,xfe+1)", "_xlfn.LET(_xlpm.xfe,2,_xlpm.xfe+1)", "", true),
    (1, 44, "LET(e,2,1E+2+e)", "_xlfn.LET(_xlpm.e,2,100+_xlpm.e)", "", true),
    (1, 45, "LET(e,2,1.5e3*e)", "_xlfn.LET(_xlpm.e,2,1500*_xlpm.e)", "", true),
    (1, 46, "LET(e,2,e+.5E1)", "_xlfn.LET(_xlpm.e,2,_xlpm.e+5)", "", true),
    (1, 47, "LET(E5,2,E5+1)", "_xlfn.LET(_xlpm.E5,2,_xlpm.E5+1)", "", true),
    (1, 48, "LET(x,\"a,b(\",LEN(x))", "_xlfn.LET(_xlpm.x,\"a,b(\",LEN(_xlpm.x))", "", true),
    (1, 49, "LET(x,\"LET(x,1,x)\",x)", "_xlfn.LET(_xlpm.x,\"LET(x,1,x)\",_xlpm.x)", "", true),
    (1, 50, "LET(x,\"\"\"x\"\"\",x&\"x\")", "_xlfn.LET(_xlpm.x,\"\"\"x\"\"\",_xlpm.x&\"x\")", "", true),
    (1, 51, "LET(x,\"'x'\",x&'My Sheet'!A1)", "_xlfn.LET(_xlpm.x,\"'x'\",_xlpm.x&'My Sheet'!A1)", "", true),
    (1, 52, "LET(x,{1,2;3,4},SUM(x)+x)", "_xlfn.LET(_xlpm.x,{1,2;3,4},SUM(_xlpm.x)+_xlpm.x)", "", true),
    (1, 53, "LET(x,{1,\"x\";TRUE,#N/A},COUNTA(x))", "_xlfn.LET(_xlpm.x,{1,\"x\";TRUE,#N/A},COUNTA(_xlpm.x))", "", true),
    (1, 54, "LET(x,{\"a,b\",\"x\"},INDEX(x,1,2))", "_xlfn.LET(_xlpm.x,{\"a,b\",\"x\"},INDEX(_xlpm.x,1,2))", "", true),
    (1, 55, "LET(x,1,LET(X,2,x+X))", "_xlfn.LET(_xlpm.x,1,_xlfn.LET(_xlpm.X,2,_xlpm.X+_xlpm.X))", "", true),
    (1, 56, "LET(x,1,y,LET(x,10,x+1),x+y)", "_xlfn.LET(_xlpm.x,1,_xlpm.y,_xlfn.LET(_xlpm.x,10,_xlpm.x+1),_xlpm.x+_xlpm.y)", "", true),
    (1, 57, "LET(x,1,LAMBDA(x,LAMBDA(x,x)(x+1))(x+1)+x)", "_xlfn.LET(_xlpm.x,1,_xlfn.LAMBDA(_xlpm.x,_xlfn.LAMBDA(_xlpm.x,_xlpm.x)(_xlpm.x+1))(_xlpm.x+1)+_xlpm.x)", "", true),
    (1, 58, "LET(f,LAMBDA(x,x+1),g,LAMBDA(x,f(x)*2),g(1))", "_xlfn.LET(_xlpm.f,_xlfn.LAMBDA(_xlpm.x,_xlpm.x+1),_xlpm.g,_xlfn.LAMBDA(_xlpm.x,_xlpm.f(_xlpm.x)*2),_xlpm.g(1))", "", true),
    (1, 59, "MAP(A1:A3,LAMBDA(a,a*A1))", "_xlfn.MAP(A1:A3,_xlfn.LAMBDA(_xlpm.a,_xlpm.a*A1))", "", true),
    (1, 60, "REDUCE(0,A1:A3,LAMBDA(acc,v,acc+v))", "_xlfn.REDUCE(0,A1:A3,_xlfn.LAMBDA(_xlpm.acc,_xlpm.v,_xlpm.acc+_xlpm.v))", "", true),
    (1, 61, "SCAN(0,A1:A3,LAMBDA(acc,v,acc+v))", "_xlfn.SCAN(0,A1:A3,_xlfn.LAMBDA(_xlpm.acc,_xlpm.v,_xlpm.acc+_xlpm.v))", "", true),
    (1, 62, "BYROW(A1:C2,LAMBDA(row,SUM(row)))", "_xlfn.BYROW(A1:C2,_xlfn.LAMBDA(_xlpm.row,SUM(_xlpm.row)))", "", true),
    (1, 63, "BYCOL(A1:C2,LAMBDA(col,SUM(col)))", "_xlfn.BYCOL(A1:C2,_xlfn.LAMBDA(_xlpm.col,SUM(_xlpm.col)))", "", true),
    (1, 64, "MAKEARRAY(2,2,LAMBDA(r,c,r*c))", "_xlfn.MAKEARRAY(2,2,_xlfn.LAMBDA(_xlpm.r,_xlpm.c,_xlpm.r*_xlpm.c))", "", true),
    (1, 65, "LET(a,A1:C1,b,A1:A5,SUM(a b))", "_xlfn.LET(_xlpm.a,A1:C1,_xlpm.b,A1:A5,SUM(_xlpm.a _xlpm.b))", "", true),
    (1, 66, "LET(a,A1:C1,SUM(a A1:A5))", "_xlfn.LET(_xlpm.a,A1:C1,SUM(_xlpm.a A1:A5))", "", true),
    (1, 67, "LET(a,A1:C1,SUM(A1:A5 a))", "_xlfn.LET(_xlpm.a,A1:C1,SUM(A1:A5 _xlpm.a))", "", true),
    (1, 68, "LET(t,true,IF(t,1,0))", "_xlfn.LET(_xlpm.t,TRUE,IF(_xlpm.t,1,0))", "", true),
    (1, 69, "LET(true1,1,true1+1)", "_xlfn.LET(_xlpm.true1,1,_xlpm.true1+1)", "", true),
    (1, 70, "LET(f,1,IFERROR(f/0,#DIV/0!)&f)", "_xlfn.LET(_xlpm.f,1,IFERROR(_xlpm.f/0,#DIV/0!)&_xlpm.f)", "", true),
    (1, 71, "LET(n,1,IFNA(#n/a,n))", "_xlfn.LET(_xlpm.n,1,_xlfn.IFNA(#N/A,_xlpm.n))", "", true),
    (1, 72, "LET(Col,1,SUM(Table1[[#All],[Col]])+Col)", "_xlfn.LET(_xlpm.Col,1,SUM(Table1[[#All],[Col]])+_xlpm.Col)", "", true),
    (1, 74, "LET(All,1,ROWS(Table1[#All])+All)", "_xlfn.LET(_xlpm.All,1,ROWS(Table1[#All])+_xlpm.All)", "", true),
    (1, 75, "LET(Data,1,ROWS(Table1[#Data])+Data)", "_xlfn.LET(_xlpm.Data,1,ROWS(Table1[#Data])+_xlpm.Data)", "", true),
    (1, 76, "LET(Table1,1,ROWS(Table1)+Table1)", "_xlfn.LET(_xlpm.Table1,1,ROWS(_xlpm.Table1)+_xlpm.Table1)", "", true),
    (1, 77, "LET(x,1,x+ROWS(Table1[Col]))", "_xlfn.LET(_xlpm.x,1,_xlpm.x+ROWS(Table1[Col]))", "", true),
    (1, 78, "LET(_xlpm,1,_xlpm+1)", "_xlfn.LET(_xlpm._xlpm,1,_xlpm._xlpm+1)", "", true),
    (1, 79, "LET(xlpm,1,xlpm+1)", "_xlfn.LET(_xlpm.xlpm,1,_xlpm.xlpm+1)", "", true),
    (1, 80, "LET(_xlfn,1,_xlfn+1)", "_xlfn.LET(_xlpm._xlfn,1,_xlpm._xlfn+1)", "", true),
    (1, 81, "LET(x_1,1,x_1+1)", "_xlfn.LET(_xlpm.x_1,1,_xlpm.x_1+1)", "", true),
    (1, 82, "LET(\\a,1,\\a+1)", "_xlfn.LET(_xlpm.\\a,1,_xlpm.\\a+1)", "", true),
    (1, 83, "LET(LET,1,LET+1)", "_xlfn.LET(_xlpm.LET,1,_xlpm.LET+1)", "", true),
    (1, 84, "LET(lambda,1,lambda+1)", "_xlfn.LET(_xlpm.lambda,1,_xlpm.lambda+1)", "", true),
    (1, 85, "LET(f,1,f+SUM(f,f))", "_xlfn.LET(_xlpm.f,1,_xlpm.f+SUM(_xlpm.f,_xlpm.f))", "", true),
    (1, 86, "LET(sum2,1,sum2+1)", "_xlfn.LET(_xlpm.sum2,1,_xlpm.sum2+1)", "", true),
    (1, 87, "LET(log10,1,log10+1)", "_xlfn.LET(_xlpm.log10,1,_xlpm.log10+1)", "", true),
    (1, 88, "LET(x,2,x^2&x%)", "_xlfn.LET(_xlpm.x,2,_xlpm.x^2&_xlpm.x%)", "", true),
    (1, 89, "LET(x,2,-x)", "_xlfn.LET(_xlpm.x,2,-_xlpm.x)", "", true),
    (1, 90, "LET(a,1,b,2,a<>b)", "_xlfn.LET(_xlpm.a,1,_xlpm.b,2,_xlpm.a<>_xlpm.b)", "", true),
    (1, 91, "LET(a,1,SUM(Sheet1!A:A)+a)", "_xlfn.LET(_xlpm.a,1,SUM(Sheet1!A:A)+_xlpm.a)", "", true),
    (1, 93, "LET(a,1,SUM(Sheet1:Sheet2!A1)+a)", "_xlfn.LET(_xlpm.a,1,SUM(Sheet1:Sheet2!A1)+_xlpm.a)", "", true),
    (1, 94, "LET(b,1,SUM(Sheet1!$A:B)+b)", "_xlfn.LET(_xlpm.b,1,SUM(Sheet1!$A:B)+_xlpm.b)", "", true),
    (1, 95, "LET(a,1,SUM(1:1)+a)", "_xlfn.LET(_xlpm.a,1,SUM(1:1)+_xlpm.a)", "", true),
    (1, 96, "LET(a,1,SUM($1:1)+a)", "_xlfn.LET(_xlpm.a,1,SUM($1:1)+_xlpm.a)", "", true),
    (1, 97, "LET(a,A2,ROW(a))", "_xlfn.LET(_xlpm.a,A2,ROW(_xlpm.a))", "", true),
    (1, 98, "LET(a,1, a + 1 )", "_xlfn.LET(_xlpm.a,1, _xlpm.a + 1 )", "_xlfn.LET(_xlpm.a,1,_xlpm.a+1)", true), // the engine stores no spaces
    (1, 99, "LET( a , 1 , a )", "_xlfn.LET( _xlpm.a, 1, _xlpm.a )", "_xlfn.LET(_xlpm.a,1,_xlpm.a)", true), // the engine stores no spaces
    (1, 100, "IF(TRUE,LET(a,1,a),0)", "IF(TRUE,_xlfn.LET(_xlpm.a,1,_xlpm.a),0)", "", true),
    (1, 101, "LET(a,1,a)+LET(a,2,a)", "_xlfn.LET(_xlpm.a,1,_xlpm.a)+_xlfn.LET(_xlpm.a,2,_xlpm.a)", "", true),
    (1, 102, "LAMBDA(x,x)(LET(x,3,x))", "_xlfn.LAMBDA(_xlpm.x,_xlpm.x)(_xlfn.LET(_xlpm.x,3,_xlpm.x))", "", true),
    (1, 103, "LET(x,1,LAMBDA(y,x)(2)+LAMBDA(x,x)(5))", "_xlfn.LET(_xlpm.x,1,_xlfn.LAMBDA(_xlpm.y,_xlpm.x)(2)+_xlfn.LAMBDA(_xlpm.x,_xlpm.x)(5))", "", true),
    (1, 104, "LET(a,1,SUM(A1:A3, a))", "_xlfn.LET(_xlpm.a,1,SUM(A1:A3, _xlpm.a))", "_xlfn.LET(_xlpm.a,1,SUM(A1:A3,_xlpm.a))", true), // the engine stores no spaces
    (1, 105, "LET(a,1,IF(A1=a,\"A1\",\"a\"))", "_xlfn.LET(_xlpm.a,1,IF(A1=_xlpm.a,\"A1\",\"a\"))", "", true),
    (2, 2, "SUM(A1#)", "SUM(_xlfn.ANCHORARRAY(A1))", "", true),
    (2, 3, "SUM(A1:.A5)", "SUM(_xlfn._TRO_TRAILING(A1:A5))", "", true),
    (2, 4, "LAMBDA(x,x+1)(2)", "_xlfn.LAMBDA(_xlpm.x,_xlpm.x+1)(2)", "", true),
    (2, 5, "LET(a,1,a+C)", "_xlfn.LET(_xlpm.a,1,_xlpm.a+J:J)", "", false),
    (2, 6, "LET(a,1,SUM(A:c))", "_xlfn.LET(_xlpm.a,1,SUM(_xlpm.a:J:J))", "", false),
    (2, 7, "LET(ab,1,SUM(AB:C)+ab)", "_xlfn.LET(_xlpm.ab,1,SUM(_xlpm.ab:J:J)+_xlpm.ab)", "", false),
    (2, 8, "LET(a,1,c,2,SUM(A:C)+a+c)", "_xlfn.LET(_xlpm.a,1,_xlpm.c,2,SUM(_xlpm.a:_xlpm.c)+_xlpm.a+_xlpm.c)", "", true),
    (2, 9, "LET(a,1,SUM(A:R)+a)", "_xlfn.LET(_xlpm.a,1,SUM(_xlpm.a:9:9)+_xlpm.a)", "", false),
    (2, 10, "LET(A1,5,A1+1)", "_xlfn.LET(_xlpm.A1,5,_xlpm.A1+1)", "", true),
    (2, 12, "LET(E5,2,SUM(E5:E6))", "_xlfn.LET(_xlpm.E5,2,SUM(_xlpm.E5:_xlnm.E6))", "", true),
    (2, 13, "LAMBDA(E5,E5*2)(3)", "_xlfn.LAMBDA(_xlpm.E5,_xlpm.E5*2)(3)", "", true),
    (2, 14, "LET(f,LAMBDA(E5,E5*2),f(3))", "_xlfn.LET(_xlpm.f,_xlfn.LAMBDA(_xlpm.E5,_xlpm.E5*2),_xlpm.f(3))", "", true),
    (2, 15, "LET(AB12,1,AB12+1)", "_xlfn.LET(_xlpm.AB12,1,_xlpm.AB12+1)", "", true),
    (2, 16, "LET(xfd1048576,1,xfd1048576+1)", "_xlfn.LET(_xlpm.xfd1048576,1,_xlpm.xfd1048576+1)", "", true),
    (2, 17, "LET(f,LAMBDA(x,[y],IF(ISOMITTED(y),x,x+y)),f(1)+f(1,2))", "_xlfn.LET(_xlpm.f,_xlfn.LAMBDA(_xlpm.x,_xlop.y,IF(_xlfn.ISOMITTED(_xlpm.y),_xlpm.x,_xlpm.x+_xlpm.y)),_xlpm.f(1)+_xlpm.f(1,2))", "", true),
    (2, 18, "LET(f,LAMBDA([y],IF(ISOMITTED(y),0,y)),f()+f(5))", "_xlfn.LET(_xlpm.f,_xlfn.LAMBDA(_xlop.y,IF(_xlfn.ISOMITTED(_xlpm.y),0,_xlpm.y)),_xlpm.f()+_xlpm.f(5))", "", true),
    (3, 2, "LET(E5,2,SUM(E4:E5))", "_xlfn.LET(_xlpm.E5,2,SUM(_xlnm.E4:_xlpm.E5))", "", true),
    (3, 3, "LET(E5,2,SUM(F5:E5)+E5)", "_xlfn.LET(_xlpm.E5,2,SUM(_xlnm.F5:_xlpm.E5)+_xlpm.E5)", "", true),
    (3, 4, "LET(A1,1,SUM(A1:A3))", "_xlfn.LET(_xlpm.A1,1,SUM(_xlpm.A1:_xlnm.A3))", "", true),
    (3, 5, "LET(E5,2,E6,3,SUM(E5:E6))", "_xlfn.LET(_xlpm.E5,2,_xlpm.E6,3,SUM(_xlpm.E5:_xlpm.E6))", "", true),
    (3, 6, "LET(a1,1,a1+1)", "_xlfn.LET(_xlpm.a1,1,_xlpm.a1+1)", "", true),
    (3, 7, "LET(a,1,SUM(@A1:A3)+a)", "_xlfn.LET(_xlpm.a,1,SUM(_xlfn.SINGLE(A1:A3))+_xlpm.a)", "", true),
    (3, 8, "@A1:A3", "A1:A3", "_xlfn.SINGLE(A1:A3)", true), // Excel drops an @ a legacy formula implies; SINGLE means the same
    (3, 9, "SUM(@A1:A3)", "SUM(_xlfn.SINGLE(A1:A3))", "", true),
    (3, 10, "LET(a,A1:A3,@a+1)", "_xlfn.LET(_xlpm.a,A1:A3,_xlpm.a+1)", "_xlfn.LET(_xlpm.a,A1:A3,_xlfn.SINGLE(_xlpm.a)+1)", true), // Excel drops an @ a legacy formula implies; SINGLE means the same
    (3, 11, "LET(x,1,@INDEX(A1:A3,x))", "_xlfn.LET(_xlpm.x,1,_xlfn.SINGLE(INDEX(A1:A3,_xlpm.x)))", "", true),
    (3, 12, "LET(a,1,a+R)", "_xlfn.LET(_xlpm.a,1,_xlpm.a+12:12)", "", false),
    (3, 13, "C+1", "J:J+1", "", false),
    (3, 14, "SUM(R)", "SUM(14:14)", "", false),
    (3, 15, "Table1[@Col]+1", "Table1[[#This Row],[Col]]+1", "", true),
    (3, 16, "Table2[@P]+Table2[@[Q]]", "Table2[[#This Row],[P]]+Table2[[#This Row],[Q]]", "", true),
    (3, 17, "SUM(Table2[@[P]:[Q]])", "SUM(Table2[[#This Row],[P]:[Q]])", "", true),
    (3, 18, "SUM(Sheet1!A1:.A5)", "SUM(_xlfn._TRO_TRAILING(Sheet1!A1:A5))", "", true),
    (3, 19, "SUM(A1.:.A5)", "SUM(_xlfn._TRO_ALL(A1:A5))", "", true),
    (3, 20, "SUM(Sheet1!A1#)", "SUM(_xlfn.ANCHORARRAY(Sheet1!A1))", "", true),
    (3, 21, "SUM(A1:.C5)", "SUM(_xlfn._TRO_TRAILING(A1:C5))", "", true),
    (3, 22, "LET(f,LAMBDA(x,[y],[z],x+IF(ISOMITTED(z),0,z)),f(1)+f(1,2,3))", "_xlfn.LET(_xlpm.f,_xlfn.LAMBDA(_xlpm.x,_xlop.y,_xlop.z,_xlpm.x+IF(_xlfn.ISOMITTED(_xlpm.z),0,_xlpm.z)),_xlpm.f(1)+_xlpm.f(1,2,3))", "", true),
    (3, 23, "LAMBDA([y],IF(ISOMITTED(y),0,y))()", "_xlfn.LAMBDA(_xlop.y,IF(_xlfn.ISOMITTED(_xlpm.y),0,_xlpm.y))()", "", true),
    (3, 24, "SUM('My Sheet'!A1:.B2)", "SUM(_xlfn._TRO_TRAILING('My Sheet'!A1:B2))", "", true),
    (3, 25, "LET(x,1,x+LAMBDA(y,y*2)(3))", "_xlfn.LET(_xlpm.x,1,_xlpm.x+_xlfn.LAMBDA(_xlpm.y,_xlpm.y*2)(3))", "", true),
    (3, 26, "ROWS(Table2[#This Row])", "ROWS(Table2[#This Row])", "", true),
    (3, 27, "LET(E5,2,E5:E6)", "_xlfn.LET(_xlpm.E5,2,_xlpm.E5:_xlnm.E6)", "", true),
    (3, 28, "LET(a,1,SUM(A:C)*COLUMN(C))", "_xlfn.LET(_xlpm.a,1,SUM(_xlpm.a:J:J)*COLUMN(J:J))", "", false),
    // Sets 4-6: the round-20 verifier's probes of pass 1 (n2, n3, n4), each
    // in the row Excel saw it in. Defined names Dbl, Opt and Rate as below
    // (`workbook_of`); Table2 on L1:O200 (`My Col`, `a'b`, `x#y`, `Q[1]`).
    (4, 19, "LET(if,LAMBDA(x,x*3),if(2,3))", "_xlfn.LET(_xlpm.if,_xlfn.LAMBDA(_xlpm.x,_xlpm.x*3),IF(2,3))", "", true),
    (4, 23, "LET(E5,E5+1,E5)", "_xlfn.LET(_xlpm.E5,_xlnm.E5+1,_xlpm.E5)", "", true),
    (4, 24, "LET(A1,A1*10,A1)", "_xlfn.LET(_xlpm.A1,_xlnm.A1*10,_xlpm.A1)", "", true),
    (4, 25, "LET(A1,SUM(A1:A3),A1)", "_xlfn.LET(_xlpm.A1,SUM(_xlnm.A1:_xlnm.A3),_xlpm.A1)", "", true),
    (4, 26, "LAMBDA(A1,A1*2)(A1+1)", "_xlfn.LAMBDA(_xlpm.A1,_xlpm.A1*2)(_xlnm.A1+1)", "", true),
    (4, 27, "LET(x,1,A1,x+A1,A1)", "_xlfn.LET(_xlpm.x,1,_xlpm.A1,_xlpm.x+_xlnm.A1,_xlpm.A1)", "", true),
    (4, 28, "LET(B1,A1,A1,B1*2,A1+B1)", "_xlfn.LET(_xlpm.B1,_xlnm.A1,_xlpm.A1,_xlpm.B1*2,_xlpm.A1+_xlpm.B1)", "", true),
    (4, 29, "RC*0", "J29*0", "", false),
    (4, 30, "R1C1*0", "$A$1*0", "", false),
    (4, 31, "SUM(1:.3)", "SUM(_xlfn._TRO_TRAILING(1:3))", "", true),
    (4, 33, "SUM(A:.C)", "SUM(_xlfn._TRO_TRAILING(A:C))", "", true),
    (4, 34, "LET(a,1,SUM(1:.3)+a)", "_xlfn.LET(_xlpm.a,1,SUM(_xlfn._TRO_TRAILING(1:3))+_xlpm.a)", "", true),
    (4, 35, "SUM($A$1:.$A$5)", "SUM(_xlfn._TRO_TRAILING($A$1:$A$5))", "", true),
    (4, 36, "SUM(A$1:.A$5)", "SUM(_xlfn._TRO_TRAILING(A$1:A$5))", "", true),
    (4, 37, "SUM($A$1#)", "SUM(_xlfn.ANCHORARRAY($A$1))", "", true),
    (4, 38, "SUM(Sheet1!$A$1#)", "SUM(_xlfn.ANCHORARRAY(Sheet1!$A$1))", "", true),
    (4, 39, "SUM( C )", "SUM( J:J )", "SUM(J:J)", false), // the engine stores no spaces
    (4, 40, "(C)*0", "(J:J)*0", "J:J*0", false), // the engine stores no redundant parentheses
    (4, 42, "LET(c,1,SUM(R:c)+c)", "_xlfn.LET(_xlpm.c,1,SUM(C:R)+_xlpm.c)", "_xlfn.LET(_xlpm.c,1,SUM(R:C)+_xlpm.c)", true), // Excel orders the halves; the same columns
    (4, 43, "LET(x,2,SUM(A1:.C3 B1:B5)*x)", "_xlfn.LET(_xlpm.x,2,SUM(_xlfn._TRO_TRAILING(A1:C3) B1:B5)*_xlpm.x)", "", true),
    (4, 45, "SUM(Table2[@[My Col]])", "SUM(Table2[[#This Row],[My Col]])", "", true),
    (4, 46, "SUM(Table2[@[a''b]])", "SUM(Table2[[#This Row],[a''b]])", "", true),
    (4, 47, "SUM(Table2[@[x'#y]])", "SUM(Table2[[#This Row],[x'#y]])", "", true),
    (4, 48, "SUM(Table2[@[Q'[1']]])", "SUM(Table2[[#This Row],[Q'[1']]])", "", true),
    (4, 49, "SUM(Table2[@[My Col]:[x'#y]])", "SUM(Table2[[#This Row],[My Col]:[x'#y]])", "", true),
    (4, 53, "SUM(Table2[[#This Row],[My Col]])", "SUM(Table2[[#This Row],[My Col]])", "", true),
    (4, 54, "SUM(Table2[My Col])", "SUM(Table2[My Col])", "", true),
    (4, 55, "SUM(Table2[[#Headers],[My Col]])", "SUM(Table2[[#Headers],[My Col]])", "", true),
    (4, 66, "LAMBDA([C],[R],N(C)+N(R))()", "_xlfn.LAMBDA(_xlop.C,_xlop.R,N(_xlpm.C)+N(_xlpm.R))()", "", true),
    (4, 67, "LET(XFD1048576,1,SUM(XFD1048575:XFD1048576)+XFD1048576)", "_xlfn.LET(_xlpm.XFD1048576,1,SUM(_xlnm.XFD1048575:_xlpm.XFD1048576)+_xlpm.XFD1048576)", "", true),
    (5, 2, "SUM(Table2[x'#y])", "SUM(Table2[x'#y])", "", true),
    (5, 3, "SUM(Table2[[#This Row],[x'#y]])", "SUM(Table2[[#This Row],[x'#y]])", "", true),
    (5, 4, "SUM(Table2[[#All],[x'#y]])", "SUM(Table2[[#All],[x'#y]])", "", true),
    (5, 5, "LET(x,1,SUM(Table2[@[x'#y]])+x)", "_xlfn.LET(_xlpm.x,1,SUM(Table2[[#This Row],[x'#y]])+_xlpm.x)", "", true),
    (5, 6, "SUM(C:.E)", "SUM(_xlfn._TRO_TRAILING(C:E))", "", true),
    (5, 7, "SUM(A.:C)", "SUM(_xlfn._TRO_LEADING(A:C))", "", true),
    (5, 8, "SUM(A.:.C)", "SUM(_xlfn._TRO_ALL(A:C))", "", true),
    (5, 10, "SUM(B:.R)", "SUM(_xlfn._TRO_TRAILING(B:R))", "", true),
    (5, 11, "SUM(C.:C)", "SUM(_xlfn._TRO_LEADING(C:C))", "", true),
    (5, 13, "RC[-1]*0", "I13*0", "", false),
    (5, 14, "R2C*0", "J$2*0", "", false),
    (5, 15, "R1C*0", "J$1*0", "", false),
    (5, 16, "RC1*0", "RC1*0", "", true),
    (5, 17, "LET(a,a+1,a)", "_xlfn.LET(_xlpm.a,a+1,_xlpm.a)", "", true),
    (5, 18, "LET(x,1,y,y+x,y)", "_xlfn.LET(_xlpm.x,1,_xlpm.y,y+_xlpm.x,_xlpm.y)", "", true),
    (5, 20, "SUM(Sheet1!1:.3)", "SUM(_xlfn._TRO_TRAILING(Sheet1!1:3))", "", true),
    (5, 21, "SUM(A1:.C3)", "SUM(_xlfn._TRO_TRAILING(A1:C3))", "", true),
    (6, 2, "LET(Rate,Rate*2,Rate)", "_xlfn.LET(_xlpm.Rate,Rate*2,_xlpm.Rate)", "", true),
    (6, 3, "LET(Dbl,Dbl(3),Dbl)", "_xlfn.LET(_xlpm.Dbl,Dbl(3),_xlpm.Dbl)", "", true),
    (6, 4, "LET(x,Rate,Rate,x*3,Rate)", "_xlfn.LET(_xlpm.x,Rate,_xlpm.Rate,_xlpm.x*3,_xlpm.Rate)", "", true),
    (6, 5, "LET(Rate,1,Rate)+Rate", "_xlfn.LET(_xlpm.Rate,1,_xlpm.Rate)+Rate", "", true),
    (6, 6, "LAMBDA(Rate,Rate*2)(Rate)", "_xlfn.LAMBDA(_xlpm.Rate,_xlpm.Rate*2)(Rate)", "", true),
    (6, 7, "LET(f,LAMBDA(Dbl,Dbl+1),f(Dbl(2)))", "_xlfn.LET(_xlpm.f,_xlfn.LAMBDA(_xlpm.Dbl,_xlpm.Dbl+1),_xlpm.f(Dbl(2)))", "", true),
    (6, 8, "LET(Opt,Opt(1,2),Opt*10)", "_xlfn.LET(_xlpm.Opt,Opt(1,2),_xlpm.Opt*10)", "", true),
    // Sets 7-9 and 12: the round-20 verifier's pass 2 (rev18x pass2 batches B,
    // C, D and A), and sets 10-11 lane xlsxfmt's probes 1-2 (2026-11-04), each
    // in the row Excel saw it in: every row Excel typed and Calcula holds a
    // formula for -- since the parser lane's round of 2026-11-04 also a range
    // whose end corner names its own sheet (`Sheet1!A1:Sheet1!A3`; Excel quotes
    // that sheet, `'Sheet1'!A3`, and opened Calcula's unquoted text to the same
    // 7), a LET name's range to a cell (`_xlpm.a:C3`), a name's spill
    // (`ANCHORARRAY(_xlpm.a)`), a span of two table references, a second
    // special item (`[[#Headers],[#Data]]`, `[[#Headers],[#Data],[x'#y]]`) and
    // a row range's leading trim (`_TRO_LEADING(1:3)`, `_TRO_ALL(2:3)`).
    // Excel also had Table3 on Q1:S10 (`'#n`, `a b#c`, `z'#`) and the names
    // Pick / CellP / Seq; neither changes a text here. Column 5 is Calcula's
    // where it deliberately differs: an `@` Excel's legacy formula leaves
    // implied is SINGLE (as in set 3), and `TRIMRANGE(A1:C9,2,2)` is held as
    // the trim reference `A1:.C9` (the same range; Excel gives 1665 for both).
    // A row that does not read back holds R1C1's column or row, or a named
    // LAMBDA call, which the reader leaves unresolved (the app resolves it).
    (12, 7, "LET(a,1,SUM(A:C)+a)", "_xlfn.LET(_xlpm.a,1,SUM(_xlpm.a:J:J)+_xlpm.a)", "", true),
    (12, 8, "LET(a,1,SUM(A:D)+a)", "_xlfn.LET(_xlpm.a,1,SUM(_xlpm.a:D)+_xlpm.a)", "", true),
    (12, 9, "LET(a,1,SUM(A:B)+a)", "_xlfn.LET(_xlpm.a,1,SUM(_xlpm.a:B)+_xlpm.a)", "", true),
    (12, 10, "LET(a,1,b,2,SUM(A:B)+a+b)", "_xlfn.LET(_xlpm.a,1,_xlpm.b,2,SUM(_xlpm.a:_xlpm.b)+_xlpm.a+_xlpm.b)", "", true),
    (12, 12, "LET(b,2,SUM(b:C)*b)", "_xlfn.LET(_xlpm.b,2,SUM(_xlpm.b:J:J)*_xlpm.b)", "", true),
    (12, 13, "LAMBDA(b,SUM(B:C)*b)(2)", "_xlfn.LAMBDA(_xlpm.b,SUM(_xlpm.b:J:J)*_xlpm.b)(2)", "", true),
    (12, 14, "LAMBDA(b,SUM(B:R)*b)(2)", "_xlfn.LAMBDA(_xlpm.b,SUM(_xlpm.b:14:14)*_xlpm.b)(2)", "", true),
    (12, 15, "LET(c,2,SUM(C:C)*c)", "_xlfn.LET(_xlpm.c,2,SUM(_xlpm.c:_xlpm.c)*_xlpm.c)", "", true),
    (12, 16, "LET(r,2,SUM(R:R)*r)", "_xlfn.LET(_xlpm.r,2,SUM(_xlpm.r:_xlpm.r)*_xlpm.r)", "", true),
    (12, 17, "LET(a,B2,SUM(a:C3))", "_xlfn.LET(_xlpm.a,B2,SUM(_xlpm.a:C3))", "", true),
    (12, 18, "LET(b,A3,SUM(A1:b))", "_xlfn.LET(_xlpm.b,A3,SUM(A1:_xlpm.b))", "", true),
    (12, 19, "LET(a,A1:A3,b,B1:B3,SUM(a:b))", "_xlfn.LET(_xlpm.a,A1:A3,_xlpm.b,B1:B3,SUM(_xlpm.a:_xlpm.b))", "", true),
    (12, 20, "LET(a,1,SUM(A1:.A5)+a)", "_xlfn.LET(_xlpm.a,1,SUM(_xlfn._TRO_TRAILING(A1:A5))+_xlpm.a)", "", true),
    (12, 21, "LET(a,1,SUM(A1.:A5)+a)", "_xlfn.LET(_xlpm.a,1,SUM(_xlfn._TRO_LEADING(A1:A5))+_xlpm.a)", "", true),
    (12, 24, "LET(sum,LAMBDA(x,x*2),sum(3))", "_xlfn.LET(_xlpm.sum,_xlfn.LAMBDA(_xlpm.x,_xlpm.x*2),SUM(3))", "", true),
    (12, 25, "LET(abs,LAMBDA(x,x+10),abs(5))", "_xlfn.LET(_xlpm.abs,_xlfn.LAMBDA(_xlpm.x,_xlpm.x+10),ABS(5))", "", true),
    (12, 26, "LET(max,LAMBDA(x,y,x*y),max(3,4))", "_xlfn.LET(_xlpm.max,_xlfn.LAMBDA(_xlpm.x,_xlpm.y,_xlpm.x*_xlpm.y),MAX(3,4))", "", true),
    (12, 28, "LAMBDA(sum,sum(4))(LAMBDA(x,x*5))", "_xlfn.LAMBDA(_xlpm.sum,SUM(4))(_xlfn.LAMBDA(_xlpm.x,_xlpm.x*5))", "", true),
    (12, 29, "LAMBDA(x,[y],IF(ISOMITTED(y),x,x+y))(1)", "_xlfn.LAMBDA(_xlpm.x,_xlop.y,IF(_xlfn.ISOMITTED(_xlpm.y),_xlpm.x,_xlpm.x+_xlpm.y))(1)", "", true),
    (12, 30, "LAMBDA(x,[y],IF(ISOMITTED(y),x,x+y))(1,2)", "_xlfn.LAMBDA(_xlpm.x,_xlop.y,IF(_xlfn.ISOMITTED(_xlpm.y),_xlpm.x,_xlpm.x+_xlpm.y))(1,2)", "", true),
    (12, 31, "LET(a,A1:A3,SUM(@a))", "_xlfn.LET(_xlpm.a,A1:A3,SUM(_xlfn.SINGLE(_xlpm.a)))", "", true),
    (12, 32, "LET(a,1,SUM(A1#)+a)", "_xlfn.LET(_xlpm.a,1,SUM(_xlfn.ANCHORARRAY(A1))+_xlpm.a)", "", true),
    (12, 33, "LET(a,SEQUENCE(3),SUM(a#))", "_xlfn.LET(_xlpm.a,_xlfn.SEQUENCE(3),SUM(_xlfn.ANCHORARRAY(_xlpm.a)))", "", true),
    (12, 34, "LET(x,1,'My Sheet'!A1+x)", "_xlfn.LET(_xlpm.x,1,'My Sheet'!A1+_xlpm.x)", "", true),
    (12, 35, "LET(My,1,'My Sheet'!A1+My)", "_xlfn.LET(_xlpm.My,1,'My Sheet'!A1+_xlpm.My)", "", true),
    (12, 36, "LET(Sheet,1,'My Sheet'!B2+Sheet)", "_xlfn.LET(_xlpm.Sheet,1,'My Sheet'!B2+_xlpm.Sheet)", "", true),
    (12, 37, "LET(a,1,Sheet2!A1+a)", "_xlfn.LET(_xlpm.a,1,Sheet2!A1+_xlpm.a)", "", true),
    (12, 38, "LET(A1x,1,Sheet2!A1+A1x)", "_xlfn.LET(_xlpm.A1x,1,Sheet2!A1+_xlpm.A1x)", "", true),
    (12, 39, "LET(sheet2,1,Sheet2!A1+sheet2)", "_xlfn.LET(_xlpm.sheet2,1,Sheet2!A1+_xlpm.sheet2)", "", true),
    (12, 40, "LET(Ö,1,Ö+Ö)", "_xlfn.LET(_xlpm.Ö,1,_xlpm.Ö+_xlpm.Ö)", "", true),
    (12, 41, "LET(Ö,2,Översikt!A1*Ö)", "_xlfn.LET(_xlpm.Ö,2,Översikt!A1*_xlpm.Ö)", "", true),
    (12, 42, "LET(versikt,2,Översikt!A1*versikt)", "_xlfn.LET(_xlpm.versikt,2,Översikt!A1*_xlpm.versikt)", "", true),
    (12, 43, "LET(straße,2,straße+STRASSE)", "_xlfn.LET(_xlpm.straße,2,_xlpm.straße+STRASSE)", "", true),
    (12, 44, "LET(a1048577,2,a1048577+1)", "_xlfn.LET(_xlpm.a1048577,2,_xlpm.a1048577+1)", "", true),
    (12, 45, "LET(xfe1,2,xfe1+1)", "_xlfn.LET(_xlpm.xfe1,2,_xlpm.xfe1+1)", "", true),
    (12, 46, "LET(a0,2,a0+1)", "_xlfn.LET(_xlpm.a0,2,_xlpm.a0+1)", "", true),
    (12, 47, "LET(xfd,2,SUM(XFD:XFD)+xfd)", "_xlfn.LET(_xlpm.xfd,2,SUM(_xlpm.xfd:_xlpm.xfd)+_xlpm.xfd)", "", true),
    (12, 48, "LET(xfe,2,xfe+1)", "_xlfn.LET(_xlpm.xfe,2,_xlpm.xfe+1)", "", true),
    (12, 49, "LET(e,2,1E+2+e)", "_xlfn.LET(_xlpm.e,2,100+_xlpm.e)", "", true),
    (12, 50, "LET(e,2,1.5e3*e)", "_xlfn.LET(_xlpm.e,2,1500*_xlpm.e)", "", true),
    (12, 51, "LET(e,2,e+.5E1)", "_xlfn.LET(_xlpm.e,2,_xlpm.e+5)", "", true),
    (12, 52, "LET(E5,2,E5+1)", "_xlfn.LET(_xlpm.E5,2,_xlpm.E5+1)", "", true),
    (12, 53, "LET(x,\"a,b(\",LEN(x))", "_xlfn.LET(_xlpm.x,\"a,b(\",LEN(_xlpm.x))", "", true),
    (12, 54, "LET(x,\"LET(x,1,x)\",x)", "_xlfn.LET(_xlpm.x,\"LET(x,1,x)\",_xlpm.x)", "", true),
    (12, 55, "LET(x,\"\"\"x\"\"\",x&\"x\")", "_xlfn.LET(_xlpm.x,\"\"\"x\"\"\",_xlpm.x&\"x\")", "", true),
    (12, 56, "LET(x,\"'x'\",x&'My Sheet'!A1)", "_xlfn.LET(_xlpm.x,\"'x'\",_xlpm.x&'My Sheet'!A1)", "", true),
    (12, 57, "LET(x,{1,2;3,4},SUM(x)+x)", "_xlfn.LET(_xlpm.x,{1,2;3,4},SUM(_xlpm.x)+_xlpm.x)", "", true),
    (12, 58, "LET(x,{1,\"x\";TRUE,#N/A},COUNTA(x))", "_xlfn.LET(_xlpm.x,{1,\"x\";TRUE,#N/A},COUNTA(_xlpm.x))", "", true),
    (12, 59, "LET(x,{\"a,b\",\"x\"},INDEX(x,1,2))", "_xlfn.LET(_xlpm.x,{\"a,b\",\"x\"},INDEX(_xlpm.x,1,2))", "", true),
    (12, 60, "LET(x,1,LET(X,2,x+X))", "_xlfn.LET(_xlpm.x,1,_xlfn.LET(_xlpm.X,2,_xlpm.X+_xlpm.X))", "", true),
    (12, 61, "LET(x,1,y,LET(x,10,x+1),x+y)", "_xlfn.LET(_xlpm.x,1,_xlpm.y,_xlfn.LET(_xlpm.x,10,_xlpm.x+1),_xlpm.x+_xlpm.y)", "", true),
    (12, 62, "LET(x,1,LAMBDA(x,LAMBDA(x,x)(x+1))(x+1)+x)", "_xlfn.LET(_xlpm.x,1,_xlfn.LAMBDA(_xlpm.x,_xlfn.LAMBDA(_xlpm.x,_xlpm.x)(_xlpm.x+1))(_xlpm.x+1)+_xlpm.x)", "", true),
    (12, 63, "LET(f,LAMBDA(x,x+1),g,LAMBDA(x,f(x)*2),g(1))", "_xlfn.LET(_xlpm.f,_xlfn.LAMBDA(_xlpm.x,_xlpm.x+1),_xlpm.g,_xlfn.LAMBDA(_xlpm.x,_xlpm.f(_xlpm.x)*2),_xlpm.g(1))", "", true),
    (12, 64, "MAP(A1:A3,LAMBDA(a,a*A1))", "_xlfn.MAP(A1:A3,_xlfn.LAMBDA(_xlpm.a,_xlpm.a*A1))", "", true),
    (12, 65, "REDUCE(0,A1:A3,LAMBDA(acc,v,acc+v))", "_xlfn.REDUCE(0,A1:A3,_xlfn.LAMBDA(_xlpm.acc,_xlpm.v,_xlpm.acc+_xlpm.v))", "", true),
    (12, 66, "SCAN(0,A1:A3,LAMBDA(acc,v,acc+v))", "_xlfn.SCAN(0,A1:A3,_xlfn.LAMBDA(_xlpm.acc,_xlpm.v,_xlpm.acc+_xlpm.v))", "", true),
    (12, 67, "BYROW(A1:C2,LAMBDA(row,SUM(row)))", "_xlfn.BYROW(A1:C2,_xlfn.LAMBDA(_xlpm.row,SUM(_xlpm.row)))", "", true),
    (12, 68, "BYCOL(A1:C2,LAMBDA(col,SUM(col)))", "_xlfn.BYCOL(A1:C2,_xlfn.LAMBDA(_xlpm.col,SUM(_xlpm.col)))", "", true),
    (12, 69, "MAKEARRAY(2,2,LAMBDA(r,c,r*c))", "_xlfn.MAKEARRAY(2,2,_xlfn.LAMBDA(_xlpm.r,_xlpm.c,_xlpm.r*_xlpm.c))", "", true),
    (12, 70, "LET(a,A1:C1,b,A1:A5,SUM(a b))", "_xlfn.LET(_xlpm.a,A1:C1,_xlpm.b,A1:A5,SUM(_xlpm.a _xlpm.b))", "", true),
    (12, 71, "LET(a,A1:C1,SUM(a A1:A5))", "_xlfn.LET(_xlpm.a,A1:C1,SUM(_xlpm.a A1:A5))", "", true),
    (12, 72, "LET(a,A1:C1,SUM(A1:A5 a))", "_xlfn.LET(_xlpm.a,A1:C1,SUM(A1:A5 _xlpm.a))", "", true),
    (12, 73, "LET(t,true,IF(t,1,0))", "_xlfn.LET(_xlpm.t,TRUE,IF(_xlpm.t,1,0))", "", true),
    (12, 74, "LET(true1,1,true1+1)", "_xlfn.LET(_xlpm.true1,1,_xlpm.true1+1)", "", true),
    (12, 75, "LET(f,1,IFERROR(f/0,#DIV/0!)&f)", "_xlfn.LET(_xlpm.f,1,IFERROR(_xlpm.f/0,#DIV/0!)&_xlpm.f)", "", true),
    (12, 76, "LET(n,1,IFNA(#n/a,n))", "_xlfn.LET(_xlpm.n,1,_xlfn.IFNA(#N/A,_xlpm.n))", "", true),
    (12, 77, "LET(Col,1,SUM(Table1[[#All],[Col]])+Col)", "_xlfn.LET(_xlpm.Col,1,SUM(Table1[[#All],[Col]])+_xlpm.Col)", "", true),
    (12, 78, "LET(Col,1,SUM(Table1[Col]:Table1[Col])+Col)", "_xlfn.LET(_xlpm.Col,1,SUM(Table1[Col]:Table1[Col])+_xlpm.Col)", "", true),
    (12, 79, "LET(All,1,ROWS(Table1[#All])+All)", "_xlfn.LET(_xlpm.All,1,ROWS(Table1[#All])+_xlpm.All)", "", true),
    (12, 80, "LET(Data,1,ROWS(Table1[#Data])+Data)", "_xlfn.LET(_xlpm.Data,1,ROWS(Table1[#Data])+_xlpm.Data)", "", true),
    (12, 81, "LET(Table1,1,ROWS(Table1)+Table1)", "_xlfn.LET(_xlpm.Table1,1,ROWS(_xlpm.Table1)+_xlpm.Table1)", "", true),
    (12, 82, "LET(x,1,x+ROWS(Table1[Col]))", "_xlfn.LET(_xlpm.x,1,_xlpm.x+ROWS(Table1[Col]))", "", true),
    (12, 83, "LET(_xlpm,1,_xlpm+1)", "_xlfn.LET(_xlpm._xlpm,1,_xlpm._xlpm+1)", "", true),
    (12, 84, "LET(xlpm,1,xlpm+1)", "_xlfn.LET(_xlpm.xlpm,1,_xlpm.xlpm+1)", "", true),
    (12, 85, "LET(_xlfn,1,_xlfn+1)", "_xlfn.LET(_xlpm._xlfn,1,_xlpm._xlfn+1)", "", true),
    (12, 86, "LET(x_1,1,x_1+1)", "_xlfn.LET(_xlpm.x_1,1,_xlpm.x_1+1)", "", true),
    (12, 87, "LET(\\a,1,\\a+1)", "_xlfn.LET(_xlpm.\\a,1,_xlpm.\\a+1)", "", true),
    (12, 88, "LET(LET,1,LET+1)", "_xlfn.LET(_xlpm.LET,1,_xlpm.LET+1)", "", true),
    (12, 89, "LET(lambda,1,lambda+1)", "_xlfn.LET(_xlpm.lambda,1,_xlpm.lambda+1)", "", true),
    (12, 90, "LET(f,1,f+SUM(f,f))", "_xlfn.LET(_xlpm.f,1,_xlpm.f+SUM(_xlpm.f,_xlpm.f))", "", true),
    (12, 91, "LET(sum2,1,sum2+1)", "_xlfn.LET(_xlpm.sum2,1,_xlpm.sum2+1)", "", true),
    (12, 92, "LET(log10,1,log10+1)", "_xlfn.LET(_xlpm.log10,1,_xlpm.log10+1)", "", true),
    (12, 93, "LET(x,2,x^2&x%)", "_xlfn.LET(_xlpm.x,2,_xlpm.x^2&_xlpm.x%)", "", true),
    (12, 94, "LET(x,2,-x)", "_xlfn.LET(_xlpm.x,2,-_xlpm.x)", "", true),
    (12, 95, "LET(a,1,b,2,a<>b)", "_xlfn.LET(_xlpm.a,1,_xlpm.b,2,_xlpm.a<>_xlpm.b)", "", true),
    (12, 96, "LET(a,1,SUM(Sheet1!A:A)+a)", "_xlfn.LET(_xlpm.a,1,SUM(Sheet1!A:A)+_xlpm.a)", "", true),
    (12, 97, "LET(a,1,SUM(Sheet1!A1:Sheet1!A3)+a)", "_xlfn.LET(_xlpm.a,1,SUM(Sheet1!A1:'Sheet1'!A3)+_xlpm.a)", "_xlfn.LET(_xlpm.a,1,SUM(SHEET1!A1:SHEET1!A3)+_xlpm.a)", true),
    (12, 98, "LET(a,1,SUM(Sheet1:Sheet2!A1)+a)", "_xlfn.LET(_xlpm.a,1,SUM(Sheet1:Sheet2!A1)+_xlpm.a)", "", true),
    (12, 99, "LET(b,1,SUM(Sheet1!$A:B)+b)", "_xlfn.LET(_xlpm.b,1,SUM(Sheet1!$A:B)+_xlpm.b)", "", true),
    (12, 100, "LET(a,1,SUM(1:1)+a)", "_xlfn.LET(_xlpm.a,1,SUM(1:1)+_xlpm.a)", "", true),
    (12, 101, "LET(a,1,SUM($1:1)+a)", "_xlfn.LET(_xlpm.a,1,SUM($1:1)+_xlpm.a)", "", true),
    (12, 102, "LET(a,A2,ROW(a))", "_xlfn.LET(_xlpm.a,A2,ROW(_xlpm.a))", "", true),
    (12, 103, "LET(a,1, a + 1 )", "_xlfn.LET(_xlpm.a,1, _xlpm.a + 1 )", "_xlfn.LET(_xlpm.a,1,_xlpm.a+1)", true),
    (12, 104, "LET( a , 1 , a )", "_xlfn.LET( _xlpm.a, 1, _xlpm.a )", "_xlfn.LET(_xlpm.a,1,_xlpm.a)", true),
    (12, 105, "IF(TRUE,LET(a,1,a),0)", "IF(TRUE,_xlfn.LET(_xlpm.a,1,_xlpm.a),0)", "", true),
    (12, 106, "LET(a,1,a)+LET(a,2,a)", "_xlfn.LET(_xlpm.a,1,_xlpm.a)+_xlfn.LET(_xlpm.a,2,_xlpm.a)", "", true),
    (12, 107, "LAMBDA(x,x)(LET(x,3,x))", "_xlfn.LAMBDA(_xlpm.x,_xlpm.x)(_xlfn.LET(_xlpm.x,3,_xlpm.x))", "", true),
    (12, 108, "LET(x,1,LAMBDA(y,x)(2)+LAMBDA(x,x)(5))", "_xlfn.LET(_xlpm.x,1,_xlfn.LAMBDA(_xlpm.y,_xlpm.x)(2)+_xlfn.LAMBDA(_xlpm.x,_xlpm.x)(5))", "", true),
    (12, 109, "LET(a,1,SUM(A1:A3, a))", "_xlfn.LET(_xlpm.a,1,SUM(A1:A3, _xlpm.a))", "_xlfn.LET(_xlpm.a,1,SUM(A1:A3,_xlpm.a))", true),
    (12, 110, "LET(a,1,IF(A1=a,\"A1\",\"a\"))", "_xlfn.LET(_xlpm.a,1,IF(A1=_xlpm.a,\"A1\",\"a\"))", "", true),
    (12, 111, "SUM(A1#)", "SUM(_xlfn.ANCHORARRAY(A1))", "", true),
    (12, 112, "SUM(A1:.A5)", "SUM(_xlfn._TRO_TRAILING(A1:A5))", "", true),
    (12, 113, "LAMBDA(x,x+1)(2)", "_xlfn.LAMBDA(_xlpm.x,_xlpm.x+1)(2)", "", true),
    (12, 114, "LET(a,1,a+C)", "_xlfn.LET(_xlpm.a,1,_xlpm.a+J:J)", "", false),
    (12, 115, "LET(a,1,SUM(A:c))", "_xlfn.LET(_xlpm.a,1,SUM(_xlpm.a:J:J))", "", true),
    (12, 116, "LET(ab,1,SUM(AB:C)+ab)", "_xlfn.LET(_xlpm.ab,1,SUM(_xlpm.ab:J:J)+_xlpm.ab)", "", true),
    (12, 117, "LET(a,1,c,2,SUM(A:C)+a+c)", "_xlfn.LET(_xlpm.a,1,_xlpm.c,2,SUM(_xlpm.a:_xlpm.c)+_xlpm.a+_xlpm.c)", "", true),
    (12, 118, "LET(a,1,SUM(A:R)+a)", "_xlfn.LET(_xlpm.a,1,SUM(_xlpm.a:118:118)+_xlpm.a)", "", true),
    (12, 119, "LET(A1,5,A1+1)", "_xlfn.LET(_xlpm.A1,5,_xlpm.A1+1)", "", true),
    (12, 121, "LET(E5,2,SUM(E5:E6))", "_xlfn.LET(_xlpm.E5,2,SUM(_xlpm.E5:_xlnm.E6))", "", true),
    (12, 122, "LAMBDA(E5,E5*2)(3)", "_xlfn.LAMBDA(_xlpm.E5,_xlpm.E5*2)(3)", "", true),
    (12, 123, "LET(f,LAMBDA(E5,E5*2),f(3))", "_xlfn.LET(_xlpm.f,_xlfn.LAMBDA(_xlpm.E5,_xlpm.E5*2),_xlpm.f(3))", "", true),
    (12, 124, "LET(AB12,1,AB12+1)", "_xlfn.LET(_xlpm.AB12,1,_xlpm.AB12+1)", "", true),
    (12, 125, "LET(xfd1048576,1,xfd1048576+1)", "_xlfn.LET(_xlpm.xfd1048576,1,_xlpm.xfd1048576+1)", "", true),
    (12, 126, "LET(f,LAMBDA(x,[y],IF(ISOMITTED(y),x,x+y)),f(1)+f(1,2))", "_xlfn.LET(_xlpm.f,_xlfn.LAMBDA(_xlpm.x,_xlop.y,IF(_xlfn.ISOMITTED(_xlpm.y),_xlpm.x,_xlpm.x+_xlpm.y)),_xlpm.f(1)+_xlpm.f(1,2))", "", true),
    (12, 127, "LET(f,LAMBDA([y],IF(ISOMITTED(y),0,y)),f()+f(5))", "_xlfn.LET(_xlpm.f,_xlfn.LAMBDA(_xlop.y,IF(_xlfn.ISOMITTED(_xlpm.y),0,_xlpm.y)),_xlpm.f()+_xlpm.f(5))", "", true),
    (12, 128, "LAMBDA(E5,[A1],IF(ISOMITTED(A1),E5,E5+A1))(1,2)", "_xlfn.LAMBDA(_xlpm.E5,_xlop.A1,IF(_xlfn.ISOMITTED(_xlpm.A1),_xlpm.E5,_xlpm.E5+_xlpm.A1))(1,2)", "", true),
    (12, 129, "LAMBDA(E5,[A1],IF(ISOMITTED(A1),E5,E5+A1))(1)", "_xlfn.LAMBDA(_xlpm.E5,_xlop.A1,IF(_xlfn.ISOMITTED(_xlpm.A1),_xlpm.E5,_xlpm.E5+_xlpm.A1))(1)", "", true),
    (12, 130, "LAMBDA([A1],IF(ISOMITTED(A1),0,A1))()", "_xlfn.LAMBDA(_xlop.A1,IF(_xlfn.ISOMITTED(_xlpm.A1),0,_xlpm.A1))()", "", true),
    (12, 131, "LAMBDA([A1],[B2],IF(ISOMITTED(B2),A1,A1+B2))(1,2)", "_xlfn.LAMBDA(_xlop.A1,_xlop.B2,IF(_xlfn.ISOMITTED(_xlpm.B2),_xlpm.A1,_xlpm.A1+_xlpm.B2))(1,2)", "", true),
    (12, 132, "LAMBDA(x,[C],IF(ISOMITTED(C),x,x+C))(1,2)", "_xlfn.LAMBDA(_xlpm.x,_xlop.C,IF(_xlfn.ISOMITTED(_xlpm.C),_xlpm.x,_xlpm.x+_xlpm.C))(1,2)", "", true),
    (12, 133, "LAMBDA([R],IF(ISOMITTED(R),5,R))()", "_xlfn.LAMBDA(_xlop.R,IF(_xlfn.ISOMITTED(_xlpm.R),5,_xlpm.R))()", "", true),
    (12, 134, "LAMBDA(x,[y],SUM(x:y))(A1,A3)", "_xlfn.LAMBDA(_xlpm.x,_xlop.y,SUM(_xlpm.x:_xlpm.y))(A1,A3)", "", true),
    (12, 135, "LAMBDA([E5],SUM(E5:E6))(A1)", "_xlfn.LAMBDA(_xlop.E5,SUM(_xlpm.E5:_xlnm.E6))(_xlnm.A1)", "", true),
    (12, 136, "LAMBDA([y],y)(LAMBDA([z],IF(ISOMITTED(z),7,z))())", "_xlfn.LAMBDA(_xlop.y,_xlpm.y)(_xlfn.LAMBDA(_xlop.z,IF(_xlfn.ISOMITTED(_xlpm.z),7,_xlpm.z))())", "", true),
    (12, 140, "LET(x,1,SUM(Sheet1!A1:.A5)+x)", "_xlfn.LET(_xlpm.x,1,SUM(_xlfn._TRO_TRAILING(Sheet1!A1:A5))+_xlpm.x)", "", true),
    (12, 141, "LET(x,1,SUM('My Sheet'!A1.:.B2)+x)", "_xlfn.LET(_xlpm.x,1,SUM(_xlfn._TRO_ALL('My Sheet'!A1:B2))+_xlpm.x)", "", true),
    (12, 142, "SUM(A1:.C5)+SUM(A1.:C5)", "SUM(_xlfn._TRO_TRAILING(A1:C5))+SUM(_xlfn._TRO_LEADING(A1:C5))", "", true),
    (12, 143, "LET(C,1,SUM(A1:.C5)+C)", "_xlfn.LET(_xlpm.C,1,SUM(_xlfn._TRO_TRAILING(A1:C5))+_xlpm.C)", "", true),
    (12, 145, "LAMBDA(x,SUM(A1#)+x)(1)", "_xlfn.LAMBDA(_xlpm.x,SUM(_xlfn.ANCHORARRAY(A1))+_xlpm.x)(1)", "", true),
    (12, 146, "LAMBDA(a,ROWS(a#))(A1)", "_xlfn.LAMBDA(_xlpm.a,ROWS(_xlfn.ANCHORARRAY(_xlpm.a)))(A1)", "", true),
    (12, 147, "MAP(A1:A3,LAMBDA(v,v+ROWS(A1#)))", "_xlfn.MAP(A1:A3,_xlfn.LAMBDA(_xlpm.v,_xlpm.v+ROWS(_xlfn.ANCHORARRAY(A1))))", "", true),
    (12, 148, "LET(A1,SEQUENCE(3),SUM(A1#))", "_xlfn.LET(_xlpm.A1,_xlfn.SEQUENCE(3),SUM(_xlfn.ANCHORARRAY(_xlpm.A1)))", "", true),
    (12, 149, "LET(f,LAMBDA(r,SUM(r#)),f(A1))", "_xlfn.LET(_xlpm.f,_xlfn.LAMBDA(_xlpm.r,SUM(_xlfn.ANCHORARRAY(_xlpm.r))),_xlpm.f(A1))", "", true),
    (12, 150, "SUM(Sheet2!A1#)", "SUM(_xlfn.ANCHORARRAY(Sheet2!A1))", "", true),
    (12, 151, "SUM('My Sheet'!A1#)", "SUM(_xlfn.ANCHORARRAY('My Sheet'!A1))", "", true),
    (12, 152, "LET(A1,5,ROWS(A1#)+A1)", "_xlfn.LET(_xlpm.A1,5,ROWS(_xlfn.ANCHORARRAY(_xlpm.A1))+_xlpm.A1)", "", true),
    (12, 153, "LAMBDA(x,LAMBDA(y,x+y)(3))(2)", "_xlfn.LAMBDA(_xlpm.x,_xlfn.LAMBDA(_xlpm.y,_xlpm.x+_xlpm.y)(3))(2)", "", true),
    (12, 154, "LAMBDA(x,LAMBDA(y,LAMBDA(z,x+y+z)(1))(2))(3)", "_xlfn.LAMBDA(_xlpm.x,_xlfn.LAMBDA(_xlpm.y,_xlfn.LAMBDA(_xlpm.z,_xlpm.x+_xlpm.y+_xlpm.z)(1))(2))(3)", "", true),
    (12, 155, "LAMBDA(x,x)(LAMBDA(y,y+1)(1))", "_xlfn.LAMBDA(_xlpm.x,_xlpm.x)(_xlfn.LAMBDA(_xlpm.y,_xlpm.y+1)(1))", "", true),
    (12, 156, "LAMBDA(f,f(2))(LAMBDA(x,x*3))", "_xlfn.LAMBDA(_xlpm.f,_xlpm.f(2))(_xlfn.LAMBDA(_xlpm.x,_xlpm.x*3))", "", true),
    (12, 157, "LAMBDA(x,x*2)(LAMBDA(x,x+1)(LAMBDA(x,x+2)(1)))", "_xlfn.LAMBDA(_xlpm.x,_xlpm.x*2)(_xlfn.LAMBDA(_xlpm.x,_xlpm.x+1)(_xlfn.LAMBDA(_xlpm.x,_xlpm.x+2)(1)))", "", true),
    (12, 158, "LAMBDA(x,LAMBDA(x,x*10)(x+1))(1)", "_xlfn.LAMBDA(_xlpm.x,_xlfn.LAMBDA(_xlpm.x,_xlpm.x*10)(_xlpm.x+1))(1)", "", true),
    (12, 159, "LAMBDA(x,y,x+y)(1,LAMBDA(z,z)(2))", "_xlfn.LAMBDA(_xlpm.x,_xlpm.y,_xlpm.x+_xlpm.y)(1,_xlfn.LAMBDA(_xlpm.z,_xlpm.z)(2))", "", true),
    (12, 160, "LAMBDA(x,x)(1)+LAMBDA(y,y)(2)", "_xlfn.LAMBDA(_xlpm.x,_xlpm.x)(1)+_xlfn.LAMBDA(_xlpm.y,_xlpm.y)(2)", "", true),
    (12, 161, "LAMBDA(x,x+1)(2)*LAMBDA(x,x+1)(3)", "_xlfn.LAMBDA(_xlpm.x,_xlpm.x+1)(2)*_xlfn.LAMBDA(_xlpm.x,_xlpm.x+1)(3)", "", true),
    (12, 162, "IF(TRUE,LAMBDA(x,x)(4),0)", "IF(TRUE,_xlfn.LAMBDA(_xlpm.x,_xlpm.x)(4),0)", "", true),
    (12, 163, "-LAMBDA(x,x)(4)", "-_xlfn.LAMBDA(_xlpm.x,_xlpm.x)(4)", "", true),
    (12, 164, "LAMBDA(x,x)(4)%", "_xlfn.LAMBDA(_xlpm.x,_xlpm.x)(4)%", "", true),
    (12, 165, "LAMBDA(x,[y],IF(ISOMITTED(y),x,x+y))(LAMBDA(z,z)(1))", "_xlfn.LAMBDA(_xlpm.x,_xlop.y,IF(_xlfn.ISOMITTED(_xlpm.y),_xlpm.x,_xlpm.x+_xlpm.y))(_xlfn.LAMBDA(_xlpm.z,_xlpm.z)(1))", "", true),
    (12, 166, "LAMBDA(5)()", "_xlfn.LAMBDA(5)()", "", true),
    (12, 167, "SUM(LAMBDA(x,x)(A1:A3))", "SUM(_xlfn.LAMBDA(_xlpm.x,_xlpm.x)(A1:A3))", "", true),
    (12, 168, "LAMBDA(x,x)(\"__INVOKE__\")", "_xlfn.LAMBDA(_xlpm.x,_xlpm.x)(\"__INVOKE__\")", "", true),
    (12, 169, "LAMBDA(x,LEN(x))(\"LAMBDA(x,x)(2)\")", "_xlfn.LAMBDA(_xlpm.x,LEN(_xlpm.x))(\"LAMBDA(x,x)(2)\")", "", true),
    (12, 170, "LET(f,LAMBDA(x,LAMBDA(y,x*y)),f(2)(3))", "_xlfn.LET(_xlpm.f,_xlfn.LAMBDA(_xlpm.x,_xlfn.LAMBDA(_xlpm.y,_xlpm.x*_xlpm.y)),_xlpm.f(2)(3))", "", true),
    (12, 171, "LAMBDA(x,LAMBDA(y,x*y))(2)(3)", "_xlfn.LAMBDA(_xlpm.x,_xlfn.LAMBDA(_xlpm.y,_xlpm.x*_xlpm.y))(2)(3)", "", true),
    (12, 172, "Opt(1)", "Opt(1)", "", true),
    (12, 173, "Opt(1,2)", "Opt(1,2)", "", true),
    (12, 174, "Opt(Dbl(2))", "Opt(Dbl(2))", "", true),
    (12, 175, "Opt(LAMBDA(x,x+1)(2),3)", "Opt(_xlfn.LAMBDA(_xlpm.x,_xlpm.x+1)(2),3)", "", true),
    (12, 176, "Pick()", "Pick()", "", true),
    (12, 177, "Pick(,4)", "Pick(,4)", "", true),
    (12, 178, "Pick(3)", "Pick(3)", "", true),
    (12, 179, "CellP(1)", "CellP(1)", "", true),
    (12, 180, "CellP(1,2)", "CellP(1,2)", "", true),
    (12, 181, "Rng(2)", "Rng(2)", "", true),
    (12, 182, "LET(Opt,LAMBDA(x,x*100),Opt(1))", "_xlfn.LET(_xlpm.Opt,_xlfn.LAMBDA(_xlpm.x,_xlpm.x*100),_xlpm.Opt(1))", "", true),
    (12, 183, "Dbl(Opt(1,2))+Dbl(3)", "Dbl(Opt(1,2))+Dbl(3)", "", true),
    (12, 184, "LET(C,2,C+1)", "_xlfn.LET(_xlpm.C,2,_xlpm.C+1)", "", true),
    (12, 185, "LET(R,3,R*2)", "_xlfn.LET(_xlpm.R,3,_xlpm.R*2)", "", true),
    (12, 186, "LET(C,2,SUM(A:C)+C)", "_xlfn.LET(_xlpm.C,2,SUM(A:C)+_xlpm.C)", "", true),
    (12, 188, "SUM(C:C)+COLUMN()", "SUM(C:C)+COLUMN()", "", true),
    (12, 189, "ROW(R)", "ROW(189:189)", "", false),
    (12, 190, "C*0+R*0", "J:J*0+190:190*0", "", false),
    (12, 193, "LET(a,A1,SUM(a:C))", "_xlfn.LET(_xlpm.a,_xlnm.A1,SUM(_xlpm.a:J:J))", "", true),
    (12, 194, "-C+@R", "-J:J+_xlfn.SINGLE(194:194)", "", false),
    (12, 195, "LET(E5,2,SUM(E5:E6 E5))", "_xlfn.LET(_xlpm.E5,2,SUM(_xlpm.E5:_xlnm.E6 _xlpm.E5))", "", true),
    (12, 198, "LET(E5,2,SUM(Sheet1!E5:E6)+E5)", "_xlfn.LET(_xlpm.E5,2,SUM(Sheet1!_xlnm.E5:_xlnm.E6)+_xlpm.E5)", "", true),
    (12, 199, "LET(E5,SEQUENCE(3),SUM(E5#))", "_xlfn.LET(_xlpm.E5,_xlfn.SEQUENCE(3),SUM(_xlfn.ANCHORARRAY(_xlpm.E5)))", "", true),
    (12, 200, "LET(A1,1,SUM(Sheet1!A1)+A1)", "_xlfn.LET(_xlpm.A1,1,SUM(Sheet1!_xlnm.A1)+_xlpm.A1)", "", true),
    (12, 201, "LET(B2,1,LAMBDA(B2,B2*3)(B2+1))", "_xlfn.LET(_xlpm.B2,1,_xlfn.LAMBDA(_xlpm.B2,_xlpm.B2*3)(_xlpm.B2+1))", "", true),
    (12, 202, "LET(A1,1,B1,2,SUM(A1:B1))", "_xlfn.LET(_xlpm.A1,1,_xlpm.B1,2,SUM(_xlpm.A1:_xlpm.B1))", "", true),
    (12, 203, "LET(XFD1,1,SUM(XFD1:XFD2)+XFD1)", "_xlfn.LET(_xlpm.XFD1,1,SUM(_xlpm.XFD1:_xlnm.XFD2)+_xlpm.XFD1)", "", true),
    (12, 204, "LET(a,1,b,LAMBDA(x,[y],x),b(a))", "_xlfn.LET(_xlpm.a,1,_xlpm.b,_xlfn.LAMBDA(_xlpm.x,_xlop.y,_xlpm.x),_xlpm.b(_xlpm.a))", "", true),
    (12, 205, "LET(x,1,LAMBDA(x,[x2],x)(x))", "_xlfn.LET(_xlpm.x,1,_xlfn.LAMBDA(_xlpm.x,_xlop.x2,_xlpm.x)(_xlpm.x))", "", true),
    (12, 206, "MAKEARRAY(1,1,LAMBDA(r,c,r+c))", "_xlfn.MAKEARRAY(1,1,_xlfn.LAMBDA(_xlpm.r,_xlpm.c,_xlpm.r+_xlpm.c))", "", true),
    (12, 207, "LET(c,3,r,4,c*r)", "_xlfn.LET(_xlpm.c,3,_xlpm.r,4,_xlpm.c*_xlpm.r)", "", true),
    (12, 208, "LET(a,1,SUM(A1:.A5 A1:A3)+a)", "_xlfn.LET(_xlpm.a,1,SUM(_xlfn._TRO_TRAILING(A1:A5) A1:A3)+_xlpm.a)", "", true),
    (12, 209, "__INVOKE__(\"Opt\",LAMBDA(x,[y],IF(ISOMITTED(y),x,x+y)),1)", "Opt(1)", "", false),
    (12, 210, "__INVOKE__(\"Opt\",LAMBDA(x,[y],IF(ISOMITTED(y),x,x+y)),1,2)", "Opt(1,2)", "", false),
    (12, 211, "__INVOKE__(\"Pick\",LAMBDA([a],[b],IF(ISOMITTED(a),IF(ISOMITTED(b),0,b),a)),,4)", "Pick(,4)", "", false),
    (12, 212, "__INVOKE__(\"Pick\",LAMBDA([a],[b],IF(ISOMITTED(a),IF(ISOMITTED(b),0,b),a)))", "Pick()", "", false),
    (12, 213, "__INVOKE__(\"Opt\",LAMBDA(x,[y],IF(ISOMITTED(y),x,x+y)),LAMBDA(x,x+1)(2))", "Opt(_xlfn.LAMBDA(_xlpm.x,_xlpm.x+1)(2))", "", false),
    (12, 214, "__INVOKE__(\"Opt\",LAMBDA(x,[y],IF(ISOMITTED(y),x,x+y)),__INVOKE__(\"Dbl\",LAMBDA(x,x*2),2),__INVOKE__(\"Opt\",LAMBDA(x,[y],IF(ISOMITTED(y),x,x+y)),1))", "Opt(Dbl(2),Opt(1))", "", false),
    (12, 215, "LET(y,5,__INVOKE__(\"Opt\",LAMBDA(x,[y],IF(ISOMITTED(y),x,x+y)),y))", "_xlfn.LET(_xlpm.y,5,Opt(_xlpm.y))", "", false),
    (12, 216, "LET(A1,5,__INVOKE__(\"Opt\",LAMBDA(x,[y],IF(ISOMITTED(y),x,x+y)),A1,A1))", "_xlfn.LET(_xlpm.A1,5,Opt(_xlpm.A1,_xlpm.A1))", "", false),
    (12, 217, "__INVOKE__(\"Opt\",LAMBDA(x,[y],IF(ISOMITTED(y),x,x+y)),C)", "Opt(J:J)", "", false),
    (12, 218, "SUM(Seq(3))", "SUM(Seq(3))", "", true),
    (12, 219, "ROWS(Seq(4))", "ROWS(Seq(4))", "", true),
    (12, 220, "INDEX(Seq(5),3)", "INDEX(Seq(5),3)", "", true),
    (12, 221, "SUM(__INVOKE__(\"Seq\",LAMBDA(n,SEQUENCE(n)),3))", "SUM(Seq(3))", "", false),
    (12, 222, "MAX(Opt(A1:A3))", "MAX(Opt(A1:A3))", "", true),
    (12, 223, "SUM(Opt(A1:A3,1))", "SUM(Opt(A1:A3,1))", "", true),
    (12, 226, "LET(if,LAMBDA(x,x*3),if(2,3))", "_xlfn.LET(_xlpm.if,_xlfn.LAMBDA(_xlpm.x,_xlpm.x*3),IF(2,3))", "", true),
    (12, 227, "LET(if,1,if+1)", "_xlfn.LET(_xlpm.if,1,_xlpm.if+1)", "", true),
    (12, 230, "LET(E5,E5+1,E5)", "_xlfn.LET(_xlpm.E5,_xlnm.E5+1,_xlpm.E5)", "", true),
    (12, 231, "LET(A1,A1*10,A1)", "_xlfn.LET(_xlpm.A1,_xlnm.A1*10,_xlpm.A1)", "", true),
    (12, 232, "LET(A1,SUM(A1:A3),A1)", "_xlfn.LET(_xlpm.A1,SUM(_xlnm.A1:_xlnm.A3),_xlpm.A1)", "", true),
    (12, 233, "LAMBDA(A1,A1*2)(A1+1)", "_xlfn.LAMBDA(_xlpm.A1,_xlpm.A1*2)(_xlnm.A1+1)", "", true),
    (12, 234, "LET(x,1,A1,x+A1,A1)", "_xlfn.LET(_xlpm.x,1,_xlpm.A1,_xlpm.x+_xlnm.A1,_xlpm.A1)", "", true),
    (12, 235, "LET(B1,A1,A1,B1*2,A1+B1)", "_xlfn.LET(_xlpm.B1,_xlnm.A1,_xlpm.A1,_xlpm.B1*2,_xlpm.A1+_xlpm.B1)", "", true),
    (12, 236, "RC*0", "J236*0", "", false),
    (12, 237, "R1C1*0", "$A$1*0", "", false),
    (12, 238, "SUM(1:.3)", "SUM(_xlfn._TRO_TRAILING(1:3))", "", true),
    (12, 239, "SUM(1.:3)", "SUM(_xlfn._TRO_LEADING(1:3))", "", true),
    (12, 240, "SUM(A:.C)", "SUM(_xlfn._TRO_TRAILING(A:C))", "", true),
    (12, 241, "LET(a,1,SUM(1:.3)+a)", "_xlfn.LET(_xlpm.a,1,SUM(_xlfn._TRO_TRAILING(1:3))+_xlpm.a)", "", true),
    (12, 242, "SUM($A$1:.$A$5)", "SUM(_xlfn._TRO_TRAILING($A$1:$A$5))", "", true),
    (12, 243, "SUM(A$1:.A$5)", "SUM(_xlfn._TRO_TRAILING(A$1:A$5))", "", true),
    (12, 244, "SUM($A$1#)", "SUM(_xlfn.ANCHORARRAY($A$1))", "", true),
    (12, 245, "SUM(Sheet1!$A$1#)", "SUM(_xlfn.ANCHORARRAY(Sheet1!$A$1))", "", true),
    (12, 246, "SUM( C )", "SUM( J:J )", "SUM(J:J)", false),
    (12, 247, "(C)*0", "(J:J)*0", "J:J*0", false),
    (12, 249, "LET(c,1,SUM(R:c)+c)", "_xlfn.LET(_xlpm.c,1,SUM(C:R)+_xlpm.c)", "_xlfn.LET(_xlpm.c,1,SUM(R:C)+_xlpm.c)", true),
    (12, 250, "LET(x,2,SUM(A1:.C3 B1:B5)*x)", "_xlfn.LET(_xlpm.x,2,SUM(_xlfn._TRO_TRAILING(A1:C3) B1:B5)*_xlpm.x)", "", true),
    (12, 251, "LET(Table2,1,Table2+1)", "_xlfn.LET(_xlpm.Table2,1,_xlpm.Table2+1)", "", true),
    (12, 252, "SUM(Table2[@[My Col]])", "SUM(Table2[[#This Row],[My Col]])", "", true),
    (12, 253, "SUM(Table2[@[a''b]])", "SUM(Table2[[#This Row],[a''b]])", "", true),
    (12, 254, "SUM(Table2[@[x'#y]])", "SUM(Table2[[#This Row],[x'#y]])", "", true),
    (12, 255, "SUM(Table2[@[Q'[1']]])", "SUM(Table2[[#This Row],[Q'[1']]])", "", true),
    (12, 256, "SUM(Table2[@[My Col]:[x'#y]])", "SUM(Table2[[#This Row],[My Col]:[x'#y]])", "", true),
    (12, 257, "LET(x,1,SUM(Table2[@[My Col]])+x)", "_xlfn.LET(_xlpm.x,1,SUM(Table2[[#This Row],[My Col]])+_xlpm.x)", "", true),
    (12, 258, "LAMBDA(r,r+SUM(Table2[@[My Col]]))(1)", "_xlfn.LAMBDA(_xlpm.r,_xlpm.r+SUM(Table2[[#This Row],[My Col]]))(1)", "", true),
    (12, 259, "LET(My,1,SUM(Table2[@[My Col]])+My)", "_xlfn.LET(_xlpm.My,1,SUM(Table2[[#This Row],[My Col]])+_xlpm.My)", "", true),
    (12, 260, "SUM(Table2[[#This Row],[My Col]])", "SUM(Table2[[#This Row],[My Col]])", "", true),
    (12, 261, "SUM(Table2[My Col])", "SUM(Table2[My Col])", "", true),
    (12, 262, "SUM(Table2[[#Headers],[My Col]])", "SUM(Table2[[#Headers],[My Col]])", "", true),
    (12, 263, "LET(f,LAMBDA(x,[y],x+N(y)),f(1)+f(1,2))", "_xlfn.LET(_xlpm.f,_xlfn.LAMBDA(_xlpm.x,_xlop.y,_xlpm.x+N(_xlpm.y)),_xlpm.f(1)+_xlpm.f(1,2))", "", true),
    (12, 264, "LET(f,LAMBDA(x,LAMBDA([y],IF(ISOMITTED(y),x,x*y))),f(2)()+f(2)(3))", "_xlfn.LET(_xlpm.f,_xlfn.LAMBDA(_xlpm.x,_xlfn.LAMBDA(_xlop.y,IF(_xlfn.ISOMITTED(_xlpm.y),_xlpm.x,_xlpm.x*_xlpm.y))),_xlpm.f(2)()+_xlpm.f(2)(3))", "", true),
    (12, 265, "LAMBDA(x,[y],LAMBDA([z],x+N(y)+N(z))())(1)", "_xlfn.LAMBDA(_xlpm.x,_xlop.y,_xlfn.LAMBDA(_xlop.z,_xlpm.x+N(_xlpm.y)+N(_xlpm.z))())(1)", "", true),
    (12, 266, "LET(a,LAMBDA(x,x),b,a(LAMBDA(y,y+1)(1)),b)", "_xlfn.LET(_xlpm.a,_xlfn.LAMBDA(_xlpm.x,_xlpm.x),_xlpm.b,_xlpm.a(_xlfn.LAMBDA(_xlpm.y,_xlpm.y+1)(1)),_xlpm.b)", "", true),
    (12, 267, "LAMBDA(x,x#)(A1)", "_xlfn.LAMBDA(_xlpm.x,_xlfn.ANCHORARRAY(_xlpm.x))(A1)", "", true),
    (12, 268, "XLOOKUP(2,A1:A5,B1:B5)+LAMBDA(x,x)(1)", "_xlfn.XLOOKUP(2,A1:A5,B1:B5)+_xlfn.LAMBDA(_xlpm.x,_xlpm.x)(1)", "", true),
    (12, 269, "SUM(A1:A5,LAMBDA(x,x)(1))", "SUM(A1:A5,_xlfn.LAMBDA(_xlpm.x,_xlpm.x)(1))", "", true),
    (12, 273, "LAMBDA([C],[R],N(C)+N(R))()", "_xlfn.LAMBDA(_xlop.C,_xlop.R,N(_xlpm.C)+N(_xlpm.R))()", "", true),
    (12, 274, "LET(XFD1048576,1,SUM(XFD1048575:XFD1048576)+XFD1048576)", "_xlfn.LET(_xlpm.XFD1048576,1,SUM(_xlnm.XFD1048575:_xlpm.XFD1048576)+_xlpm.XFD1048576)", "", true),
    (12, 275, "SUM(Table2[x'#y])", "SUM(Table2[x'#y])", "", true),
    (12, 276, "SUM(Table2[[#This Row],[x'#y]])", "SUM(Table2[[#This Row],[x'#y]])", "", true),
    (12, 277, "SUM(Table2[[#All],[x'#y]])", "SUM(Table2[[#All],[x'#y]])", "", true),
    (12, 278, "LET(x,1,SUM(Table2[@[x'#y]])+x)", "_xlfn.LET(_xlpm.x,1,SUM(Table2[[#This Row],[x'#y]])+_xlpm.x)", "", true),
    (12, 279, "SUM(C:.E)", "SUM(_xlfn._TRO_TRAILING(C:E))", "", true),
    (12, 280, "SUM(A.:C)", "SUM(_xlfn._TRO_LEADING(A:C))", "", true),
    (12, 281, "SUM(A.:.C)", "SUM(_xlfn._TRO_ALL(A:C))", "", true),
    (12, 283, "SUM(B:.R)", "SUM(_xlfn._TRO_TRAILING(B:R))", "", true),
    (12, 284, "SUM(C.:C)", "SUM(_xlfn._TRO_LEADING(C:C))", "", true),
    (12, 286, "RC[-1]*0", "I286*0", "", false),
    (12, 287, "R2C*0", "J$2*0", "", false),
    (12, 288, "R1C*0", "J$1*0", "", false),
    (12, 289, "RC1*0", "RC1*0", "", true),
    (12, 290, "LET(a,a+1,a)", "_xlfn.LET(_xlpm.a,a+1,_xlpm.a)", "", true),
    (12, 291, "LET(x,1,y,y+x,y)", "_xlfn.LET(_xlpm.x,1,_xlpm.y,y+_xlpm.x,_xlpm.y)", "", true),
    (12, 292, "SUM(2.:.3)", "SUM(_xlfn._TRO_ALL(2:3))", "", true),
    (12, 293, "SUM(Sheet1!1:.3)", "SUM(_xlfn._TRO_TRAILING(Sheet1!1:3))", "", true),
    (12, 294, "SUM(A1:.C3)", "SUM(_xlfn._TRO_TRAILING(A1:C3))", "", true),
    (12, 295, "LET(Rate,Rate*2,Rate)", "_xlfn.LET(_xlpm.Rate,Rate*2,_xlpm.Rate)", "", true),
    (12, 296, "LET(Dbl,Dbl(3),Dbl)", "_xlfn.LET(_xlpm.Dbl,Dbl(3),_xlpm.Dbl)", "", true),
    (12, 297, "LET(x,Rate,Rate,x*3,Rate)", "_xlfn.LET(_xlpm.x,Rate,_xlpm.Rate,_xlpm.x*3,_xlpm.Rate)", "", true),
    (12, 298, "LET(Rate,1,Rate)+Rate", "_xlfn.LET(_xlpm.Rate,1,_xlpm.Rate)+Rate", "", true),
    (12, 299, "LAMBDA(Rate,Rate*2)(Rate)", "_xlfn.LAMBDA(_xlpm.Rate,_xlpm.Rate*2)(Rate)", "", true),
    (12, 300, "LET(f,LAMBDA(Dbl,Dbl+1),f(Dbl(2)))", "_xlfn.LET(_xlpm.f,_xlfn.LAMBDA(_xlpm.Dbl,_xlpm.Dbl+1),_xlpm.f(Dbl(2)))", "", true),
    (12, 301, "LET(Opt,Opt(1,2),Opt*10)", "_xlfn.LET(_xlpm.Opt,Opt(1,2),_xlpm.Opt*10)", "", true),
    (7, 7, "LET(A1,7,LAMBDA([A1],IF(ISOMITTED(A1),0,A1))()+A1)", "_xlfn.LET(_xlpm.A1,7,_xlfn.LAMBDA(_xlop.A1,IF(_xlfn.ISOMITTED(_xlpm.A1),0,_xlpm.A1))()+_xlpm.A1)", "", true),
    (7, 8, "LET(A1,2,LAMBDA(x,[B1],x+N(B1))(A1))", "_xlfn.LET(_xlpm.A1,2,_xlfn.LAMBDA(_xlpm.x,_xlop.B1,_xlpm.x+N(_xlpm.B1))(_xlpm.A1))", "", true),
    (7, 9, "LAMBDA([E5],[E6],SUM(E5:E6))(1,2)", "_xlfn.LAMBDA(_xlop.E5,_xlop.E6,SUM(_xlpm.E5:_xlpm.E6))(1,2)", "", true),
    (7, 10, "LAMBDA([A1],SUM(A1:A3))(B1)", "_xlfn.LAMBDA(_xlop.A1,SUM(_xlpm.A1:_xlnm.A3))(_xlnm.B1)", "", true),
    (7, 11, "LAMBDA([A1],A1+SUM(Sheet1!A1:A3))(1)", "_xlfn.LAMBDA(_xlop.A1,_xlpm.A1+SUM(Sheet1!_xlnm.A1:_xlnm.A3))(1)", "", true),
    (7, 12, "LET(A1,1,A2,A1:A3,SUM(A2))", "_xlfn.LET(_xlpm.A1,1,_xlpm.A2,_xlpm.A1:_xlnm.A3,SUM(_xlpm.A2))", "", true),
    (7, 13, "LET(A1,1,SUM(Sheet1!A1:A3)+A1)", "_xlfn.LET(_xlpm.A1,1,SUM(Sheet1!_xlnm.A1:_xlnm.A3)+_xlpm.A1)", "", true),
    (7, 14, "LET(f,LAMBDA(A1,A1*2),A1+f(1))", "_xlfn.LET(_xlpm.f,_xlfn.LAMBDA(_xlpm.A1,_xlpm.A1*2),_xlnm.A1+_xlpm.f(1))", "", true),
    (7, 15, "LET(f,LAMBDA(A1,A1*2),SUM(A1:B2)+f(1))", "_xlfn.LET(_xlpm.f,_xlfn.LAMBDA(_xlpm.A1,_xlpm.A1*2),SUM(_xlnm.A1:_xlnm.B2)+_xlpm.f(1))", "", true),
    (7, 16, "LET(E5,E5*2,LAMBDA(E5,E5+1)(E5))", "_xlfn.LET(_xlpm.E5,_xlnm.E5*2,_xlfn.LAMBDA(_xlpm.E5,_xlpm.E5+1)(_xlpm.E5))", "", true),
    (7, 17, "LET(A1,A1,A1)", "_xlfn.LET(_xlpm.A1,_xlnm.A1,_xlpm.A1)", "", true),
    (7, 19, "LET(Opt,Opt(1),Opt+1)", "_xlfn.LET(_xlpm.Opt,Opt(1),_xlpm.Opt+1)", "", true),
    (7, 20, "LET(Dbl,LAMBDA(x,Dbl(x)+1),Dbl(2))", "_xlfn.LET(_xlpm.Dbl,_xlfn.LAMBDA(_xlpm.x,Dbl(_xlpm.x)+1),_xlpm.Dbl(2))", "", true),
    (7, 21, "LET(x,1,y,x+1,LAMBDA(x,x*y)(y))", "_xlfn.LET(_xlpm.x,1,_xlpm.y,_xlpm.x+1,_xlfn.LAMBDA(_xlpm.x,_xlpm.x*_xlpm.y)(_xlpm.y))", "", true),
    (7, 24, "LET(C,2,SUM(A:.C)*C)", "_xlfn.LET(_xlpm.C,2,SUM(_xlfn._TRO_TRAILING(A:C))*_xlpm.C)", "", true),
    (7, 26, "LET(B,1,SUM(A:.B)+B)", "_xlfn.LET(_xlpm.B,1,SUM(_xlfn._TRO_TRAILING(A:B))+_xlpm.B)", "", true),
    (7, 30, "SUM(A:.$C)", "SUM(_xlfn._TRO_TRAILING(A:$C))", "", true),
    (7, 31, "SUM($A:.C)", "SUM(_xlfn._TRO_TRAILING($A:C))", "", true),
    (7, 32, "SUM($A:.$C)", "SUM(_xlfn._TRO_TRAILING($A:$C))", "", true),
    (7, 33, "SUM($A.:$C)", "SUM(_xlfn._TRO_LEADING($A:$C))", "", true),
    (7, 34, "LET(c,1,SUM(A:.$C)+c)", "_xlfn.LET(_xlpm.c,1,SUM(_xlfn._TRO_TRAILING(A:$C))+_xlpm.c)", "", true),
    (7, 35, "SUM(A:.$R)", "SUM(_xlfn._TRO_TRAILING(A:$R))", "", true),
    (7, 36, "SUM(Sheet2!A:.C)", "SUM(_xlfn._TRO_TRAILING(Sheet2!A:C))", "", true),
    (7, 37, "SUM('My Sheet'!A:.B)", "SUM(_xlfn._TRO_TRAILING('My Sheet'!A:B))", "", true),
    (7, 38, "sum(a:.c)", "SUM(_xlfn._TRO_TRAILING(A:C))", "", true),
    (7, 39, "SUM(XFD.:XFD)", "SUM(_xlfn._TRO_LEADING(XFD:XFD))", "", true),
    (7, 40, "SUM(A:.A,B:.B)", "SUM(_xlfn._TRO_TRAILING(A:A),_xlfn._TRO_TRAILING(B:B))", "", true),
    (7, 41, "LET(r,1,SUM(B:.R)*r)", "_xlfn.LET(_xlpm.r,1,SUM(_xlfn._TRO_TRAILING(B:R))*_xlpm.r)", "", true),
    (7, 42, "LAMBDA(c,SUM(A:.C)*c)(2)", "_xlfn.LAMBDA(_xlpm.c,SUM(_xlfn._TRO_TRAILING(A:C))*_xlpm.c)(2)", "", true),
    (7, 43, "SUM($1:.$3)", "SUM(_xlfn._TRO_TRAILING($1:$3))", "", true),
    (7, 44, "SUM(1:.$3)", "SUM(_xlfn._TRO_TRAILING(1:$3))", "", true),
    (7, 45, "SUM($1.:3)", "SUM(_xlfn._TRO_LEADING($1:3))", "", true),
    (7, 46, "SUM(Sheet2!1:.3)", "SUM(_xlfn._TRO_TRAILING(Sheet2!1:3))", "", true),
    (7, 47, "SUM('My Sheet'!1:.2)", "SUM(_xlfn._TRO_TRAILING('My Sheet'!1:2))", "", true),
    (7, 48, "LET(a,1,SUM(1:.3)*a)", "_xlfn.LET(_xlpm.a,1,SUM(_xlfn._TRO_TRAILING(1:3))*_xlpm.a)", "", true),
    (7, 49, "SUM(1:.3 2:2)", "SUM(_xlfn._TRO_TRAILING(1:3) 2:2)", "", true),
    (7, 50, "ROWS(1:.3)", "ROWS(_xlfn._TRO_TRAILING(1:3))", "", true),
    (7, 51, "LAMBDA(x,SUM(1:.3)*x)(2)", "_xlfn.LAMBDA(_xlpm.x,SUM(_xlfn._TRO_TRAILING(1:3))*_xlpm.x)(2)", "", true),
    (7, 52, "SUM(Sheet1!$1:.$3)", "SUM(_xlfn._TRO_TRAILING(Sheet1!$1:$3))", "", true),
    (7, 53, "SUM(1:.3)+SUM(4:.5)", "SUM(_xlfn._TRO_TRAILING(1:3))+SUM(_xlfn._TRO_TRAILING(4:5))", "", true),
    (7, 54, "SUM(1:3)*.5", "SUM(1:3)*0.5", "", true),
    (7, 55, "LAMBDA(A1,SUM(A1#))(B1)", "_xlfn.LAMBDA(_xlpm.A1,SUM(_xlfn.ANCHORARRAY(_xlpm.A1)))(_xlnm.B1)", "", true),
    (7, 56, "LET(A1,SEQUENCE(3),LAMBDA(x,SUM(A1#)*x)(2))", "_xlfn.LET(_xlpm.A1,_xlfn.SEQUENCE(3),_xlfn.LAMBDA(_xlpm.x,SUM(_xlfn.ANCHORARRAY(_xlpm.A1))*_xlpm.x)(2))", "", true),
    (7, 57, "LAMBDA(x,SUM(Sheet2!A1#)*x)(1)", "_xlfn.LAMBDA(_xlpm.x,SUM(_xlfn.ANCHORARRAY(Sheet2!A1))*_xlpm.x)(1)", "", true),
    (7, 58, "LAMBDA(x,SUM('My Sheet'!A1#)*x)(1)", "_xlfn.LAMBDA(_xlpm.x,SUM(_xlfn.ANCHORARRAY('My Sheet'!A1))*_xlpm.x)(1)", "", true),
    (7, 59, "LET(x,SEQUENCE(3),SUM(x#))", "_xlfn.LET(_xlpm.x,_xlfn.SEQUENCE(3),SUM(_xlfn.ANCHORARRAY(_xlpm.x)))", "", true),
    (7, 60, "LAMBDA(f,f(f(2)))(LAMBDA(x,x*2))", "_xlfn.LAMBDA(_xlpm.f,_xlpm.f(_xlpm.f(2)))(_xlfn.LAMBDA(_xlpm.x,_xlpm.x*2))", "", true),
    (7, 61, "LAMBDA(x,[y],LAMBDA(x,[y],N(x)+N(y))(y,x))(1,2)", "_xlfn.LAMBDA(_xlpm.x,_xlop.y,_xlfn.LAMBDA(_xlpm.x,_xlop.y,N(_xlpm.x)+N(_xlpm.y))(_xlpm.y,_xlpm.x))(1,2)", "", true),
    (7, 62, "MAP(A1:A3,LAMBDA(x,LAMBDA(y,y*x)(x)))", "_xlfn.MAP(A1:A3,_xlfn.LAMBDA(_xlpm.x,_xlfn.LAMBDA(_xlpm.y,_xlpm.y*_xlpm.x)(_xlpm.x)))", "", true),
    (7, 63, "LAMBDA(x,LAMBDA(y,LAMBDA(z,x*y*z))(2))(3)(4)", "_xlfn.LAMBDA(_xlpm.x,_xlfn.LAMBDA(_xlpm.y,_xlfn.LAMBDA(_xlpm.z,_xlpm.x*_xlpm.y*_xlpm.z))(2))(3)(4)", "", true),
    (7, 64, "LET(f,LAMBDA(x,[y],LAMBDA(z,x+N(y)+z)),f(1)(2)+f(1,2)(3))", "_xlfn.LET(_xlpm.f,_xlfn.LAMBDA(_xlpm.x,_xlop.y,_xlfn.LAMBDA(_xlpm.z,_xlpm.x+N(_xlpm.y)+_xlpm.z)),_xlpm.f(1)(2)+_xlpm.f(1,2)(3))", "", true),
    (7, 65, "REDUCE(0,A1:A3,LAMBDA(a,v,a+LAMBDA(q,q*2)(v)))", "_xlfn.REDUCE(0,A1:A3,_xlfn.LAMBDA(_xlpm.a,_xlpm.v,_xlpm.a+_xlfn.LAMBDA(_xlpm.q,_xlpm.q*2)(_xlpm.v)))", "", true),
    (7, 66, "Opt(Pick(,2))", "Opt(Pick(,2))", "", true),
    (7, 67, "Pick(Opt(1),)", "Pick(Opt(1),)", "", true),
    (7, 68, "Pick(,Opt(1,Dbl(2)))", "Pick(,Opt(1,Dbl(2)))", "", true),
    (7, 69, "CellP(Opt(1),Pick())", "CellP(Opt(1),Pick())", "", true),
    (7, 70, "LET(Dbl,2,Opt(Dbl))", "_xlfn.LET(_xlpm.Dbl,2,Opt(_xlpm.Dbl))", "", true),
    (7, 71, "LET(Dbl,Dbl(3),Opt(Dbl,1))", "_xlfn.LET(_xlpm.Dbl,Dbl(3),Opt(_xlpm.Dbl,1))", "", true),
    (7, 72, "LAMBDA(Opt,Opt*2)(Opt(1,1))", "_xlfn.LAMBDA(_xlpm.Opt,_xlpm.Opt*2)(Opt(1,1))", "", true),
    (7, 73, "Dbl(Dbl(Dbl(1)))", "Dbl(Dbl(Dbl(1)))", "", true),
    (7, 74, "MAP(A1:A3,LAMBDA(v,Opt(v,1)))", "_xlfn.MAP(A1:A3,_xlfn.LAMBDA(_xlpm.v,Opt(_xlpm.v,1)))", "", true),
    (7, 75, "LET(sum,LAMBDA(x,x),sum(1,2,3))", "_xlfn.LET(_xlpm.sum,_xlfn.LAMBDA(_xlpm.x,_xlpm.x),SUM(1,2,3))", "", true),
    (7, 81, "LET(today,1,today+1)", "_xlfn.LET(_xlpm.today,1,_xlpm.today+1)", "", true),
    (7, 111, "LAMBDA(x)", "_xlfn.LAMBDA(x)", "", true),
    (7, 112, "LAMBDA(x,x)()", "_xlfn.LAMBDA(_xlpm.x,_xlpm.x)()", "", true),
    (7, 113, "LAMBDA(x,x)(1,2)", "_xlfn.LAMBDA(_xlpm.x,_xlpm.x)(1,2)", "", true),
    (7, 114, "LET(f,LAMBDA(x,x),f(1,2))", "_xlfn.LET(_xlpm.f,_xlfn.LAMBDA(_xlpm.x,_xlpm.x),_xlpm.f(1,2))", "", true),
    (7, 115, "VSTACK(A1:A2,B1:B2)", "_xlfn.VSTACK(A1:A2,B1:B2)", "", true),
    (7, 116, "SUM(TAKE(A1:A5,2))", "SUM(_xlfn.TAKE(A1:A5,2))", "", true),
    (7, 117, "LET(a,A1:A5,SUM(TAKE(a,-1)))", "_xlfn.LET(_xlpm.a,A1:A5,SUM(_xlfn.TAKE(_xlpm.a,-1)))", "", true),
    (7, 118, "SUM(TRIMRANGE(A1:C10))", "SUM(_xlfn.TRIMRANGE(A1:C10))", "", true),
    (7, 119, "SUM(DROP(A1:C5,1,1))", "SUM(_xlfn.DROP(A1:C5,1,1))", "", true),
    (7, 120, "TEXTJOIN(\",\",TRUE,TOCOL(A1:B2))", "_xlfn.TEXTJOIN(\",\",TRUE,_xlfn.TOCOL(A1:B2))", "", true),
    (7, 121, "ROWS(TEXTSPLIT(\"a,b,c\",\",\"))", "ROWS(_xlfn.TEXTSPLIT(\"a,b,c\",\",\"))", "", true),
    (7, 122, "ARRAYTOTEXT(A1:A3)", "_xlfn.ARRAYTOTEXT(A1:A3)", "", true),
    (7, 123, "SUM(CHOOSECOLS(A1:C5,1,3))", "SUM(_xlfn.CHOOSECOLS(A1:C5,1,3))", "", true),
    (7, 124, "SUM(EXPAND(A1,2,2,0))", "SUM(_xlfn.EXPAND(A1,2,2,0))", "", true),
    (7, 125, "SUM(WRAPROWS(A1:A4,2))", "SUM(_xlfn.WRAPROWS(A1:A4,2))", "", true),
    (7, 126, "SUM(HSTACK(A1,B1))", "SUM(_xlfn.HSTACK(A1,B1))", "", true),
    (7, 127, "@A1:A5", "A1:A5", "_xlfn.SINGLE(A1:A5)", true),
    (7, 128, "LET(a,A1:A5,@a+1)", "_xlfn.LET(_xlpm.a,A1:A5,_xlpm.a+1)", "_xlfn.LET(_xlpm.a,A1:A5,_xlfn.SINGLE(_xlpm.a)+1)", true),
    (7, 129, "SUM(@A1:A5)", "SUM(_xlfn.SINGLE(A1:A5))", "", true),
    (7, 130, "ISOMITTED(1)", "_xlfn.ISOMITTED(1)", "", true),
    (7, 132, "LET(x,1,_xlpm.x+1)", "_xlfn.LET(_xlpm.x,1,_xlpm.x+1)", "", false),
    (7, 133, "SUM(A1:A5 A1:.A3)", "SUM(A1:A5 _xlfn._TRO_TRAILING(A1:A3))", "", true),
    (7, 137, "LET(A1,1,A1:A3)", "_xlfn.LET(_xlpm.A1,1,_xlpm.A1:_xlnm.A3)", "", true),
    (7, 139, "LET(a,1,SUM(Sheet1:Sheet2!A1)+a)", "_xlfn.LET(_xlpm.a,1,SUM(Sheet1:Sheet2!A1)+_xlpm.a)", "", true),
    (7, 140, "LET(Ö1,1,Ö1+1)", "_xlfn.LET(_xlpm.Ö1,1,_xlpm.Ö1+1)", "", true),
    (7, 141, "LET(A1B,1,A1B+1)", "_xlfn.LET(_xlpm.A1B,1,_xlpm.A1B+1)", "", true),
    (7, 142, "LET(R1C,1,R1C+1)", "_xlfn.LET(_xlpm.R1C,1,_xlpm.R1C+1)", "", true),
    (7, 143, "LET(RC,1,RC+1)", "_xlfn.LET(_xlpm.RC,1,_xlpm.RC+1)", "", true),
    (7, 144, "LAMBDA(C,R,C*R)(2,3)", "_xlfn.LAMBDA(_xlpm.C,_xlpm.R,_xlpm.C*_xlpm.R)(2,3)", "", true),
    (7, 146, "LET(x,R1C1,x*0)", "_xlfn.LET(_xlpm.x,$A$1,_xlpm.x*0)", "", false),
    (7, 147, "LAMBDA(x,x+C)(1)", "_xlfn.LAMBDA(_xlpm.x,_xlpm.x+J:J)(1)", "", false),
    (7, 148, "__INVOKE__(\"Opt\",LAMBDA(x,[y],IF(ISOMITTED(y),x,x+y)),__INVOKE__(\"Pick\",LAMBDA([a],[b],IF(ISOMITTED(a),IF(ISOMITTED(b),0,b),a)),,2))", "Opt(Pick(,2))", "", false),
    (7, 149, "__INVOKE__(\"Pick\",LAMBDA([a],[b],IF(ISOMITTED(a),IF(ISOMITTED(b),0,b),a)),__INVOKE__(\"Opt\",LAMBDA(x,[y],IF(ISOMITTED(y),x,x+y)),1),)", "Pick(Opt(1),)", "", false),
    (7, 150, "__INVOKE__(\"Pick\",LAMBDA([a],[b],IF(ISOMITTED(a),IF(ISOMITTED(b),0,b),a)),,__INVOKE__(\"Opt\",LAMBDA(x,[y],IF(ISOMITTED(y),x,x+y)),1,__INVOKE__(\"Dbl\",LAMBDA(x,x*2),2)))", "Pick(,Opt(1,Dbl(2)))", "", false),
    (7, 151, "__INVOKE__(\"CellP\",LAMBDA(E5,[A1],IF(ISOMITTED(A1),E5,E5+A1)),__INVOKE__(\"Opt\",LAMBDA(x,[y],IF(ISOMITTED(y),x,x+y)),1),__INVOKE__(\"Pick\",LAMBDA([a],[b],IF(ISOMITTED(a),IF(ISOMITTED(b),0,b),a))))", "CellP(Opt(1),Pick())", "", false),
    (7, 152, "LET(Dbl,2,__INVOKE__(\"Opt\",LAMBDA(x,[y],IF(ISOMITTED(y),x,x+y)),Dbl))", "_xlfn.LET(_xlpm.Dbl,2,Opt(_xlpm.Dbl))", "", false),
    (7, 153, "LAMBDA(Opt,Opt*2)(__INVOKE__(\"Opt\",LAMBDA(x,[y],IF(ISOMITTED(y),x,x+y)),1,1))", "_xlfn.LAMBDA(_xlpm.Opt,_xlpm.Opt*2)(Opt(1,1))", "", false),
    (7, 154, "__INVOKE__(\"Dbl\",LAMBDA(x,x*2),__INVOKE__(\"Dbl\",LAMBDA(x,x*2),__INVOKE__(\"Dbl\",LAMBDA(x,x*2),1)))", "Dbl(Dbl(Dbl(1)))", "", false),
    (7, 155, "MAP(A1:A3,LAMBDA(v,__INVOKE__(\"Opt\",LAMBDA(x,[y],IF(ISOMITTED(y),x,x+y)),v,1)))", "_xlfn.MAP(A1:A3,_xlfn.LAMBDA(_xlpm.v,Opt(_xlpm.v,1)))", "", false),
    (7, 156, "LET(A1,3,__INVOKE__(\"CellP\",LAMBDA(E5,[A1],IF(ISOMITTED(A1),E5,E5+A1)),A1))", "_xlfn.LET(_xlpm.A1,3,CellP(_xlpm.A1))", "", false),
    (7, 157, "LET(A1,3,__INVOKE__(\"CellP\",LAMBDA(E5,[A1],IF(ISOMITTED(A1),E5,E5+A1)),A1,A1))", "_xlfn.LET(_xlpm.A1,3,CellP(_xlpm.A1,_xlpm.A1))", "", false),
    (7, 158, "__INVOKE__(\"CellP\",LAMBDA(E5,[A1],IF(ISOMITTED(A1),E5,E5+A1)),A1:.A5)", "CellP(_xlfn._TRO_TRAILING(A1:A5))", "", false),
    (7, 160, "__INVOKE__(\"Opt\",LAMBDA(x,[y],IF(ISOMITTED(y),x,x+y)),SUM(1:.3))", "Opt(SUM(_xlfn._TRO_TRAILING(1:3)))", "", false),
    (7, 161, "__INVOKE__(\"Opt\",LAMBDA(x,[y],IF(ISOMITTED(y),x,x+y)),SUM(A:.C))", "Opt(SUM(_xlfn._TRO_TRAILING(A:C)))", "", false),
    (7, 162, "LET(E5,2,__INVOKE__(\"CellP\",LAMBDA(E5,[A1],IF(ISOMITTED(A1),E5,E5+A1)),E5,E5))", "_xlfn.LET(_xlpm.E5,2,CellP(_xlpm.E5,_xlpm.E5))", "", false),
    (7, 163, "LAMBDA(A1,__INVOKE__(\"CellP\",LAMBDA(E5,[A1],IF(ISOMITTED(A1),E5,E5+A1)),A1))(4)", "_xlfn.LAMBDA(_xlpm.A1,CellP(_xlpm.A1))(4)", "", false),
    (7, 164, "__INVOKE__(\"Pick\",LAMBDA([a],[b],IF(ISOMITTED(a),IF(ISOMITTED(b),0,b),a)),,)", "Pick(,)", "", false),
    (7, 165, "__INVOKE__(\"Pick\",LAMBDA([a],[b],IF(ISOMITTED(a),IF(ISOMITTED(b),0,b),a)),LAMBDA(x,x)(5))", "Pick(_xlfn.LAMBDA(_xlpm.x,_xlpm.x)(5))", "", false),
    (7, 166, "LET(x,__INVOKE__(\"Opt\",LAMBDA(x,[y],IF(ISOMITTED(y),x,x+y)),1,2),__INVOKE__(\"Opt\",LAMBDA(x,[y],IF(ISOMITTED(y),x,x+y)),x,x))", "_xlfn.LET(_xlpm.x,Opt(1,2),Opt(_xlpm.x,_xlpm.x))", "", false),
    (7, 167, "__INVOKE__(\"Opt\",LAMBDA(x,[y],IF(ISOMITTED(y),x,x+y)),LET(Opt,2,Opt),1)", "Opt(_xlfn.LET(_xlpm.Opt,2,_xlpm.Opt),1)", "", false),
    (7, 168, "BYROW(A1:B2,LAMBDA(r,__INVOKE__(\"Opt\",LAMBDA(x,[y],IF(ISOMITTED(y),x,x+y)),SUM(r))))", "_xlfn.BYROW(A1:B2,_xlfn.LAMBDA(_xlpm.r,Opt(SUM(_xlpm.r))))", "", false),
    (7, 169, "SUM(__INVOKE__(\"Seq\",LAMBDA(n,SEQUENCE(n)),__INVOKE__(\"Dbl\",LAMBDA(x,x*2),2)))", "SUM(Seq(Dbl(2)))", "", false),
    (7, 170, "SUM(Table2[@[My Col]:[Q'[1']]])", "SUM(Table2[[#This Row],[My Col]:[Q'[1']]])", "", true),
    (7, 171, "SUM(Table2[@[a''b]:[x'#y]])", "SUM(Table2[[#This Row],[a''b]:[x'#y]])", "", true),
    (7, 172, "SUM(Table2[[#This Row],[My Col]:[x'#y]])", "SUM(Table2[[#This Row],[My Col]:[x'#y]])", "", true),
    (7, 173, "SUM(Table2[[#Data],[x'#y]])", "SUM(Table2[[#Data],[x'#y]])", "", true),
    (7, 174, "SUM(Table2[[#Headers],[x'#y]])", "SUM(Table2[[#Headers],[x'#y]])", "", true),
    (7, 175, "COUNTA(Table2[[#Headers],[x'#y]])", "COUNTA(Table2[[#Headers],[x'#y]])", "", true),
    (7, 176, "COUNTA(Table2[[#Headers],[#Data],[x'#y]])", "COUNTA(Table2[[#Headers],[#Data],[x'#y]])", "", true),
    (7, 177, "LET(Table2,1,SUM(Table2[@[x'#y]])+Table2)", "_xlfn.LET(_xlpm.Table2,1,SUM(Table2[[#This Row],[x'#y]])+_xlpm.Table2)", "", true),
    (7, 178, "LAMBDA(r,SUM(Table2[@[x'#y]])*r)(2)", "_xlfn.LAMBDA(_xlpm.r,SUM(Table2[[#This Row],[x'#y]])*_xlpm.r)(2)", "", true),
    (7, 179, "SUM(Table2[[#All],[My Col]:[x'#y]])", "SUM(Table2[[#All],[My Col]:[x'#y]])", "", true),
    (7, 180, "SUM(Table2[@[My Col]],Table2[@[x'#y]])", "SUM(Table2[[#This Row],[My Col]],Table2[[#This Row],[x'#y]])", "", true),
    (7, 182, "SUM(Table2[@[Q'[1']]])", "SUM(Table2[[#This Row],[Q'[1']]])", "", true),
    (7, 183, "SUM(Table2[Q'[1']])", "SUM(Table2[Q'[1']])", "", true),
    (7, 184, "SUM(Table2[a''b])", "SUM(Table2[a''b])", "", true),
    (7, 185, "SUM(Table2[[#This Row],[a''b]])", "SUM(Table2[[#This Row],[a''b]])", "", true),
    (7, 186, "SUM(Table2[@[x'#y]:[Q'[1']]])", "SUM(Table2[[#This Row],[x'#y]:[Q'[1']]])", "", true),
    (7, 187, "SUM(Table3['#n])", "SUM(Table3['#n])", "", true),
    (7, 188, "SUM(Table3[@['#n]])", "SUM(Table3[[#This Row],['#n]])", "", true),
    (7, 189, "SUM(Table3[[#This Row],['#n]])", "SUM(Table3[[#This Row],['#n]])", "", true),
    (7, 190, "SUM(Table3[a b'#c])", "SUM(Table3[a b'#c])", "", true),
    (7, 191, "SUM(Table3[@[a b'#c]])", "SUM(Table3[[#This Row],[a b'#c]])", "", true),
    (7, 192, "SUM(Table3[[#All],[a b'#c]])", "SUM(Table3[[#All],[a b'#c]])", "", true),
    (7, 193, "SUM(Table3[z'''#])", "SUM(Table3[z'''#])", "", true),
    (7, 194, "SUM(Table3[@[z'''#]])", "SUM(Table3[[#This Row],[z'''#]])", "", true),
    (7, 195, "SUM(Table3[@['#n]:[z'''#]])", "SUM(Table3[[#This Row],['#n]:[z'''#]])", "", true),
    (7, 196, "SUM(Table3[['#n]:[a b'#c]])", "SUM(Table3[['#n]:[a b'#c]])", "", true),
    (7, 197, "ROWS(Table3[#Data])", "ROWS(Table3[#Data])", "", true),
    (7, 198, "ROWS(Table3[[#Headers],[#Data]])", "ROWS(Table3[[#Headers],[#Data]])", "", true),
    (7, 199, "COUNTA(Table3[#Headers])", "COUNTA(Table3[#Headers])", "", true),
    (7, 200, "LET(x,1,SUM(Table3[@[a b'#c]])*x)", "_xlfn.LET(_xlpm.x,1,SUM(Table3[[#This Row],[a b'#c]])*_xlpm.x)", "", true),
    (7, 201, "LAMBDA(n,SUM(Table3['#n])*n)(2)", "_xlfn.LAMBDA(_xlpm.n,SUM(Table3['#n])*_xlpm.n)(2)", "", true),
    (7, 202, "MAP(Table3['#n],LAMBDA(v,v*2))", "_xlfn.MAP(Table3['#n],_xlfn.LAMBDA(_xlpm.v,_xlpm.v*2))", "", true),
    (7, 203, "SUM(Table2[x'#y]:Table2[Q'[1']])", "SUM(Table2[x'#y]:Table2[Q'[1']])", "", true),
    (7, 204, "SUM(Table2[@[x'#y]]:Table2[@[Q'[1']]])", "SUM(Table2[[#This Row],[x'#y]]:Table2[[#This Row],[Q'[1']]])", "", true),
    (7, 205, "SUM(Table2[@[My Col]] Table2[My Col])", "SUM(Table2[[#This Row],[My Col]] Table2[My Col])", "", true),
    (7, 206, "@Table2[x'#y]", "Table2[x'#y]", "_xlfn.SINGLE(TABLE2[x'#y])", true),
    (7, 207, "SUM(Table2[x'#y] 2:2)", "SUM(Table2[x'#y] 2:2)", "", true),
    (7, 210, "SUM(Table2[[#This Row]])", "SUM(Table2[#This Row])", "", true),
    (7, 212, "LET(t,Table2[x'#y],SUM(t))", "_xlfn.LET(_xlpm.t,Table2[x'#y],SUM(_xlpm.t))", "", true),
    (7, 213, "SUM(Table2[[#Totals],[x'#y]])", "SUM(Table2[[#Totals],[x'#y]])", "", true),
    (8, 7, "LAMBDA(A1,A1)(B1)", "_xlfn.LAMBDA(_xlpm.A1,_xlpm.A1)(_xlnm.B1)", "", true),
    (8, 8, "LAMBDA(A1,A1*2)(B1+1)", "_xlfn.LAMBDA(_xlpm.A1,_xlpm.A1*2)(_xlnm.B1+1)", "", true),
    (8, 9, "LAMBDA(x,x)(B1)", "_xlfn.LAMBDA(_xlpm.x,_xlpm.x)(B1)", "", true),
    (8, 10, "LET(A1,1,B1+A1)", "_xlfn.LET(_xlpm.A1,1,_xlnm.B1+_xlpm.A1)", "", true),
    (8, 11, "LET(E5,1,E5+B2)", "_xlfn.LET(_xlpm.E5,1,_xlpm.E5+_xlnm.B2)", "", true),
    (8, 12, "LAMBDA(A1,A1)(B1)+B1", "_xlfn.LAMBDA(_xlpm.A1,_xlpm.A1)(_xlnm.B1)+_xlnm.B1", "", true),
    (8, 13, "LAMBDA(E5,E5)(C2)", "_xlfn.LAMBDA(_xlpm.E5,_xlpm.E5)($B:$B)", "", false),
    (8, 14, "LET(f,LAMBDA(A1,A1),f(B1))", "_xlfn.LET(_xlpm.f,_xlfn.LAMBDA(_xlpm.A1,_xlpm.A1),_xlpm.f(_xlnm.B1))", "", true),
    (8, 15, "LET(f,LAMBDA(A1,A1),f(B1)+C3)", "_xlfn.LET(_xlpm.f,_xlfn.LAMBDA(_xlpm.A1,_xlpm.A1),_xlpm.f(_xlnm.B1)+$C:$C)", "", false),
    (8, 16, "LET(a,A1,SUM(a:C))", "_xlfn.LET(_xlpm.a,_xlnm.A1,SUM(_xlpm.a:J:J))", "", true),
    (8, 17, "LET(a,B2,a+C)", "_xlfn.LET(_xlpm.a,_xlnm.B2,_xlpm.a+J:J)", "", false),
    (8, 18, "LET(a,A1,a+B1)", "_xlfn.LET(_xlpm.a,A1,_xlpm.a+B1)", "", true),
    (8, 19, "LET(a,B2,SUM(a:B))", "_xlfn.LET(_xlpm.a,B2,SUM(_xlpm.a:B))", "", true),
    (8, 20, "LAMBDA(A1,A1)(B1:B2)", "_xlfn.LAMBDA(_xlpm.A1,_xlpm.A1)(_xlnm.B1:_xlnm.B2)", "", true),
    (8, 21, "LAMBDA([A1],A1)(B1)", "_xlfn.LAMBDA(_xlop.A1,_xlpm.A1)(_xlnm.B1)", "", true),
    (8, 22, "LAMBDA(x,[A1],x)(B1)", "_xlfn.LAMBDA(_xlpm.x,_xlop.A1,_xlpm.x)(_xlnm.B1)", "", true),
    (8, 23, "LAMBDA(x,LAMBDA(A1,A1)(x))(B1)", "_xlfn.LAMBDA(_xlpm.x,_xlfn.LAMBDA(_xlpm.A1,_xlpm.A1)(_xlpm.x))(_xlnm.B1)", "", true),
    (8, 24, "SUM(B1,LAMBDA(A1,A1)(2))", "SUM(_xlnm.B1,_xlfn.LAMBDA(_xlpm.A1,_xlpm.A1)(2))", "", true),
    (8, 25, "LET(A1,1,A1)+B1", "_xlfn.LET(_xlpm.A1,1,_xlpm.A1)+_xlnm.B1", "", true),
    (8, 26, "LET(x,LAMBDA(A1,A1),B1+x(1))", "_xlfn.LET(_xlpm.x,_xlfn.LAMBDA(_xlpm.A1,_xlpm.A1),_xlnm.B1+_xlpm.x(1))", "", true),
    (8, 27, "LAMBDA([A1],SUM(Sheet1!A1))(1)", "_xlfn.LAMBDA(_xlop.A1,SUM(Sheet1!_xlnm.A1))(1)", "", true),
    (8, 28, "LAMBDA(x,[E5],x+Sheet1!E5)(1)", "_xlfn.LAMBDA(_xlpm.x,_xlop.E5,_xlpm.x+Sheet1!_xlnm.E5)(1)", "", true),
    (8, 29, "LAMBDA([E5],E5+E6)(1)", "_xlfn.LAMBDA(_xlop.E5,_xlpm.E5+_xlnm.E6)(1)", "", true),
    (8, 30, "LAMBDA([A1],A1)(A1)", "_xlfn.LAMBDA(_xlop.A1,_xlpm.A1)(_xlnm.A1)", "", true),
    (8, 31, "LAMBDA(A1,A1)(A1)", "_xlfn.LAMBDA(_xlpm.A1,_xlpm.A1)(_xlnm.A1)", "", true),
    (8, 32, "LET(x,B1,LAMBDA(A1,A1)(x))", "_xlfn.LET(_xlpm.x,_xlnm.B1,_xlfn.LAMBDA(_xlpm.A1,_xlpm.A1)(_xlpm.x))", "", true),
    (8, 43, "SUM(Sheet2!$A:.$C)", "SUM(_xlfn._TRO_TRAILING(Sheet2!$A:$C))", "", true),
    (8, 44, "SUM('My Sheet'!A:.$B)", "SUM(_xlfn._TRO_TRAILING('My Sheet'!A:$B))", "", true),
    (8, 45, "SUM($A.:.$C)", "SUM(_xlfn._TRO_ALL($A:$C))", "", true),
    (8, 46, "SUM(A.:$C)", "SUM(_xlfn._TRO_LEADING(A:$C))", "", true),
    (8, 47, "LET(a,1,SUM($A:.C)+a)", "_xlfn.LET(_xlpm.a,1,SUM(_xlfn._TRO_TRAILING($A:C))+_xlpm.a)", "", true),
    (8, 48, "SUM($B:.$R)", "SUM(_xlfn._TRO_TRAILING($B:$R))", "", true),
    (8, 49, "SUM(A$1:.C$5)", "SUM(_xlfn._TRO_TRAILING(A$1:C$5))", "", true),
    (8, 50, "ROWS(Table1[[#Headers],[#Data]])", "ROWS(Table1[[#Headers],[#Data]])", "", true),
    (8, 51, "ROWS(Table2[[#Headers],[#Data]])", "ROWS(Table2[[#Headers],[#Data]])", "", true),
    (8, 52, "ROWS(Table3[[#Data],[#Totals]])", "ROWS(Table3[[#Data],[#Totals]])", "", true),
    (8, 53, "ROWS(Table3[[#Headers],[#Data],['#n]])", "ROWS(Table3[[#Headers],[#Data],['#n]])", "", true),
    (8, 54, "ROWS(Table3[[#All]])", "ROWS(Table3[#All])", "", true),
    (8, 55, "ROWS(Table3[[#Data]])", "ROWS(Table3[#Data])", "", true),
    (8, 56, "ROWS(Table3[[#Headers]])", "ROWS(Table3[#Headers])", "", true),
    (8, 57, "SUM(Table3[[#This Row],['#n]])", "SUM(Table3[[#This Row],['#n]])", "", true),
    (8, 58, "COUNTA(Table3[[#Headers],['#n]])", "COUNTA(Table3[[#Headers],['#n]])", "", true),
    (8, 59, "COUNTA(Table2[[#Headers],[My Col]])", "COUNTA(Table2[[#Headers],[My Col]])", "", true),
    (8, 60, "SUM(Översikt!A1:.A3)", "SUM(_xlfn._TRO_TRAILING(Översikt!A1:A3))", "", true),
    (8, 61, "LET(x,1,SUM(Översikt!A:.B)+x)", "_xlfn.LET(_xlpm.x,1,SUM(_xlfn._TRO_TRAILING(Översikt!A:B))+_xlpm.x)", "", true),
    (8, 62, "LET(Översikt,1,Översikt!A1+Översikt)", "_xlfn.LET(_xlpm.Översikt,1,Översikt!A1+_xlpm.Översikt)", "", true),
    (8, 63, "LET(Table3,1,SUM(Table3['#n])+Table3)", "_xlfn.LET(_xlpm.Table3,1,SUM(Table3['#n])+_xlpm.Table3)", "", true),
    (9, 7, "ROWS(GROUPBY(A1:A5,B1:B5,SUM))", "ROWS(_xlfn.GROUPBY(A1:A5,B1:B5,_xleta.SUM))", "", true),
    (9, 8, "ROWS(PIVOTBY(A1:A5,A1:A5,B1:B5,SUM))", "ROWS(_xlfn.PIVOTBY(A1:A5,A1:A5,B1:B5,_xleta.SUM))", "", true),
    (9, 9, "LET(t,TRIMRANGE(A1:A9),ROWS(t))", "_xlfn.LET(_xlpm.t,_xlfn.TRIMRANGE(A1:A9),ROWS(_xlpm.t))", "", true),
    (9, 10, "SUM(BYROW(A1:C2,SUM))", "SUM(_xlfn.BYROW(A1:C2,_xleta.SUM))", "", true),
    (9, 11, "SUM(MAP(A1:A3,ABS))", "SUM(_xlfn.MAP(A1:A3,_xleta.ABS))", "", true),
    (9, 12, "SUM(TRIMRANGE(A1:C9,2,2))", "SUM(_xlfn.TRIMRANGE(A1:C9,2,2))", "SUM(_xlfn._TRO_TRAILING(A1:C9))", true),
    (9, 13, "LET(a,1,SUM(TRIMRANGE(A:C))+a)", "_xlfn.LET(_xlpm.a,1,SUM(_xlfn.TRIMRANGE(_xlpm.a:J:J))+_xlpm.a)", "", true),
    (9, 14, "ROWS(TOCOL(A1:B2))", "ROWS(_xlfn.TOCOL(A1:B2))", "", true),
    (9, 15, "SUM(Sheet2!$A$1:.$A$3)", "SUM(_xlfn._TRO_TRAILING(Sheet2!$A$1:$A$3))", "", true),
    (9, 16, "SUM(Sheet2!A$1:.A$3)", "SUM(_xlfn._TRO_TRAILING(Sheet2!A$1:A$3))", "", true),
    (9, 17, "SUM($A1:.$A5)", "SUM(_xlfn._TRO_TRAILING($A1:$A5))", "", true),
    (10, 1805, "SUM(MAP(A1:A3,ABS))", "SUM(_xlfn.MAP(A1:A3,_xleta.ABS))", "", true),
    (10, 1806, "LET(f,ABS,f(-1))", "_xlfn.LET(_xlpm.f,_xleta.ABS,_xlpm.f(-1))", "", true),
    (10, 1807, "LET(f,SUM,f(A1:A3))", "_xlfn.LET(_xlpm.f,_xleta.SUM,_xlpm.f(A1:A3))", "", true),
    (10, 1808, "SUM(MAP(A1:A3,abs))", "SUM(_xlfn.MAP(A1:A3,_xleta.ABS))", "", true),
    (10, 1809, "SUM(BYROW(A1:C2,MAX))", "SUM(_xlfn.BYROW(A1:C2,_xleta.MAX))", "", true),
    (10, 1810, "REDUCE(0,A1:A3,SUM)", "_xlfn.REDUCE(0,A1:A3,_xleta.SUM)", "", true),
    (10, 1811, "ABS", "_xleta.ABS", "", true),
    (10, 1812, "ABS+1", "_xleta.ABS+1", "", true),
    (10, 1813, "N", "_xleta.N", "", true),
    (10, 1814, "LAMBDA(f,f(-2))(ABS)", "_xlfn.LAMBDA(_xlpm.f,_xlpm.f(-2))(_xleta.ABS)", "", true),
    (10, 1815, "SUM(MAP(A1:A3,Dbl))", "SUM(_xlfn.MAP(A1:A3,Dbl))", "", true),
    (10, 1816, "SUM(MAP(A1:A3,T))", "SUM(_xlfn.MAP(A1:A3,_xleta.T))", "", true),
    (10, 1817, "SUM(MAP(A1:A3,LEN))", "SUM(_xlfn.MAP(A1:A3,_xleta.LEN))", "", true),
    (10, 1818, "COUNTA(MAP(A1:A3,ISNUMBER))", "COUNTA(_xlfn.MAP(A1:A3,_xleta.ISNUMBER))", "", true),
    (10, 1819, "LET(x,1,x)+SUM", "_xlfn.LET(_xlpm.x,1,_xlpm.x)+_xleta.SUM", "", true),
    (10, 1820, "IF(TRUE,ABS,SUM)", "IF(TRUE,_xleta.ABS,_xleta.SUM)", "", true),
    (10, 1821, "ROWS(GROUPBY(A1:A5,B1:B5,SUM))", "ROWS(_xlfn.GROUPBY(A1:A5,B1:B5,_xleta.SUM))", "", true),
    (10, 1822, "ROWS(GROUPBY(A1:A5,B1:B5,LAMBDA(x,SUM(x))))", "ROWS(_xlfn.GROUPBY(A1:A5,B1:B5,_xlfn.LAMBDA(_xlpm.x,SUM(_xlpm.x))))", "", true),
    (10, 1823, "SUM(BYCOL(A1:C2,SUM))", "SUM(_xlfn.BYCOL(A1:C2,_xleta.SUM))", "", true),
    (10, 1824, "ISOMITTED", "_xleta.ISOMITTED", "", true),
    (10, 1825, "LET(sum,1,MAP(A1:A3,SUM))", "_xlfn.LET(_xlpm.sum,1,_xlfn.MAP(A1:A3,_xlpm.sum))", "", true),
    (10, 1826, "SUM(MAP(A1:A3,Sheet2!A1))", "SUM(_xlfn.MAP(A1:A3,Sheet2!A1))", "", true),
    (10, 1827, "MAKEARRAY(2,2,PRODUCT)", "_xlfn.MAKEARRAY(2,2,_xleta.PRODUCT)", "", true),
    (10, 1828, "SCAN(0,A1:A3,SUM)", "_xlfn.SCAN(0,A1:A3,_xleta.SUM)", "", true),
    (10, 1829, "C+A1", "J:J+_xlnm.A1", "", false),
    (10, 1830, "A1+C", "_xlnm.A1+J:J", "", false),
    (10, 1831, "LET(a,1,a+R)+B1", "_xlfn.LET(_xlpm.a,1,_xlpm.a+1831:1831)+_xlnm.B1", "", false),
    (10, 1832, "LET(A1,1,A1+C2)", "_xlfn.LET(_xlpm.A1,1,_xlpm.A1+$B:$B)", "", false),
    (10, 1833, "LET(A1,1,A1+R2)", "_xlfn.LET(_xlpm.A1,1,_xlpm.A1+$2:$2)", "", false),
    (10, 1834, "LET(A1,1,A1+R1C1)", "_xlfn.LET(_xlpm.A1,1,_xlpm.A1+$A$1)", "", false),
    (10, 1835, "LET(A1,1,A1+RC1)", "_xlfn.LET(_xlpm.A1,1,_xlpm.A1+$A1835)", "", false),
    (10, 1836, "LET(A1,1,A1+Sheet2!B1)", "_xlfn.LET(_xlpm.A1,1,_xlpm.A1+Sheet2!_xlnm.B1)", "", true),
    (10, 1837, "LET(A1,1,A1+SUM(B1:B2))", "_xlfn.LET(_xlpm.A1,1,_xlpm.A1+SUM(_xlnm.B1:_xlnm.B2))", "", true),
    (10, 1838, "LET(A1,1,A1+SUM(A:A))", "_xlfn.LET(_xlpm.A1,1,_xlpm.A1+SUM(A:(A)))", "", true),
    (10, 1840, "LET(A1,1,A1+SUM(Table1[Col]))", "_xlfn.LET(_xlpm.A1,1,_xlpm.A1+SUM(Table1[Col]))", "", true),
    (10, 1843, "LET(A1,1,A1+'My Sheet'!B1)", "_xlfn.LET(_xlpm.A1,1,_xlpm.A1+'My Sheet'!_xlnm.B1)", "", true),
    (10, 1844, "LET(A1,1,A1+D1)", "_xlfn.LET(_xlpm.A1,1,_xlpm.A1+_xlnm.D1)", "", true),
    (10, 1845, "LET(A1,1,A1+AB10)", "_xlfn.LET(_xlpm.A1,1,_xlpm.A1+_xlnm.AB10)", "", true),
    (10, 1846, "LET(A1,1,A1+SUM(B:B))", "_xlfn.LET(_xlpm.A1,1,_xlpm.A1+SUM(B:(B)))", "", true),
    (10, 1847, "LET(A1,1,A1+SUM(D:D))", "_xlfn.LET(_xlpm.A1,1,_xlpm.A1+SUM(D:(D)))", "", true),
    (10, 1850, "LET(A1,1,A1+SUM(Sheet2!A:A))", "_xlfn.LET(_xlpm.A1,1,_xlpm.A1+SUM(Sheet2!A:(A)))", "", true),
    (10, 1851, "LET(A1,1,A1)+SUM(C:C)", "_xlfn.LET(_xlpm.A1,1,_xlpm.A1)+SUM(J:J)", "", false),
    (10, 1852, "LET(A1,1,A1)+RC", "_xlfn.LET(_xlpm.A1,1,_xlpm.A1)+J1852", "", false),
    (10, 1853, "LET(A1,1,A1)+C", "_xlfn.LET(_xlpm.A1,1,_xlpm.A1)+J:J", "", false),
    (10, 1854, "C+Sheet2!A1", "J:J+Sheet2!_xlnm.A1", "", false),
    (10, 1855, "C+SUM(B1:B3)", "J:J+SUM(_xlnm.B1:_xlnm.B3)", "", false),
    (10, 1856, "R+A2", "1856:1856+_xlnm.A2", "", false),
    (10, 1857, "RC*0+B1", "J1857*0+_xlnm.B1", "", false),
    (10, 1858, "LET(x,1,x+C)+A1", "_xlfn.LET(_xlpm.x,1,_xlpm.x+J:J)+_xlnm.A1", "", false),
    (10, 1861, "SUM(C,A:A)", "SUM(J:J,A:(A))", "", false),
    (10, 1863, "C+Table1[Col]", "J:J+Table1[Col]", "", false),
    (10, 1865, "LET(x,1,y)", "_xlfn.LET(_xlpm.x,1,y)", "", true),
    (10, 1868, "LAMBDA(1)", "_xlfn.LAMBDA(1)", "", true),
    (10, 1869, "LAMBDA(x,1)(2)", "_xlfn.LAMBDA(_xlpm.x,1)(2)", "", true),
    (10, 1870, "LAMBDA(x,y,x)(1)", "_xlfn.LAMBDA(_xlpm.x,_xlpm.y,_xlpm.x)(1)", "", true),
    (10, 1871, "LAMBDA(x,x)(1,2)", "_xlfn.LAMBDA(_xlpm.x,_xlpm.x)(1,2)", "", true),
    (10, 1872, "LAMBDA(x,x)()", "_xlfn.LAMBDA(_xlpm.x,_xlpm.x)()", "", true),
    (10, 1873, "\"_xlfn.\"&SEQUENCE(2)", "\"_xlfn.\"&_xlfn.SEQUENCE(2)", "", true),
    (10, 1874, "\"_xlfn.\"&TEXTJOIN(\",\",TRUE,A1:A3)", "\"_xlfn.\"&_xlfn.TEXTJOIN(\",\",TRUE,A1:A3)", "", true),
    (10, 1875, "SUM(TRIMRANGE(A1:C9,2,2))", "SUM(_xlfn.TRIMRANGE(A1:C9,2,2))", "SUM(_xlfn._TRO_TRAILING(A1:C9))", true),
    (10, 1876, "SUM(TRIMRANGE(A1:C9))", "SUM(_xlfn.TRIMRANGE(A1:C9))", "", true),
    (11, 94, "SUM(MAP(A1:A3,IFNA))", "SUM(_xlfn.MAP(A1:A3,_xleta.IFNA))", "", true),
    (11, 95, "LET(f,XLOOKUP,1)", "_xlfn.LET(_xlpm.f,_xleta.XLOOKUP,1)", "", true),
    (11, 96, "LET(f,FILTER,1)", "_xlfn.LET(_xlpm.f,_xleta.FILTER,1)", "", true),
    (11, 97, "LET(f,SEQUENCE,f(2))", "_xlfn.LET(_xlpm.f,_xleta.SEQUENCE,_xlpm.f(2))", "", true),
    (11, 98, "LET(f,LPAD,1)", "_xlfn.LET(_xlpm.f,LPAD,1)", "", true),
    (11, 99, "LET(f,TRIMRANGE,1)", "_xlfn.LET(_xlpm.f,_xleta.TRIMRANGE,1)", "", true),
    (11, 100, "LET(f,CONCAT,f(1,2))", "_xlfn.LET(_xlpm.f,_xleta.CONCAT,_xlpm.f(1,2))", "", true),
    (11, 101, "SUM(MAP(A1:A3,STDEV.S))", "SUM(_xlfn.MAP(A1:A3,_xleta.STDEV.S))", "", true),
    (11, 102, "LET(f,SORT,1)", "_xlfn.LET(_xlpm.f,_xleta.SORT,1)", "", true),
    (11, 103, "C+SUM(A:B)", "J:J+SUM(A:(B))", "", false),
    (11, 104, "C+Sheet2!C2", "J:J+Sheet2!$B:$B", "", false),
    (11, 105, "C+SUM(A1:C2)", "J:J+SUM(_xlnm.A1:$B:$B)", "", false),
    (11, 106, "LAMBDA(x,x)+C", "_xlfn.LAMBDA(_xlpm.x,_xlpm.x)+J:J", "", false),
    (11, 107, "LET(A1,1,A1+SUM(A:B))", "_xlfn.LET(_xlpm.A1,1,_xlpm.A1+SUM(A:(B)))", "", true),
    (11, 108, "LET(A1,1,A1+SUM(A:C))", "_xlfn.LET(_xlpm.A1,1,_xlpm.A1+SUM(A:J:J))", "", false),
    (11, 109, "LET(A1,1,A1+A1#)", "_xlfn.LET(_xlpm.A1,1,_xlpm.A1+_xlfn.ANCHORARRAY(_xlpm.A1))", "", true),
    (11, 110, "LET(A1,1,A1+B1#)", "_xlfn.LET(_xlpm.A1,1,_xlpm.A1+_xlfn.ANCHORARRAY(_xlnm.B1))", "", true),
    (11, 112, "LET(A1,1,A1+Table1[@Col])", "_xlfn.LET(_xlpm.A1,1,_xlpm.A1+Table1[[#This Row],[Col]])", "", true),
    (11, 113, "LET(A1,1,A1+SUM(Sheet1:Sheet2!B1))", "_xlfn.LET(_xlpm.A1,1,_xlpm.A1+SUM(Sheet1:Sheet2!_xlnm.B1))", "", true),
    (11, 114, "LET(A1,1,A1+SUM(Sheet2!B1:C2))", "_xlfn.LET(_xlpm.A1,1,_xlpm.A1+SUM(Sheet2!_xlnm.B1:$B:$B))", "", false),
    (11, 115, "LAMBDA([A1],A1)(B1)", "_xlfn.LAMBDA(_xlop.A1,_xlpm.A1)(_xlnm.B1)", "", true),
    (11, 117, "LET(A1,1,A1+B1 C1)", "_xlfn.LET(_xlpm.A1,1,_xlpm.A1+_xlnm.B1 $A:$A)", "", false),
    (11, 118, "LET(A1,1,A1)+N(Sheet2!A:A)", "_xlfn.LET(_xlpm.A1,1,_xlpm.A1)+N(Sheet2!A:(A))", "", true),
    (11, 119, "SUM(MAP(A1:A3,Opt))", "SUM(_xlfn.MAP(A1:A3,Opt))", "", true),
    (11, 120, "LET(sum,1,sum+SUM)", "_xlfn.LET(_xlpm.sum,1,_xlpm.sum+_xlpm.sum)", "", true),
    // Set 13: lane legacystats (2026-11-05, SCRATCH/legacystats/p1.json). Excel's
    // compatibility functions keep their own names in the file, with no
    // `_xlfn.` prefix (`NORMSDIST(1.5)`, `TDIST(1.5,10,1)`), and the modern
    // spellings of the same functions keep theirs (`_xlfn.STDEV.P`). Calcula
    // stored the one under the other's name, so the file said `_xlfn.T.DIST`
    // for TDIST, `STDEVP` for STDEV.P, and a NORMSDIST cell kept only its value.
    // (Probed over its own data, A1:A6 = 2,4,4,5,7,9 and B1:B6 = 3,5,8,6,10,12;
    // no row's text depends on it. Excel's VALUES are pinned in
    // `engine::legacy_stats_tests`.) SABOTAGE (legacystats-name): NORMSDIST stored
    // as NORM.S.DIST -- J2 / J3 written `<NO FORMULA>`; (legacystats-alias):
    // STDEV.P as STDEVP -- J71 written `STDEVP(A1:A6)` for `_xlfn.STDEV.P`.
    (13, 2, "NORMSDIST(1.5)", "NORMSDIST(1.5)", "", true),
    (13, 3, "NORMSDIST(-0.7)", "NORMSDIST(-0.7)", "", true),
    (13, 4, "NORMSINV(0.9)", "NORMSINV(0.9)", "", true),
    (13, 5, "NORMDIST(1.2,0.5,2,TRUE)", "NORMDIST(1.2,0.5,2,TRUE)", "", true),
    (13, 6, "NORMDIST(1.2,0.5,2,FALSE)", "NORMDIST(1.2,0.5,2,FALSE)", "", true),
    (13, 7, "NORMINV(0.3,1,2)", "NORMINV(0.3,1,2)", "", true),
    (13, 8, "TDIST(1.5,10,1)", "TDIST(1.5,10,1)", "", true),
    (13, 9, "TDIST(1.5,10,2)", "TDIST(1.5,10,2)", "", true),
    (13, 10, "TDIST(-1,10,1)", "TDIST(-1,10,1)", "", true),
    (13, 11, "TDIST(1.5,10.7,1.9)", "TDIST(1.5,10.7,1.9)", "", true),
    (13, 12, "TDIST(1.5,10,3)", "TDIST(1.5,10,3)", "", true),
    (13, 13, "TDIST(1.5,0.5,1)", "TDIST(1.5,0.5,1)", "", true),
    (13, 14, "TDIST(0,10,2)", "TDIST(0,10,2)", "", true),
    (13, 15, "TINV(0.1,10)", "TINV(0.1,10)", "", true),
    (13, 16, "TTEST(A1:A6,B1:B6,2,2)", "TTEST(A1:A6,B1:B6,2,2)", "", true),
    (13, 17, "FDIST(2,5,10)", "FDIST(2,5,10)", "", true),
    (13, 18, "FDIST(2,5.9,10.9)", "FDIST(2,5.9,10.9)", "", true),
    (13, 19, "FDIST(-1,5,10)", "FDIST(-1,5,10)", "", true),
    (13, 20, "FINV(0.05,5,10)", "FINV(0.05,5,10)", "", true),
    (13, 21, "FTEST(A1:A6,B1:B6)", "FTEST(A1:A6,B1:B6)", "", true),
    (13, 22, "CHIDIST(3,4)", "CHIDIST(3,4)", "", true),
    (13, 23, "CHIDIST(3,4.9)", "CHIDIST(3,4.9)", "", true),
    (13, 24, "CHIDIST(-1,4)", "CHIDIST(-1,4)", "", true),
    (13, 25, "CHIINV(0.2,4)", "CHIINV(0.2,4)", "", true),
    (13, 26, "CHITEST(A1:A3,B1:B3)", "CHITEST(A1:A3,B1:B3)", "", true),
    (13, 27, "BINOMDIST(3,10,0.4,FALSE)", "BINOMDIST(3,10,0.4,FALSE)", "", true),
    (13, 28, "BINOMDIST(3,10,0.4,TRUE)", "BINOMDIST(3,10,0.4,TRUE)", "", true),
    (13, 29, "CRITBINOM(10,0.4,0.5)", "CRITBINOM(10,0.4,0.5)", "", true),
    (13, 30, "POISSON(3,2.5,TRUE)", "POISSON(3,2.5,TRUE)", "", true),
    (13, 31, "POISSON(3,2.5,FALSE)", "POISSON(3,2.5,FALSE)", "", true),
    (13, 32, "BETADIST(0.4,2,3)", "BETADIST(0.4,2,3)", "", true),
    (13, 33, "BETADIST(2,2,3,1,4)", "BETADIST(2,2,3,1,4)", "", true),
    (13, 34, "BETADIST(0.4,2,3,0)", "BETADIST(0.4,2,3,0)", "", true),
    (13, 35, "BETADIST(5,2,3,1,4)", "BETADIST(5,2,3,1,4)", "", true),
    (13, 36, "BETAINV(0.5,2,3)", "BETAINV(0.5,2,3)", "", true),
    (13, 37, "BETAINV(0.5,2,3,1,4)", "BETAINV(0.5,2,3,1,4)", "", true),
    (13, 38, "GAMMADIST(2,3,1.5,TRUE)", "GAMMADIST(2,3,1.5,TRUE)", "", true),
    (13, 39, "GAMMADIST(2,3,1.5,FALSE)", "GAMMADIST(2,3,1.5,FALSE)", "", true),
    (13, 40, "GAMMAINV(0.5,3,1.5)", "GAMMAINV(0.5,3,1.5)", "", true),
    (13, 41, "WEIBULL(2,1.5,3,TRUE)", "WEIBULL(2,1.5,3,TRUE)", "", true),
    (13, 42, "WEIBULL(2,1.5,3,FALSE)", "WEIBULL(2,1.5,3,FALSE)", "", true),
    (13, 43, "EXPONDIST(0.5,2,TRUE)", "EXPONDIST(0.5,2,TRUE)", "", true),
    (13, 44, "EXPONDIST(0.5,2,FALSE)", "EXPONDIST(0.5,2,FALSE)", "", true),
    (13, 45, "LOGNORMDIST(2,0.5,1)", "LOGNORMDIST(2,0.5,1)", "", true),
    (13, 46, "LOGNORMDIST(0,0.5,1)", "LOGNORMDIST(0,0.5,1)", "", true),
    (13, 47, "LOGINV(0.5,0.5,1)", "LOGINV(0.5,0.5,1)", "", true),
    (13, 48, "HYPGEOMDIST(2,5,10,30)", "HYPGEOMDIST(2,5,10,30)", "", true),
    (13, 49, "HYPGEOMDIST(2.9,5.9,10.9,30.9)", "HYPGEOMDIST(2.9,5.9,10.9,30.9)", "", true),
    (13, 50, "NEGBINOMDIST(3,5,0.4)", "NEGBINOMDIST(3,5,0.4)", "", true),
    (13, 51, "NEGBINOMDIST(3.9,5.9,0.4)", "NEGBINOMDIST(3.9,5.9,0.4)", "", true),
    (13, 52, "CONFIDENCE(0.05,2.5,50)", "CONFIDENCE(0.05,2.5,50)", "", true),
    (13, 53, "COVAR(A1:A6,B1:B6)", "COVAR(A1:A6,B1:B6)", "", true),
    (13, 54, "PERCENTILE(A1:A6,0.3)", "PERCENTILE(A1:A6,0.3)", "", true),
    (13, 55, "QUARTILE(A1:A6,1)", "QUARTILE(A1:A6,1)", "", true),
    (13, 56, "PERCENTRANK(A1:A6,4)", "PERCENTRANK(A1:A6,4)", "", true),
    (13, 57, "RANK(4,A1:A6)", "RANK(4,A1:A6)", "", true),
    (13, 58, "MODE(A1:A6)", "MODE(A1:A6)", "", true),
    (13, 59, "STDEV(A1:A6)", "STDEV(A1:A6)", "", true),
    (13, 60, "STDEVP(A1:A6)", "STDEVP(A1:A6)", "", true),
    (13, 61, "VAR(A1:A6)", "VAR(A1:A6)", "", true),
    (13, 62, "VARP(A1:A6)", "VARP(A1:A6)", "", true),
    (13, 63, "ZTEST(A1:A6,4)", "ZTEST(A1:A6,4)", "", true),
    (13, 64, "ZTEST(A1:A6,4,2)", "ZTEST(A1:A6,4,2)", "", true),
    (13, 65, "Z.TEST(A1:A6,4)", "_xlfn.Z.TEST(A1:A6,4)", "", true),
    (13, 66, "FORECAST(7,B1:B6,A1:A6)", "FORECAST(7,B1:B6,A1:A6)", "", true),
    (13, 67, "CEILING(2.3,0.5)", "CEILING(2.3,0.5)", "", true),
    (13, 68, "FLOOR(2.3,0.5)", "FLOOR(2.3,0.5)", "", true),
    (13, 69, "CEILING(-2.3,-0.5)", "CEILING(-2.3,-0.5)", "", true),
    (13, 70, "FLOOR(-2.3,0.5)", "FLOOR(-2.3,0.5)", "", true),
    (13, 71, "STDEV.P(A1:A6)", "_xlfn.STDEV.P(A1:A6)", "", true),
    (13, 72, "VAR.P(A1:A6)", "_xlfn.VAR.P(A1:A6)", "", true),
    (13, 73, "RANK.EQ(4,A1:A6)", "_xlfn.RANK.EQ(4,A1:A6)", "", true),
    (13, 74, "PERCENTILE.INC(A1:A6,0.3)", "_xlfn.PERCENTILE.INC(A1:A6,0.3)", "", true),
    (13, 75, "QUARTILE.INC(A1:A6,1)", "_xlfn.QUARTILE.INC(A1:A6,1)", "", true),
    (13, 76, "MODE.SNGL(A1:A6)", "_xlfn.MODE.SNGL(A1:A6)", "", true),
    (13, 77, "PERCENTRANK.INC(A1:A6,4)", "_xlfn.PERCENTRANK.INC(A1:A6,4)", "", true),
    (13, 78, "GAMMALN.PRECISE(4.5)", "_xlfn.GAMMALN.PRECISE(4.5)", "", true),
    (13, 79, "GAMMALN(4.5)", "GAMMALN(4.5)", "", true),
    (13, 80, "FORECAST.LINEAR(7,B1:B6,A1:A6)", "_xlfn.FORECAST.LINEAR(7,B1:B6,A1:A6)", "", true),
    (13, 81, "COVARIANCE.P(A1:A6,B1:B6)", "_xlfn.COVARIANCE.P(A1:A6,B1:B6)", "", true),
    (13, 82, "CHISQ.DIST.RT(3,4)", "_xlfn.CHISQ.DIST.RT(3,4)", "", true),
    (13, 83, "POISSONDIST(3,2.5,TRUE)", "POISSONDIST(3,2.5,TRUE)", "", true),
    (13, 84, "CHISQDIST(3,4,TRUE)", "CHISQDIST(3,4,TRUE)", "", true),
    (13, 85, "NORM.S.DIST(1.5,TRUE)", "_xlfn.NORM.S.DIST(1.5,TRUE)", "", true),
    (13, 86, "T.DIST(1.5,10,TRUE)", "_xlfn.T.DIST(1.5,10,TRUE)", "", true),
    (13, 87, "T.DIST.RT(1.5,10)", "_xlfn.T.DIST.RT(1.5,10)", "", true),
    (13, 88, "F.DIST.RT(2,5,10)", "_xlfn.F.DIST.RT(2,5,10)", "", true),
];

/// The defined names sets 4-6 were probed with, as Excel held them (its
/// workbook part reads `<definedName name="Rate">1</definedName>`).
const NAMES: &[(&str, &str)] = &[
    ("Opt", "=LAMBDA(x,[y],IF(ISOMITTED(y),x,x+y))"),
    ("Dbl", "=LAMBDA(x,x*2)"),
    ("Rate", "=1"),
];

fn number(v: f64) -> SavedCell {
    SavedCell { value: SavedCellValue::Number(v), formula: None, style_index: 0, rich_text: None, spill: None }
}

/// The text Calcula stores for a typed formula (`=` included).
fn stored(input: &str) -> Option<String> {
    SavedCell::from_cell(&engine::Cell::new_formula(format!("={}", input))).formula
}

/// One set's workbook: the probe's data, each formula in column J of its row.
fn workbook_of(set: u8) -> Workbook {
    let mut wb = Workbook::new();
    wb.sheets.clear();
    let mut sheet1 = Sheet::new("Sheet1".to_string());
    for i in 0..5u32 {
        sheet1.cells.insert((i, 0), number(f64::from(i + 1)));
        sheet1.cells.insert((i, 1), number(10.0 * f64::from(i + 1)));
        sheet1.cells.insert((i, 2), number(100.0 * f64::from(i + 1)));
    }
    for &(s, row, input, _, _, _) in ROWS.iter().filter(|r| r.0 == set) {
        let cell = SavedCell::from_cell(&engine::Cell::new_formula(format!("={}", input)));
        assert!(cell.formula.is_some(), "set {} J{}: Calcula holds no formula for {}", s, row, input);
        sheet1.cells.insert((row - 1, 9), cell);
    }
    wb.sheets.push(sheet1);
    let mut sheet2 = Sheet::new("Sheet2".to_string());
    sheet2.cells.insert((0, 0), number(7.0));
    wb.sheets.push(sheet2);
    let mut my_sheet = Sheet::new("My Sheet".to_string());
    for (at, v) in [((0, 0), 1.0), ((0, 1), 2.0), ((1, 0), 3.0), ((1, 1), 4.0)] {
        my_sheet.cells.insert(at, number(v));
    }
    wb.sheets.push(my_sheet);
    let mut oversikt = Sheet::new("\u{d6}versikt".to_string());
    oversikt.cells.insert((0, 0), number(5.0));
    wb.sheets.push(oversikt);
    for &(name, refers_to) in NAMES {
        wb.named_ranges.push(crate::SavedNamedRange { name: name.to_string(), refers_to: refers_to.to_string(), sheet_id: None, comment: None, folder: None });
    }
    wb
}

/// XML character data back to text.
fn unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

/// The `<f>` text of cell `address` in a sheet part.
fn formula_of(xml: &str, address: &str) -> Option<String> {
    let at = xml.find(&format!("<c r=\"{}\"", address))?;
    let cell = &xml[at..];
    let cell = &cell[..cell.find("</c>").unwrap_or(cell.len())];
    let f = &cell[cell.find("<f")?..];
    let open = f.find('>')?;
    let close = f.find("</f>")?;
    Some(unescape(&f[open + 1..close]))
}

fn same_ignoring_case(a: &str, b: &str) -> bool {
    a.chars().flat_map(char::to_lowercase).eq(b.chars().flat_map(char::to_lowercase))
}

/// Every row's real export is Excel's own text, and every file reads back to
/// the formula Calcula stored.
#[test]
fn the_real_export_writes_every_formula_as_excel_saves_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut wrong = Vec::new();
    let mut not_back = Vec::new();
    for set in 1..=13u8 {
        let path = dir.path().join(format!("calcula-set{}.xlsx", set));
        crate::save_xlsx(&workbook_of(set), &path).unwrap();
        let mut archive = zip::ZipArchive::new(std::fs::File::open(&path).unwrap()).unwrap();
        let mut xml = String::new();
        archive.by_name("xl/worksheets/sheet1.xml").unwrap().read_to_string(&mut xml).unwrap();
        let back = crate::load_xlsx(&path).unwrap();
        let back_sheet = back.sheets.iter().find(|s| s.name == "Sheet1").unwrap();
        for &(_, row, input, excel, ours, round_trips) in ROWS.iter().filter(|r| r.0 == set) {
            let expected = if ours.is_empty() { excel } else { ours };
            let written = formula_of(&xml, &format!("J{}", row)).unwrap_or_else(|| "<NO FORMULA>".to_string());
            if !same_ignoring_case(&written, expected) {
                wrong.push(format!("  set {} J{}: {}\n    Calcula: {}\n    Excel:   {}", set, row, input, written, expected));
            }
            if round_trips {
                let read = back_sheet.cells.get(&(row - 1, 9)).and_then(|c| c.formula.clone()).unwrap_or_default();
                // The reader's text, as the engine holds it once parsed.
                let held = stored(read.strip_prefix('=').unwrap_or(&read));
                if held != stored(input) {
                    not_back.push(format!("  set {} J{}: {}\n    stored: {:?}\n    read:   {} -> {:?}", set, row, input, stored(input), read, held));
                }
            }
        }
        if let Ok(probe) = std::env::var("CALCULA_XLSX_PROBE_DIR") {
            let _ = std::fs::copy(&path, std::path::Path::new(&probe).join(format!("calcula-set{}.xlsx", set)));
        }
    }
    assert!(wrong.is_empty(), "NOT EXCEL'S SPELLING ({} of {}):\n{}", wrong.len(), ROWS.len(), wrong.join("\n"));
    assert!(not_back.is_empty(), "NOT READ BACK ({}):\n{}", not_back.len(), not_back.join("\n"));
}

/// Excel's own file text, read: each of Excel's spellings comes back as the
/// formula Calcula stores for what the user typed.
#[test]
fn the_reader_turns_every_excel_spelling_back_into_calculas_syntax() {
    let mut wrong = Vec::new();
    for &(set, row, input, excel, ours, round_trips) in ROWS {
        if !round_trips {
            continue;
        }
        // Where Calcula deliberately writes other text (an explicit SINGLE for
        // an `@` Excel's legacy formula leaves implied), that text is what
        // comes back to Calcula.
        let file = if ours.is_empty() { excel } else { ours };
        // As the reader reads it: in its cell, J of the row (a parameter's
        // range to the cell's own column is R1C1's `C` there).
        let read = crate::xlsx_formula_text::calcula_cell_formula_text(file, Some((row - 1, 9)));
        if stored(&read) != stored(input) {
            wrong.push(format!("  set {} J{}: {}\n    Excel's {}\n    read as {} -> {:?}, stored {:?}", set, row, input, excel, read, stored(&read), stored(input)));
        }
    }
    assert!(wrong.is_empty(), "EXCEL'S SPELLING NOT READ BACK ({}):\n{}", wrong.len(), wrong.join("\n"));
}

/// A defined name's table reference is spelled as the table declares it, as
/// a cell's is (`xlsx_tables::respell_table_names`): a name's text the engine
/// re-rendered holds the lexer's `DATA[Q]`, and [LIVE] Excel 16 refused a
/// workbook whose formula read so for a table called Data (lane xlsxtbl).
/// The name's sheetless reference is the using sheet's, relative as the
/// name writes it (`!A1`, NEW-relative-name-anchor).
/// SABOTAGE (xlsxfmt-tblname): the writer skips `respell_table_names` for
/// names -- fails at the first assertion.
#[test]
fn a_defined_names_table_reference_is_spelled_as_the_table_declares_it() {
    let mut wb = workbook_of(0);
    let sheet1 = wb.sheets.iter_mut().find(|s| s.name == "Sheet1").unwrap();
    sheet1.cells.insert((0, 7), SavedCell { value: SavedCellValue::Text("Q".to_string()), formula: None, style_index: 0, rich_text: None, spill: None });
    for r in 1..=3u32 {
        sheet1.cells.insert((r, 7), number(f64::from(r)));
    }
    let sheet_id = sheet1.id;
    wb.tables.push(crate::SavedTable {
        id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
        name: "Data".to_string(),
        sheet_id,
        start_row: 0,
        start_col: 7,
        end_row: 3,
        end_col: 7,
        columns: vec![crate::SavedTableColumn {
            id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            name: "Q".to_string(),
            totals_row_function: "none".to_string(),
            totals_row_formula: None,
            calculated_formula: None,
            totals_row_label: None,
        }],
        style_options: crate::SavedTableStyleOptions {
            banded_rows: true,
            banded_columns: false,
            header_row: true,
            total_row: false,
            first_column: false,
            last_column: false,
            show_filter_button: true,
        },
        style_name: "TableStyleMedium9".to_string(),
    });
    for (name, refers_to) in [("QTotal", "=SUM(DATA[Q])+A1"), ("QFirst", "=LAMBDA(n,INDEX(DATA[Q],n))")] {
        wb.named_ranges.push(crate::SavedNamedRange { name: name.to_string(), refers_to: refers_to.to_string(), sheet_id: None, comment: None, folder: None });
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("table-names.xlsx");
    crate::save_xlsx(&wb, &path).unwrap();
    let mut archive = zip::ZipArchive::new(std::fs::File::open(&path).unwrap()).unwrap();
    let mut book = String::new();
    archive.by_name("xl/workbook.xml").unwrap().read_to_string(&mut book).unwrap();
    assert!(book.contains("<definedName name=\"QTotal\">SUM(Data[Q])+!A1</definedName>"), "{}", book);
    assert!(book.contains("<definedName name=\"QFirst\">_xlfn.LAMBDA(_xlpm.n,INDEX(Data[Q],_xlpm.n))</definedName>"), "{}", book);
}

/// BUG-0645 (7): a call to a named LAMBDA the engine left unresolved
/// (`Opt(1)`, stored without Calcula's `__INVOKE__` marker) is a DYNAMIC
/// formula, as Excel saves one ([LIVE] `<c r="A1" cm="1"><f t="array"
/// ref="A1">AddOne(4)</f>`); written plain, the rev18x verifier's real-path
/// export opened as `=@Opt(1)`. A name that is no LAMBDA (`Rate`) is no
/// such call.
/// SABOTAGE (xlsxfmt-dyn): `calls_lambda` returns false.
#[test]
fn an_unresolved_named_lambda_call_is_written_dynamic() {
    let mut wb = workbook_of(0);
    let inputs = ["Opt(1)", "Dbl(2)+1", "LET(Opt,2,Opt+1)", "Rate+1", "SUM(1)"];
    let sheet1 = wb.sheets.iter_mut().find(|s| s.name == "Sheet1").unwrap();
    for (i, input) in inputs.iter().enumerate() {
        sheet1.cells.insert((i as u32 + 1, 9), SavedCell::from_cell(&engine::Cell::new_formula(format!("={}", input))));
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("dynamic.xlsx");
    crate::save_xlsx(&wb, &path).unwrap();
    let mut archive = zip::ZipArchive::new(std::fs::File::open(&path).unwrap()).unwrap();
    let mut xml = String::new();
    archive.by_name("xl/worksheets/sheet1.xml").unwrap().read_to_string(&mut xml).unwrap();
    let cell = |address: &str| {
        let at = xml.find(&format!("<c r=\"{}\"", address)).unwrap_or_else(|| panic!("no {} in {}", address, xml));
        xml[at..at + xml[at..].find("</c>").unwrap()].to_string()
    };
    for (address, dynamic) in [("J2", true), ("J3", true), ("J4", false), ("J5", false), ("J6", false)] {
        let c = cell(address);
        assert_eq!(c.contains("cm=\"1\"") && c.contains("t=\"array\""), dynamic, "{}: {}", address, c);
    }
}

/// Formulas Excel cannot hold: a built-in called with an arity Excel refuses
/// -- through a function-named parameter, inside a LET name's own value, or
/// plainly (BUG-0641) --, a LET / LAMBDA declaring one name twice, `LET(x)`
/// and `LAMBDA()`, and an R1C1-shaped name in a defined name, which has no
/// cell to be relative to. [LIVE] Excel 16 refused to TYPE each, and refused
/// to OPEN every single-formula file holding one (rev18x round 20 pass 2,
/// sB r093 r103 r105-r109 and sC r033-r042; lane xlsxfmt open2 r002 r004 r007
/// r009). The file keeps the cell's value without the formula (or leaves the
/// name out), and the loss is reported. A valid arity is still written
/// (Excel's `SUM(3)`, `IF(2,3)`), and so is an arity Calcula's catalog
/// syntax understates but [LIVE] Excel types (`GCD(4)`, `MAP` over two
/// arrays, `BYROW(A1:C2)`, `INDEX(..,1,1,1)`, `SUMIFS` with two criteria,
/// `IFS` with two pairs, `SORTBY(a,b,1)`, `GETPIVOTDATA` with one field), and
/// `LET(x,1)` / `LET(x,1,y,2)`, which Excel refuses to type but opens.
#[test]
fn a_formula_excel_cannot_hold_keeps_its_value_and_is_reported() {
    let refused = [
        "LET(if,LAMBDA(x,x*3),if(2))",
        "LET(abs,LAMBDA(x,y,x+y),abs(1,2))",
        "LET(max,LAMBDA(x,x),max())",
        "LET(round,LAMBDA(x,x*2),round(3))",
        "LET(pi,LAMBDA(x,x*2),pi(3))",
        "LET(abs,abs(1,2),abs)",
        "LET(ifs,LAMBDA(x,y,z,x),ifs(1,2,3))",
        "ABS(1,2)",
        "ROUND(1)",
        "PI(1)",
        "IF()",
        "IFS(1,2,3)",
        "IFS(TRUE,1,FALSE)",
        "SWITCH(1)",
        "CHOOSE(1)",
        "SUMIFS(A1:A5,B1:B5)",
        "COUNTIFS(A1:A5,1,B1:B5)",
        "LET(ifs,LAMBDA(x,x),ifs(TRUE,1,FALSE,2,3))",
        "LET(x,1,x,2,x)",
        "LET(x,1,X,2,x)",
        "LET(x,1,y,2,x,3,x+y)",
        "LAMBDA(x,x,x)(1,2)",
        "LAMBDA(x,[x],x)(1)",
        "LET(x)",
        "LAMBDA()",
    ];
    let kept = [
        "LET(sum,LAMBDA(x,x*2),sum(3))",
        "LET(if,LAMBDA(x,x*3),if(2,3))",
        "LET(max,LAMBDA(x,y,x*y),max(3,4))",
        "GCD(4)",
        "MAP(A1:A3,B1:B3,LAMBDA(a,b,a+b))",
        "BYROW(A1:C2)",
        "INDEX(A1:C5,1,1,1)",
        "SUMIFS(A1:A5,B1:B5,1,C1:C5,2)",
        "IFS(A1,1,A2,2)",
        "SORTBY(A1:A3,B1:B3,1)",
        "GETPIVOTDATA(A1,A1,A1)",
        "LET(x,1)",
        "LET(x,1,y,2)",
        "LET(x,1,LET(x,2,x))",
        "LPAD(\"a\",3,\"b\",4)",
    ];
    let mut wb = Workbook::new();
    wb.sheets.clear();
    let mut sheet = Sheet::new("Sheet1".to_string());
    for (i, input) in refused.iter().chain(kept.iter()).enumerate() {
        let mut cell = SavedCell::from_cell(&engine::Cell::new_formula(format!("={}", input)));
        assert!(cell.formula.is_some(), "Calcula holds no formula for {}", input);
        cell.value = SavedCellValue::Number(41.0 + i as f64);
        sheet.cells.insert((i as u32, 0), cell);
    }
    wb.sheets.push(sheet);
    for (name, refers_to) in [("ThisCol", "=C"), ("Left", "=RC[-1]"), ("Fine", "=Sheet1!$A$1")] {
        wb.named_ranges.push(crate::SavedNamedRange { name: name.to_string(), refers_to: refers_to.to_string(), sheet_id: None, comment: None, folder: None });
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("refused.xlsx");
    let losses = crate::save_xlsx_reporting_losses(&wb, &path, false).unwrap();
    if let Ok(probe) = std::env::var("CALCULA_XLSX_PROBE_DIR") {
        let _ = std::fs::copy(&path, std::path::Path::new(&probe).join("calcula-refused.xlsx"));
    }
    let mut archive = zip::ZipArchive::new(std::fs::File::open(&path).unwrap()).unwrap();
    let mut xml = String::new();
    archive.by_name("xl/worksheets/sheet1.xml").unwrap().read_to_string(&mut xml).unwrap();
    let mut book = String::new();
    archive.by_name("xl/workbook.xml").unwrap().read_to_string(&mut book).unwrap();
    for (i, input) in refused.iter().enumerate() {
        let address = format!("A{}", i + 1);
        assert_eq!(formula_of(&xml, &address), None, "EXCEL CANNOT OPEN THIS: {} was written as a formula", input);
        assert!(xml.contains(&format!("<c r=\"{}\"><v>{}</v></c>", address, 41 + i)), "the value of {} was lost: {}", input, xml);
    }
    for (i, input) in kept.iter().enumerate() {
        assert!(formula_of(&xml, &format!("A{}", refused.len() + i + 1)).is_some(), "{} lost its formula", input);
    }
    let expected: Vec<String> = (1..=refused.len()).map(|r| format!("Sheet1!A{}", r)).collect();
    assert_eq!(losses.formulas, expected, "the lost formulas are not reported");
    assert_eq!(losses.defined_names, vec!["ThisCol".to_string(), "Left".to_string()], "the R1C1-shaped names are not reported");
    assert!(book.contains("name=\"Fine\"") && !book.contains("name=\"ThisCol\"") && !book.contains("name=\"Left\""), "{}", book);
    let told = format!("the formulas in {} cells (Sheet1!A1, Sheet1!A2, Sheet1!A3, Sheet1!A4, Sheet1!A5 and {} more)", refused.len(), refused.len() - 5);
    assert!(losses.message().unwrap().contains(&told), "{:?}", losses.message());
}

/// NEW-xlsx-let-dynamic: which single-cell formulas the export writes DYNAMIC
/// (`<c cm="1"><f t="array" ref="..">`). Column 2 is Excel's own flag [LIVE,
/// Excel 16, 2026-11-05, tablefix-probe/probe1.ps1: each typed (`Formula2`)
/// into column D of a fresh workbook beside A1:A5 = 1..5 and B1:B5 =
/// 10..50, `MyF` -- here `Dbl` -- a named `LAMBDA(x,x*2)`, saved, read back].
/// Column 3 is Calcula's: Excel's wherever it says dynamic, and plain where
/// Excel says plain, except the rows rust_xlsxwriter itself marks dynamic for
/// a function on its list (`SEQUENCE`, `XLOOKUP`, `UNIQUE`, `SORT`) -- a
/// plain formula written dynamic re-opens unchanged ([LIVE] probe2.ps1 added
/// `cm="1"` to every one of these and Excel showed the same text and value).
/// The other way is the defect: written plain, Excel opened
/// `SUM(A1:A3*B1:B3)` as `SUM(@A1:A3*@B1:B3)` and recalculated it to `#VALUE!`,
/// `SUM(ROW(A1:A3))` to 1, and `IFS` / `MMULT` / a named-LAMBDA call as `=@..`
/// (probe3.ps1). A scalar `LET` is plain to Excel -- and opens as written.
/// SABOTAGE (tablefix-cm): `excel_saves_dynamic` returns false.
#[test]
fn a_single_cell_formula_is_dynamic_exactly_where_excel_saves_it_so() {
    const CM: &[(&str, bool, bool)] = &[
        ("LET(x,1,x+1)", false, false),
        ("LAMBDA(x,x+1)(2)", true, true),
        ("Dbl(3)", true, true),
        ("SUM(SEQUENCE(3))", false, true),
        ("XLOOKUP(2,A1:A5,B1:B5)", false, true),
        ("SWITCH(1,1,\"a\",\"b\")", true, true),
        ("SUM(A1:A5)", false, false),
        ("A1+1", false, false),
        ("SUM(A1:A3*B1:B3)", true, true),
        ("INDEX(A1:A5,2)", false, false),
        ("TEXTJOIN(\",\",TRUE,A1:A3)", false, false),
        ("CONCAT(A1:A3)", false, false),
        ("IFS(A1=1,\"y\")", true, true),
        ("MAXIFS(B1:B5,A1:A5,\">1\")", false, false),
        ("XMATCH(3,A1:A5)", false, false),
        ("SUM(UNIQUE(A1:A5))", false, true),
        ("ROWS(FILTER(A1:A5,A1:A5>2))", true, true),
        ("LET(a,A1:A3,SUM(a))", false, false),
        ("VLOOKUP(2,A1:B5,2,FALSE)", false, false),
        ("REDUCE(0,A1:A3,LAMBDA(a,b,a+b))", true, true),
        ("SUMPRODUCT(A1:A3*B1:B3)", true, true),
        ("Rate*2", false, false),
        ("LET(x,Dbl(2),x)", true, true),
        ("ROW()", false, false),
        ("SUM(ROW(A1:A3))", true, true),
        ("LET(x,5,x)", false, false),
        ("TAKE(A1:A5,1)", true, true),
        ("SUM(SORT(A1:A5))", false, true),
        ("SUM(A1:A3+0)", true, true),
        ("1+1", false, false),
        ("SUMIFS(B1:B5,A1:A5,\">1\")", false, false),
        ("SUM(IF(A1:A3>1,1,0))", true, true),
        ("MMULT({1,2},{3;4})", true, true),
        ("SUM(OFFSET(A1,0,0,2,1))", false, false),
        ("MIN(A1:A3)", false, false),
        ("LOOKUP(2,A1:A5,B1:B5)", false, false),
    ];
    let mut wb = workbook_of(0);
    let sheet1 = wb.sheets.iter_mut().find(|s| s.name == "Sheet1").unwrap();
    for (i, (input, _, _)) in CM.iter().enumerate() {
        let cell = SavedCell::from_cell(&engine::Cell::new_formula(format!("={}", input)));
        assert!(cell.formula.is_some(), "Calcula holds no formula for {}", input);
        sheet1.cells.insert((i as u32 + 1, 3), cell);
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cm.xlsx");
    crate::save_xlsx(&wb, &path).unwrap();
    let mut archive = zip::ZipArchive::new(std::fs::File::open(&path).unwrap()).unwrap();
    let mut xml = String::new();
    archive.by_name("xl/worksheets/sheet1.xml").unwrap().read_to_string(&mut xml).unwrap();
    let mut wrong = Vec::new();
    for (i, (input, excel, calcula)) in CM.iter().enumerate() {
        let address = format!("D{}", i + 2);
        let at = xml.find(&format!("<c r=\"{}\"", address)).unwrap_or_else(|| panic!("no {} in {}", address, xml));
        let c = &xml[at..at + xml[at..].find("</c>").unwrap()];
        assert!(c.contains("<f"), "{} ({}) was written without its formula: {}", address, input, c);
        let dynamic = c.contains("cm=\"1\"") && c.contains("t=\"array\"");
        if dynamic != *calcula {
            wrong.push(format!("{} (Excel {}): {}", input, excel, c));
        }
    }
    assert!(wrong.is_empty(), "dynamic flag differs from the table:\n{}", wrong.join("\n"));
}

/// rev-parse-1: every targeted probe of the dynamic flag, with Excel's own
/// flag and its value both ways -- (formula, Excel saved it dynamic, Excel's
/// value as typed, Excel's value read as a LEGACY formula, which is what a
/// plain export opens as). [LIVE, Excel 16, 2026-11-05: rev-parse probeD (the
/// review's 46) and lane xlsxdyn p2 / p3 (SCRATCH/xlsxdyn), each typed
/// (`Formula2`) into column J of a fresh workbook -- the one
/// `dynamic_formula::live::probe_workbook` builds, defined names and table
/// included -- the same text assigned as a legacy formula (`Formula`) beside
/// it, saved, the sheet XML's `cm` read.] The export writes each one dynamic
/// where Excel does -- the rows whose two values differ are the ones that
/// opened WRONG before (probeF: `SUM(LEN(C1:C3))` #VALUE! for 6,
/// `AND(ISNUMBER(A1:A3))` FALSE for TRUE, `SUM(MyR*2)` #VALUE! for 12) --
/// and plain where Excel does, but for a call of a function the library
/// always writes dynamic and the rows in `HARMLESS` below.
/// SABOTAGE (xlsxdyn-names): `NameShapes::get` answers one value for every
/// name -- `SUM(LEN(MyR))`, `SUM(MyR*2)`, `ABS(MyR)` written plain.
/// SABOTAGE (xlsxdyn-index): `INDEX` of a range never multi-cell --
/// `INDEX(A1:A5,D1)` plain. SABOTAGE (xlsxdyn-table) / (xlsxdyn-top) fail
/// here too (146 rows; `MMULT(A1,A1)`, `TRANSPOSE(A1)`).
#[test]
fn every_probed_formula_is_dynamic_where_excel_saves_it_so() {
    const PROBED: &[(&str, bool, &str, &str)] = &[
        ("SUM(LEN(C1:C3))", true, "6", "#VALUE!"),
        ("SUM(ABS(A1:A3))", true, "6", "#VALUE!"),
        ("SUM(IF(A1:A3,1,0))", true, "3", "#VALUE!"),
        ("SUM(VLOOKUP(A1:A3,A1:B5,2,FALSE))", true, "60", "#VALUE!"),
        ("SUM(TRANSPOSE(A1:A3))", true, "6", "#VALUE!"),
        ("MAX(INT(A1:A3))", true, "3", "#VALUE!"),
        ("AND(ISNUMBER(A1:A3))", true, "TRUE", "FALSE"),
        ("SUM(--A1:A3)", true, "6", "#VALUE!"),
        ("CONCAT(UPPER(C1:C3))", true, "ABCDEF", "#VALUE!"),
        ("SUM(INDEX(A1:A5,{1,2}))", true, "3", "1"),
        ("SUM(LEN(MyR))", true, "3", "#VALUE!"),
        ("SUMPRODUCT(LEN(C1:C3))", true, "6", "6"),
        ("SUM(ROUND(A1:A3,0))", true, "6", "#VALUE!"),
        ("SUM(CHOOSE({1,2},A1,B1))", false, "11", "11"),
        ("LET(a,A1:A3,SUM(LEN(a)))", true, "3", "#VALUE!"),
        ("MEDIAN(IFERROR(A1:A3,0))", true, "2", "0"),
        ("SUM(COUNTIF(A1:A5,A1:A3))", true, "3", "0"),
        ("SUM(SUMIF(A1:A5,A1:A3))", true, "6", "0"),
        ("SUM(MATCH(A1:A3,A1:A5,0))", true, "6", "#VALUE!"),
        ("TEXTJOIN(\",\",TRUE,LEN(C1:C3))", true, "2,3,1", "#VALUE!"),
        ("SUM(MyR*2)", true, "12", "#VALUE!"),
        ("SUM(INDEX(A1:A5,0))", false, "15", "15"),
        ("SUM(OFFSET(A1,0,0,3))", false, "6", "6"),
        ("INDEX(TRANSPOSE(A1:A3),2)", true, "2", "#VALUE!"),
        ("SUM(MMULT(A1:A2,{1,2}))", false, "9", "9"),
        ("MAX(FREQUENCY(A1:A5,{2,4}))", false, "2", "2"),
        ("INDEX(LINEST(B1:B5,A1:A5),1)", true, "9.9999999999999964", "9.9999999999999964"),
        ("SUM(TREND(B1:B5,A1:A5))", false, "150", "150"),
        ("SUM(GROWTH(B1:B5,A1:A5))", false, "151.07465729239479", "151.07465729239479"),
        ("LET(a,A1:A3,INDEX(a,2))", false, "2", "2"),
        ("LET(a,SEQUENCE(3),SUM(a))", false, "6", "6"),
        ("LET(a,A1:A3,SUM(a))", false, "6", "6"),
        ("SUM(EXP(A1:A3))", true, "30.192874850577361", "#VALUE!"),
        ("OR(A1:A3)", false, "TRUE", "TRUE"),
        ("SUM(DAY(A1:A3))", true, "6", "#VALUE!"),
        ("COUNT(SEARCH(\"c\",C1:C3))", true, "1", "0"),
        ("SUM(VALUE(A1:A3))", true, "6", "#VALUE!"),
        ("SUM(N(A1:A3))", false, "1", "1"),
        ("SUM(SIGN(A1:A3))", true, "3", "#VALUE!"),
        ("MAX(MOD(A1:A3,2))", true, "1", "#VALUE!"),
        ("SUM(ISODD(A1:A3)*1)", false, "#VALUE!", "#VALUE!"),
        ("SUMPRODUCT(ISODD(A1:A3)*1)", false, "#VALUE!", "#VALUE!"),
        ("SUM(IFERROR(1/A1:A3,0))", true, "1.8333333333333333", "0"),
        ("INDEX(A1:A5,MATCH(1,(A1:A5=3)*1,0))", true, "3", "#VALUE!"),
        ("MIN(IF(A1:A3,B1:B3))", true, "10", "#VALUE!"),
        ("SUM(XLOOKUP(A1:A3,A1:A5,B1:B5))", true, "60", "#VALUE!"),
        ("ABS(INDEX(A1:A5,2))", false, "2", "2"),
        ("ABS(INDEX(A1:A5,0))", true, "#SPILL!", "#VALUE!"),
        ("ABS(INDEX(A1:B5,2))", false, "#REF!", "#REF!"),
        ("ABS(INDEX(A1:B5,2,0))", true, "2", "#VALUE!"),
        ("ABS(INDEX(A1:B5,2,1))", false, "2", "2"),
        ("ABS(INDEX(A1:A5,D1))", true, "2", "2"),
        ("ABS(INDEX({1,2,3},2))", true, "2", "2"),
        ("ABS(INDEX(MyA,2))", true, "2", "2"),
        ("ABS(INDEX(MyR,2))", false, "2", "2"),
        ("INDEX({1,2,3},2)", true, "2", "2"),
        ("INDEX(A1:B5,2,1)", false, "2", "2"),
        ("INDEX(MyA,2)", true, "2", "2"),
        ("INDEX(A1:A5,D1)", true, "2", "2"),
        ("ABS(OFFSET(A1,1,0))", false, "2", "2"),
        ("ABS(OFFSET(A1,0,0,3))", true, "1", "#VALUE!"),
        ("ABS(OFFSET(A1,0,0,1,1))", false, "1", "1"),
        ("ABS(OFFSET(A1:A3,0,0))", true, "1", "#VALUE!"),
        ("ABS(OFFSET(A1,0,0,D1))", true, "1", "#VALUE!"),
        ("OFFSET(A1,1,0)", false, "2", "2"),
        ("OFFSET(A1,0,0,1,1)", false, "1", "1"),
        ("ABS(INDIRECT(\"A1\"))", true, "1", "1"),
        ("ABS(INDIRECT(\"A1:A3\"))", true, "1", "#VALUE!"),
        ("INDIRECT(\"A1\")", true, "1", "1"),
        ("ABS(IF(TRUE,A1))", false, "1", "1"),
        ("ABS(IF(TRUE,A1:A3))", true, "1", "#VALUE!"),
        ("ABS(IF(A1,A1:A3,B1))", true, "1", "#VALUE!"),
        ("ABS(IF(TRUE,{1,2}))", true, "1", "1"),
        ("ABS(IF(A1,B1,C1))", false, "10", "10"),
        ("IF(A1,B1,C1)", false, "10", "10"),
        ("IF(A1>0,B1,C1)", false, "10", "10"),
        ("ABS(CHOOSE(1,A1))", false, "1", "1"),
        ("ABS(CHOOSE(1,A1:A3))", true, "1", "#VALUE!"),
        ("ABS(CHOOSE(1,{1,2}))", true, "1", "1"),
        ("ABS(CHOOSE(D1,A1,B1))", false, "10", "10"),
        ("CHOOSE(D1,A1,B1)", false, "10", "10"),
        ("ABS(IFERROR(A1,A1:A3))", true, "1", "1"),
        ("ABS(IFNA(A1,A1:A3))", true, "1", "1"),
        ("ABS(SWITCH(1,1,A1:A3))", true, "1", "#VALUE!"),
        ("ABS(XLOOKUP(1,A1:A5,B1:B5))", false, "10", "10"),
        ("ABS(XLOOKUP(1,A1:A5,A1:B5))", true, "1", "#VALUE!"),
        ("ABS(LOOKUP(1,A1:A5,B1:B5))", false, "10", "10"),
        ("ABS(VLOOKUP(1,A1:B5,2))", false, "10", "10"),
        ("ABS(HLOOKUP(1,A1:B5,2))", false, "2", "2"),
        ("ABS(A1:A1)", true, "1", "1"),
        ("ABS(A1:A3 A2:B2)", true, "2", "2"),
        ("ABS(A:A)", true, "#SPILL!", "0"),
        ("ABS(1:1)", true, "#SPILL!", "0"),
        ("ABS($A$1:$A$3)", true, "1", "#VALUE!"),
        ("ABS(Sheet2!A1)", false, "100", "100"),
        ("ABS(Sheet2!A1:A3)", true, "100", "#VALUE!"),
        ("ABS(Sheet1:Sheet2!A1)", true, "#REF!", "#REF!"),
        ("SUM(Sheet1:Sheet2!A1)", false, "101", "101"),
        ("SUM(Sheet1:Sheet2!A1:A3)", false, "606", "606"),
        ("ABS(Tbl[P])", true, "1", "#VALUE!"),
        ("SUM(Tbl[P])", false, "6", "6"),
        ("SUM(LEN(Tbl[P]))", true, "3", "#VALUE!"),
        ("ABS(Tbl[@P])", false, "#VALUE!", "#VALUE!"),
        ("ABS(Tbl[[#This Row],[P]])", false, "#VALUE!", "#VALUE!"),
        ("ABS(Tbl[#Headers])", true, "#VALUE!", "#VALUE!"),
        ("SUM(Tbl[[P]:[Q]])", false, "66", "66"),
        ("ABS(MyR)", true, "1", "#VALUE!"),
        ("ABS(MyC)", false, "2", "2"),
        ("ABS(MyK)", false, "5", "5"),
        ("ABS(MyA)", true, "1", "1"),
        ("ABS(MyF)", true, "2", "2"),
        ("ABS(MyO)", true, "1", "#VALUE!"),
        ("SUM(MyO)", false, "6", "6"),
        ("SUM(LEN(MyO))", true, "3", "#VALUE!"),
        ("MyL(1)", true, "2", "2"),
        ("MyL(A1:A3)", true, "2", "2"),
        ("ABS(MyL(1))", true, "2", "2"),
        ("SUM(MyL(A1:A3))", false, "12", "12"),
        ("MyC+1", false, "3", "3"),
        ("MyK+1", false, "6", "6"),
        ("MyF+1", true, "3", "3"),
        ("SUM(MyC*2)", false, "4", "4"),
        ("SUM(MyK*2)", false, "10", "10"),
        ("SUM(MyA*2)", true, "12", "2"),
        ("SUM(MyF*2)", true, "4", "4"),
        ("SUM(MyO*2)", true, "12", "#VALUE!"),
        ("LET(a,A1,ABS(a))", false, "1", "1"),
        ("LET(a,A1:A3,ABS(a))", true, "1", "#VALUE!"),
        ("LET(a,{1,2},SUM(ABS(a)))", true, "3", "1"),
        ("LET(a,A1:A3,b,a,SUM(LEN(b)))", true, "3", "#VALUE!"),
        ("LET(a,A1:A3,SUM(a*2))", true, "12", "#VALUE!"),
        ("LET(a,SUM(A1:A3),ABS(a))", false, "6", "6"),
        ("LET(a,MyR,SUM(LEN(a)))", true, "3", "#VALUE!"),
        ("LET(MyR,1,ABS(MyR))", false, "1", "1"),
        ("LET(a,A1:A3,INDEX(a,0))", true, "1", "#VALUE!"),
        ("LET(a,TRANSPOSE(A1:A3),SUM(a))", true, "6", "#VALUE!"),
        ("LET(a,MMULT(A1:A2,{1,2}),SUM(a))", false, "9", "9"),
        ("LET(a,MMULT(A1:A2,{1,2}),ABS(SUM(a)))", false, "9", "9"),
        ("LET(a,MMULT(A1:A2,{1,2}),SUM(ABS(a)))", true, "9", "1"),
        ("LET(a,A1,b,A1:A3,SUM(a+b))", true, "9", "#VALUE!"),
        ("LET(a,A1:A3,SUM(a))+1", false, "7", "7"),
        ("LAMBDA(x,SUM(x))(A1:A3)", true, "6", "6"),
        ("LAMBDA(x,ABS(x))(A1)", true, "1", "1"),
        ("SUM(MAP(A1:A3,LAMBDA(x,ABS(x))))", true, "6", "6"),
        ("SUM(+A1:A3)", true, "6", "#VALUE!"),
        ("SUM(A1:A3%)", true, "0.06", "#VALUE!"),
        ("SUM(-A1:A3)", true, "-6", "#VALUE!"),
        ("SUM(A1:A3&\"\")", true, "0", "#VALUE!"),
        ("SUM((A1:A3))", false, "6", "6"),
        ("SUM((A1:A3=1)*1)", true, "1", "#VALUE!"),
        ("SUM(A1:A3^2)", true, "14", "#VALUE!"),
        ("SUM(2^A1:A3)", true, "14", "#VALUE!"),
        ("SUM({1,2}+1)", true, "5", "5"),
        ("SUM({1,2})", false, "3", "3"),
        ("ABS({1})", true, "1", "1"),
        ("SUM({1}+1)", true, "2", "2"),
        ("ABS({1,2})", true, "1", "1"),
        ("SUM(@A1:A3)", false, "#VALUE!", "#VALUE!"),
        ("ABS(@A1:A3)", false, "#VALUE!", "#VALUE!"),
        ("SUM(LEN(@C1:C3))", false, "#VALUE!", "#VALUE!"),
        ("SUM(SUM(A1:A3))", false, "6", "6"),
        ("SUMPRODUCT(A1:A3,B1:B3)", false, "140", "140"),
        ("SUMPRODUCT((A1:A3>1)*B1:B3)", true, "50", "50"),
        ("SUMPRODUCT(--(A1:A3>1))", true, "2", "2"),
        ("COUNTIFS(A1:A5,\">1\",B1:B5,\"<40\")", false, "2", "2"),
        ("SUMIFS(B1:B5,A1:A5,A1:A3)", true, "10", "0"),
        ("SUM(SUMIFS(B1:B5,A1:A5,A1:A3))", true, "60", "0"),
        ("COUNTIF(A1:A5,{1,2})", true, "1", "1"),
        ("SUM(COUNTIF(A1:A5,{1,2}))", true, "2", "2"),
        ("SUM(COUNTIF(A1:A5,MyR))", true, "3", "0"),
        ("MATCH(2,A1:A5,0)", false, "2", "2"),
        ("MATCH({1,2},A1:A5,0)", true, "1", "1"),
        ("SUM(MATCH({1,2},A1:A5,0))", true, "3", "3"),
        ("VLOOKUP(2,A1:B5,2,0)", false, "20", "20"),
        ("SUM(VLOOKUP({1,2},A1:B5,2,0))", true, "30", "10"),
        ("INDEX(A1:B5,MATCH(2,A1:A5,0),2)", false, "20", "20"),
        ("SUM(INDEX(A1:A5,{1;2}))", true, "3", "1"),
        ("SUM(INDEX(A1:B5,1,{1,2}))", true, "11", "1"),
        ("ROWS(A1:A3)", false, "3", "3"),
        ("COLUMNS(A1:C1)", false, "3", "3"),
        ("ROW(A1)", false, "1", "1"),
        ("COLUMN(A1:C1)", true, "1", "1"),
        ("SUM(ROW(A1))", false, "1", "1"),
        ("SUM(COLUMN(A1:C1))", true, "6", "1"),
        ("ROWS(TRANSPOSE(A1:A3))", true, "1", "#VALUE!"),
        ("AND(A1:A3>0)", true, "TRUE", "#VALUE!"),
        ("OR(A1:A3>0)", true, "TRUE", "#VALUE!"),
        ("AND(A1:A3)", false, "TRUE", "TRUE"),
        ("XOR(A1:A3)", false, "TRUE", "TRUE"),
        ("CONCAT(A1:A3)", false, "123", "123"),
        ("CONCATENATE(A1:A3)", true, "1", "#VALUE!"),
        ("CONCATENATE(A1,B1)", false, "110", "110"),
        ("TEXTJOIN(\",\",TRUE,A1:A3&\"x\")", true, "1x,2x,3x", "#VALUE!"),
        ("AGGREGATE(14,6,A1:A3/(A1:A3>1),1)", true, "3", "3"),
        ("AGGREGATE(9,6,A1:A3)", false, "6", "6"),
        ("SUBTOTAL(9,A1:A3)", false, "6", "6"),
        ("SUM(SUBTOTAL(9,OFFSET(A1,ROW(A1:A3)-1,0)))", true, "6", "1"),
        ("TRANSPOSE(A1)", true, "1", "1"),
        ("MMULT(A1,A1)", true, "1", "1"),
        ("MINVERSE(A1)", true, "1", "1"),
        ("MDETERM(A1:B2)", false, "0", "0"),
        ("MUNIT(1)", true, "1", "1"),
        ("ABS(MUNIT(1))", true, "1", "1"),
        ("SUM(FREQUENCY(A1:A5,2))", false, "5", "5"),
        ("ABS(MDETERM(A1:B2))", false, "0", "0"),
        ("SUM(LINEST(B1:B5,A1:A5))", false, "10.000000000000007", "10.000000000000007"),
        ("ABS(SUMPRODUCT(A1:A3))", false, "6", "6"),
        ("ABS(SUM(A1:A3))", false, "6", "6"),
        ("ABS(MAX(A1:A3))", false, "3", "3"),
        ("ABS(ROWS(A1:A3))", false, "3", "3"),
        ("SUM(IF(A1>0,A1:A3,0))", false, "6", "6"),
        ("SUM(IF(A1>0,A1:A3))", false, "6", "6"),
        ("SUM(IFERROR(A1:A3,0))", true, "6", "0"),
        ("SUM(IFNA(A1:A3,0))", true, "6", "#VALUE!"),
        ("MAX(IF(A1:A3>1,B1:B3))", true, "30", "#VALUE!"),
        ("SUM(CHOOSE(D1,A1:A3,B1:B3))", false, "60", "60"),
        ("SUM(CHOOSE({1,2},A1:A3,B1:B3))", false, "66", "66"),
        ("COUNT(1/A1:A3)", true, "3", "0"),
        ("NPV(0.1,A1:A3)", false, "4.8159278737791134", "4.8159278737791134"),
        ("NPV(0.1,A1:A3*2)", true, "9.6318557475582267", "#VALUE!"),
        ("IRR(A1:A3)", false, "#NUM!", "#NUM!"),
        ("IRR(A1:A3*2)", true, "#NUM!", "#NUM!"),
        ("STDEV(A1:A3*2)", true, "2", "#VALUE!"),
        ("MEDIAN(A1:A3*2)", true, "4", "#VALUE!"),
        ("LARGE(A1:A3,{1,2})", true, "3", "3"),
        ("SUM(LARGE(A1:A3,{1,2}))", true, "5", "5"),
        ("SUM(LARGE(A1:A5,A1:A2))", true, "9", "#VALUE!"),
        ("SUM(SMALL(A1:A3*2,1))", true, "2", "#VALUE!"),
        ("PERCENTILE(A1:A5*2,0.5)", true, "6", "#VALUE!"),
        ("SUMPRODUCT(LEN(MyR))", true, "3", "3"),
        ("N(A1:A3)", false, "1", "1"),
        ("SUM(T(C1:C3))", false, "#VALUE!", "#VALUE!"),
        ("SUM(LEN(T(C1:C3)))", false, "2", "2"),
        ("TYPE(A1:A3)", true, "64", "16"),
        ("ISREF(A1:A3)", false, "TRUE", "TRUE"),
        ("AREAS(A1:A3)", false, "1", "1"),
        ("CELL(\"address\",A1:A3)", true, "$A$1", "$A$1"),
        ("SUM(LEN(CELL(\"address\",A1:A3)))", true, "4", "4"),
        ("ISFORMULA(A1:A3)", true, "FALSE", "FALSE"),
        ("FORMULATEXT(A1:A3)", true, "#N/A", "#N/A"),
        ("SHEET(A1:A3)", false, "1", "1"),
        ("SUM(ISBLANK(A1:A3)*1)", true, "0", "0"),
        ("SUM(ISBLANK(A1:A3))", true, "0", "0"),
        ("SUM(1*ISBLANK(A1:A3))", true, "0", "0"),
        ("ABS(INDEX(A1:A5,1+1))", true, "2", "2"),
        ("ABS(INDEX(A1:A5,MATCH(2,A1:A5,0)))", false, "2", "2"),
        ("ABS(INDEX(A1:A5,-1))", true, "#VALUE!", "#VALUE!"),
        ("ABS(INDEX(A1:A5,\"2\"))", true, "2", "2"),
        ("ABS(INDEX(A1:A5,TRUE))", true, "1", "1"),
        ("ABS(INDEX(A1:A5,MyC))", true, "2", "2"),
        ("ABS(INDEX(A1:A5,MyK))", false, "5", "5"),
        ("ABS(INDEX(A1:A5,2,1))", false, "2", "2"),
        ("ABS(INDEX(A1:A5,2,D1))", true, "#REF!", "#REF!"),
        ("ABS(INDEX(A1:A5,2,0))", true, "2", "2"),
        ("ABS(INDEX(A1:A5,2,1,1))", false, "2", "2"),
        ("ABS(INDEX(A1:A5,2,1,D1))", false, "#REF!", "#REF!"),
        ("ABS(INDEX(A1:A5,SUM(D1)))", true, "2", "2"),
        ("ABS(INDEX(A1:A5,+D1))", true, "2", "2"),
        ("ABS(INDEX(A1:A5,(D1)))", true, "2", "2"),
        ("ABS(INDEX(A1:A5,0.5))", true, "#SPILL!", "#VALUE!"),
        ("ABS(INDEX(A1:A5,ROW(A2)))", true, "2", "2"),
        ("ABS(INDEX(A1:A5,ROWS(A1:A2)))", true, "2", "2"),
        ("ABS(INDEX(Sheet2!A1:A5,2))", false, "200", "200"),
        ("ABS(INDEX(A:A,2))", false, "2", "2"),
        ("ABS(INDEX(Tbl[P],2))", false, "2", "2"),
        ("ABS(INDEX(A1:A5,D1:D1))", true, "2", "2"),
        ("ABS(INDEX(A1:A5,Sheet2!A1))", true, "#REF!", "#REF!"),
        ("ABS(INDEX(A1:A5,INDEX(A1:A5,2)))", true, "2", "2"),
        ("ABS(INDEX(A1:A5,N(D1)))", true, "2", "2"),
        ("ABS(INDEX(A1:A5,D1*1))", true, "2", "2"),
        ("ABS(INDEX(A1:A5,2,))", true, "2", "2"),
        ("ABS(INDEX(A1:A5,,1))", true, "#SPILL!", "#VALUE!"),
        ("ABS(INDEX(A1:A5,1E0))", false, "1", "1"),
        ("ABS(INDEX(A1:A5,Tbl[@P]))", true, "#VALUE!", "#VALUE!"),
        ("ABS(INDEX(OFFSET(A1,0,0,5),2))", false, "2", "2"),
        ("ABS(INDEX(INDIRECT(\"A1:A5\"),2))", false, "2", "2"),
        ("ABS(INDEX(MyO,2))", true, "2", "2"),
        ("ABS(INDEX(IF(TRUE,A1:A5),2))", false, "2", "2"),
        ("ABS(OFFSET(A1,D1,D1))", false, "#VALUE!", "#VALUE!"),
        ("ABS(OFFSET(A1,0,0,1))", false, "1", "1"),
        ("ABS(OFFSET(A1,0,0,,1))", true, "1", "1"),
        ("ABS(OFFSET(A1,0,0,1+0,1))", true, "1", "1"),
        ("ABS(OFFSET(A1,0,0,D1,1))", true, "1", "#VALUE!"),
        ("ABS(OFFSET(A1,0,0,2))", true, "1", "#VALUE!"),
        ("ABS(OFFSET(A1,0,0,1,2))", true, "1", "#VALUE!"),
        ("ABS(OFFSET(MyC,0,0))", false, "2", "2"),
        ("ABS(OFFSET(A1,MATCH(2,A1:A5,0),0))", false, "3", "3"),
        ("ABS(OFFSET(A1:A1,0,0))", true, "1", "1"),
        ("ABS(OFFSET(A1,0,0,1,1.0))", false, "1", "1"),
        ("ABS(OFFSET(A1,0,0,\"1\",1))", true, "1", "1"),
        ("ABS(OFFSET(INDEX(A1:A5,2),0,0))", false, "2", "2"),
        ("ABS(OFFSET(Sheet2!A1,0,0))", false, "100", "100"),
        ("ABS(ROW(A1:A1))", true, "1", "1"),
        ("ABS(ROW(MyC))", false, "2", "2"),
        ("ROW(MyR)", true, "1", "1"),
        ("ABS(ROW(Tbl[P]))", true, "2", "2"),
        ("ABS(ROW(INDEX(A1:A5,2)))", false, "2", "2"),
        ("ABS(ROW(OFFSET(A1,0,0,3)))", true, "1", "1"),
        ("ABS(COLUMN(Tbl[@P]))", false, "#VALUE!", "#VALUE!"),
        ("ABS(MyN)", false, "5", "5"),
        ("ABS(MyS)", false, "#VALUE!", "#VALUE!"),
        ("ABS(MyB)", false, "1", "1"),
        ("ABS(MyE)", false, "#N/A", "#N/A"),
        ("ABS(My1)", false, "0", "0"),
        ("ABS(MyQ)", false, "100", "100"),
        ("ABS(MyV)", false, "0", "0"),
        ("ABS(MyT)", true, "1", "#VALUE!"),
        ("ABS(MyX)", true, "5", "5"),
        ("SUM(IF(A1:A3>1,1,0))", true, "2", "#VALUE!"),
        ("ABS(IF(A1,A1,B1:B3))", true, "1", "1"),
        ("ABS(IF(A1,A1))", false, "1", "1"),
        ("ABS(IF(A1,A1:A1))", true, "1", "1"),
        ("ABS(IFERROR(A1,{1}))", true, "1", "1"),
        ("ABS(CHOOSE(D1,A1,B1:B2))", true, "10", "#VALUE!"),
        ("ABS(CHOOSE({1},A1,B1))", true, "1", "1"),
        ("ABS(CHOOSE(D1,{1},B1))", true, "10", "10"),
        ("ABS(LOOKUP(1,A1:A5,A1:B5))", false, "#N/A", "#N/A"),
        ("ABS(LOOKUP(1,A1:B5))", false, "10", "10"),
        ("ABS(HLOOKUP(1,A1:B5,{1,2}))", true, "1", "1"),
        ("ABS(INDEX(A1:B5,2,{1,2}))", true, "2", "2"),
        ("ABS(SUMIF(A1:A5,\">1\",B1:B5))", false, "140", "140"),
        ("ABS(SUMIF(A1:A5,A1,B1:B5))", false, "10", "10"),
        ("SUMIF(A1:A5,MyC)", false, "2", "2"),
        ("SUMIF(A1:A5,MyF)", true, "2", "2"),
        ("ABS(Sheet2!A1:A1)", true, "100", "100"),
        ("ABS(Sheet2!A:A)", true, "#SPILL!", "0"),
        ("ABS(Sheet2!$A$1)", false, "100", "100"),
        ("ABS(Tbl[#Data])", true, "1", "#VALUE!"),
        ("ABS(Tbl[#Totals])", true, "#REF!", "#REF!"),
        ("ABS(Tbl[[#This Row],[P]:[Q]])", true, "#VALUE!", "#VALUE!"),
        ("ABS(Tbl[@[P]:[Q]])", true, "#VALUE!", "#VALUE!"),
        ("ABS(-D1)", false, "2", "2"),
        ("ABS(D1%)", false, "0.02", "0.02"),
        ("ABS(+D1)", false, "2", "2"),
        ("ABS(D1 D1)", false, "2", "2"),
        ("ABS(A1:B2 B1:B1)", true, "10", "10"),
        ("SUM(LEN(A1:A3 A2:B2))", true, "1", "1"),
        ("ABS(\"a\"&D1)", false, "#VALUE!", "#VALUE!"),
        ("ABS(D1=1)", false, "0", "0"),
        ("ABS(TRUE)", false, "1", "1"),
        ("LEN(MyF)", true, "1", "1"),
        ("LEN(MyF+0)", true, "1", "1"),
        ("SUM(MyF)", false, "2", "2"),
    ];
    use crate::xlsx_writer::dynamic_formula::live::{calls_library_dynamic, exported_cells, probe_workbook, written_dynamic};
    let formulas: Vec<(u32, String)> = PROBED.iter().enumerate().map(|(i, r)| (10 + 4 * i as u32, r.0.to_string())).collect();
    let (wb, held_none) = probe_workbook(&formulas);
    assert!(held_none.is_empty(), "Calcula holds no formula for rows {:?}", held_none);
    let cells = exported_cells(&wb, "calcula-cm-probed.xlsx");
    let mut wrong = Vec::new();
    for (i, &(input, excel, typed, legacy)) in PROBED.iter().enumerate() {
        let row = 10 + 4 * i as u32;
        let dynamic = written_dynamic(cells.get(&row)).unwrap_or_else(|| panic!("{} was written without its formula", input));
        let harmless = !excel && (calls_library_dynamic(input) || HARMLESS.contains(&input));
        if dynamic != excel && !harmless {
            let value = if typed == legacy { "same value" } else { "WRONG VALUE when plain" };
            wrong.push(format!("  {} (Excel {}, {} vs legacy {}: {})", input, if excel { "dynamic" } else { "plain" }, typed, legacy, value));
        }
    }
    assert!(wrong.is_empty(), "dynamic flag differs from Excel's ({}):\n{}", wrong.len(), wrong.join("\n"));
}

/// The probed formulas Excel saves plain that the export writes dynamic,
/// each harmless ([LIVE] a plain formula written dynamic re-opens with the
/// same text and value): a named-LAMBDA call, which the export always writes
/// dynamic (BUG-0645, `DefinedNames::calls_lambda`) though Excel keeps it
/// plain under `SUM`; an explicit `@`, which the export spells `SINGLE(..)`
/// and the library writes dynamic; and an `INDEX` by a constant name, which
/// Excel knows to be at least 1 and the classifier does not look into.
const HARMLESS: &[&str] = &[
    "SUM(MyL(A1:A3))",
    "SUM(@A1:A3)",
    "ABS(@A1:A3)",
    "SUM(LEN(@C1:C3))",
    "ABS(INDEX(A1:A5,MyK))",
];

/// NEW-relative-name-anchor + NEW-bare-table-name, the .xlsx round trip. A
/// relative defined name is written as Calcula holds it -- relative to A1,
/// Excel's own file text ([LIVE, lane formd] `Names.Add("rel","=Sheet1!A1")`
/// is saved `<definedName name="rel">Sheet1!A1`) -- and the whole table as
/// `Tbl[]` ([LIVE, lane namese p1] `=ROWS(Tbl)` / `=ROWS(Tbl[])` are filed
/// `ROWS(Tbl[])`, `=ROWS(Tbl[#Data])` as typed). Both read back unchanged.
/// With `CALCULA_XLSX_PROBE_DIR` set the export is left there as
/// `calcula-relname.xlsx`: [LIVE, lane namese p3] Excel 16 opens it with J1
/// 3, J3 3, J11 11013 (`rel` = `Sheet1!D1` from J11 is M11), J14 14013
/// (`relin` = `rel`), J15 15 (`relrow` = `ROW(Sheet1!D1)`), J16 16013 (the
/// sheetless `relns` = `D1`, filed `!D1`) and A20 42180, the sum of D:E
/// (`relcols` = `SUM(D:E)`, filed `SUM(!D:E)`).
#[test]
fn a_relative_name_and_the_whole_table_keep_excels_file_text() {
    let mut wb = Workbook::new();
    wb.sheets.clear();
    let mut sheet1 = Sheet::new("Sheet1".to_string());
    let text = |s: &str| SavedCell { value: SavedCellValue::Text(s.to_string()), formula: None, style_index: 0, rich_text: None, spill: None };
    sheet1.cells.insert((0, 0), text("H1"));
    sheet1.cells.insert((0, 1), text("H2"));
    for (r, a, b) in [(1u32, -1.0, 4.0), (2, 2.0, -5.0), (3, 3.0, 6.0)] {
        sheet1.cells.insert((r, 0), number(a));
        sheet1.cells.insert((r, 1), number(b));
    }
    for r in 0..20u32 {
        for c in 3..8u32 {
            sheet1.cells.insert((r, c), number(f64::from((r + 1) * 100 + c + 1)));
        }
    }
    let typed = [
        (0u32, "=ROWS(Tbl[])", "ROWS(Tbl[])"),
        (2, "=ROWS(Tbl[#Data])", "ROWS(Tbl[#Data])"),
        (10, "=ROW(rel)*1000+COLUMN(rel)", "ROW(rel)*1000+COLUMN(rel)"),
        (13, "=ROW(relin)*1000+COLUMN(relin)", "ROW(relin)*1000+COLUMN(relin)"),
        (14, "=relrow", "relrow"),
        (15, "=ROW(relns)*1000+COLUMN(relns)", "ROW(relns)*1000+COLUMN(relns)"),
    ];
    for &(row, formula, _) in &typed {
        let cell = SavedCell::from_cell(&engine::Cell::new_formula(formula.to_string()));
        assert!(cell.formula.is_some(), "{}", formula);
        sheet1.cells.insert((row, 9), cell);
    }
    // In column A, so the column offset is nil: `relcols` is SUM(D:E) there.
    sheet1.cells.insert((19, 0), SavedCell::from_cell(&engine::Cell::new_formula("=relcols".to_string())));
    let sheet_id = sheet1.id;
    wb.sheets.push(sheet1);
    let column = |name: &str| crate::SavedTableColumn {
        id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
        name: name.to_string(),
        totals_row_function: "none".to_string(),
        totals_row_formula: None,
        calculated_formula: None,
        totals_row_label: None,
    };
    wb.tables.push(crate::SavedTable {
        id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
        name: "Tbl".to_string(),
        sheet_id,
        start_row: 0,
        start_col: 0,
        end_row: 3,
        end_col: 1,
        columns: vec![column("H1"), column("H2")],
        style_options: crate::SavedTableStyleOptions {
            banded_rows: true,
            banded_columns: false,
            header_row: true,
            total_row: false,
            first_column: false,
            last_column: false,
            show_filter_button: true,
        },
        style_name: "TableStyleMedium9".to_string(),
    });
    for (name, refers_to) in [("rel", "=Sheet1!D1"), ("relin", "=rel"), ("relrow", "=ROW(Sheet1!D1)"), ("relmix", "=Sheet1!$D1"), ("relns", "=D1"), ("relcols", "=SUM(D:E)")] {
        wb.named_ranges.push(crate::SavedNamedRange { name: name.to_string(), refers_to: refers_to.to_string(), sheet_id: None, comment: None, folder: None });
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("calcula-relname.xlsx");
    crate::save_xlsx(&wb, &path).unwrap();
    if let Ok(probe) = std::env::var("CALCULA_XLSX_PROBE_DIR") {
        let _ = std::fs::copy(&path, std::path::Path::new(&probe).join("calcula-relname.xlsx"));
    }
    let mut archive = zip::ZipArchive::new(std::fs::File::open(&path).unwrap()).unwrap();
    let mut book = String::new();
    archive.by_name("xl/workbook.xml").unwrap().read_to_string(&mut book).unwrap();
    for file in [
        "<definedName name=\"rel\">Sheet1!D1</definedName>",
        "<definedName name=\"relin\">rel</definedName>",
        "<definedName name=\"relrow\">ROW(Sheet1!D1)</definedName>",
        "<definedName name=\"relmix\">Sheet1!$D1</definedName>",
        "<definedName name=\"relns\">!D1</definedName>",
        "<definedName name=\"relcols\">SUM(!D:E)</definedName>",
    ] {
        assert!(book.contains(file), "a relative name must keep Excel's A1-relative text {}: {}", file, book);
    }
    let mut xml = String::new();
    archive.by_name("xl/worksheets/sheet1.xml").unwrap().read_to_string(&mut xml).unwrap();
    for &(row, formula, excel) in &typed {
        let written = formula_of(&xml, &format!("J{}", row + 1)).unwrap_or_default();
        assert!(same_ignoring_case(&written, excel), "{}: Calcula wrote {}, Excel writes {}", formula, written, excel);
    }
    let back = crate::load_xlsx(&path).unwrap();
    for (name, refers_to) in [("rel", "=Sheet1!D1"), ("relmix", "=Sheet1!$D1")] {
        let got = back.named_ranges.iter().find(|n| n.name == name).map(|n| n.refers_to.clone());
        assert_eq!(got.as_deref(), Some(refers_to), "{} read back", name);
    }
    let back_sheet = back.sheets.iter().find(|s| s.name == "Sheet1").unwrap();
    let read = back_sheet.cells.get(&(0, 9)).and_then(|c| c.formula.clone()).unwrap_or_default();
    assert_eq!(stored(read.strip_prefix('=').unwrap_or(&read)), stored("ROWS(Tbl[])"), "the whole table read back as {}", read);
}
