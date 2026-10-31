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
//! (round 19), set 3 is xlsxmod's (round 20). The comparison ignores case
//! only: Calcula's stored text folds every identifier to upper case, Excel
//! keeps the user's spelling, and both name the same thing.
//!
//! Column 5, when not empty, is what Calcula writes where it deliberately
//! differs, each with its reason. Column 6 is whether the file reads back to
//! the formula Calcula stored: a bare `C` / `R` cannot, because Excel's file
//! holds the cell's own column or row in its place.
//!
//! Not here: `SUM(1.:3)` and `SUM(2.:.3)`, whose LEADING row dot Calcula's
//! parser drops (it stores `SUM(1:3)` / `SUM(2:.3)`), so the export cannot
//! write Excel's `_TRO_LEADING(1:3)` / `_TRO_ALL(2:3)` -- a parser defect,
//! not the export's. Nor what Excel refused to TYPE (`LET(b,2,SUM(B:$B)*b)`,
//! `LET(a,1,SUM(A:.A)+a)`, `LET(a,A1:A5,SUM(a:.a))`, `LET(if,..)`,
//! `LET(E5,2,$E$5+E5)`), and what Calcula's parser cannot hold (no formula is
//! stored: `LET(a,B2,SUM(a:C3))`, `LET(b,A3,SUM(A1:b))`,
//! `LET(a,SEQUENCE(3),SUM(a#))`, `LET(Col,1,SUM(Table1[Col]:Table1[Col])+Col)`,
//! `LET(a,1,SUM(Sheet1!A1:Sheet1!A3)+a)`).
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
    (4, 42, "LET(c,1,SUM(R:c)+c)", "_xlfn.LET(_xlpm.c,1,SUM(C:R)+_xlpm.c)", "_xlfn.LET(_xlpm.C,1,SUM(R:C)+_xlpm.C)", true), // Excel orders the halves; the same columns
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
    for set in 1..=6u8 {
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
        let read = crate::xlsx_formula_text::calcula_formula_text(file);
        if stored(&read) != stored(input) {
            wrong.push(format!("  set {} J{}: {}\n    Excel's {}\n    read as {} -> {:?}, stored {:?}", set, row, input, excel, read, stored(&read), stored(input)));
        }
    }
    assert!(wrong.is_empty(), "EXCEL'S SPELLING NOT READ BACK ({}):\n{}", wrong.len(), wrong.join("\n"));
}

/// Formulas Excel cannot hold: a function-named parameter called with an
/// arity the built-in refuses ([LIVE] Excel 16 refused to TYPE each, and
/// refused every file holding one, rev18x round 20), and an R1C1-shaped name
/// in a defined name, which has no cell to be relative to. The file keeps the
/// cell's value without the formula (or leaves the name out), and the loss
/// is reported; a valid arity is still written (Excel's `SUM(3)`, `IF(2,3)`).
#[test]
fn a_formula_excel_cannot_hold_keeps_its_value_and_is_reported() {
    let refused = [
        "LET(if,LAMBDA(x,x*3),if(2))",
        "LET(abs,LAMBDA(x,y,x+y),abs(1,2))",
        "LET(max,LAMBDA(x,x),max())",
        "LET(round,LAMBDA(x,x*2),round(3))",
        "LET(pi,LAMBDA(x,x*2),pi(3))",
    ];
    let kept = ["LET(sum,LAMBDA(x,x*2),sum(3))", "LET(if,LAMBDA(x,x*3),if(2,3))", "LET(max,LAMBDA(x,y,x*y),max(3,4))"];
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
    assert!(losses.message().unwrap().contains("the formulas in 5 cells (Sheet1!A1, Sheet1!A2, Sheet1!A3, Sheet1!A4, Sheet1!A5)"), "{:?}", losses.message());
}
