// Out-of-process thread-stack dumper for a wedged Windows process.
//
// WHY: the app deadlocks with the message pump stopped, so nothing inside it
// can report -- the logger is inside the wedge. This observes from OUTSIDE:
// suspend every thread, read its context, walk its stack with dbghelp against
// the PDBs next to the exe, print the frames.
//
// Target machine is ARM64 (aarch64-pc-windows-msvc), so this uses the ARM64
// CONTEXT layout and IMAGE_FILE_MACHINE_ARM64. Build it with the SAME rustc
// the app uses, so it is an ARM64 process reading an ARM64 process.
//
//   rustc -O stackdump.rs -o stackdump.exe
//   stackdump.exe <pid> [--symdir <dir>] [--resume]
//
// No crates. Everything is raw FFI to kernel32 + dbghelp.

#![allow(non_snake_case, non_camel_case_types)]

use std::ffi::c_void;

type BOOL = i32;
type DWORD = u32;
type DWORD64 = u64;
type HANDLE = *mut c_void;

const TH32CS_SNAPTHREAD: DWORD = 0x0000_0004;
const PROCESS_ALL_ACCESS: DWORD = 0x001F_FFFF;
const THREAD_ALL_ACCESS: DWORD = 0x001F_FFFF;
const IMAGE_FILE_MACHINE_ARM64: DWORD = 0xAA64;

// CONTEXT_ARM64 | CONTROL | INTEGER | FLOATING_POINT
const CONTEXT_ARM64_FULL: DWORD = 0x0040_0000 | 0x1 | 0x2 | 0x4;

const SYMOPT_UNDNAME: DWORD = 0x0000_0002;
const SYMOPT_DEFERRED_LOADS: DWORD = 0x0000_0004;
const SYMOPT_LOAD_LINES: DWORD = 0x0000_0010;
const SYMOPT_FAIL_CRITICAL_ERRORS: DWORD = 0x0000_0200;
const SYMOPT_NO_PROMPTS: DWORD = 0x0008_0000;

#[repr(C)]
#[derive(Clone, Copy)]
struct THREADENTRY32 {
    dwSize: DWORD,
    cntUsage: DWORD,
    th32ThreadID: DWORD,
    th32OwnerProcessID: DWORD,
    tpBasePri: i32,
    tpDeltaPri: i32,
    dwFlags: DWORD,
}

#[repr(C, align(16))]
#[derive(Clone, Copy)]
struct NEON128 {
    low: u64,
    high: i64,
}

// ARM64_NT_CONTEXT. Total size 0x390.
#[repr(C, align(16))]
#[derive(Clone, Copy)]
struct CONTEXT_ARM64 {
    ContextFlags: DWORD, // 0x000
    Cpsr: DWORD,         // 0x004
    X: [DWORD64; 31],    // 0x008 .. 0x100  (X0..X28, Fp=X29, Lr=X30)
    Sp: DWORD64,         // 0x100
    Pc: DWORD64,         // 0x108
    V: [NEON128; 32],    // 0x110 .. 0x310
    Fpcr: DWORD,         // 0x310
    Fpsr: DWORD,         // 0x314
    Bcr: [DWORD; 8],     // 0x318
    Bvr: [DWORD64; 8],   // 0x338
    Wcr: [DWORD; 2],     // 0x378
    Wvr: [DWORD64; 2],   // 0x380
}

impl Default for CONTEXT_ARM64 {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct ADDRESS64 {
    Offset: DWORD64,
    Segment: u16,
    Mode: DWORD, // ADDRESS_MODE enum
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct KDHELP64 {
    Thread: DWORD64,
    ThCallbackStack: DWORD,
    ThCallbackBStore: DWORD,
    NextCallback: DWORD,
    FramePointer: DWORD,
    KiCallUserMode: DWORD64,
    KeUserCallbackDispatcher: DWORD64,
    SystemRangeStart: DWORD64,
    KiUserExceptionDispatcher: DWORD64,
    StackBase: DWORD64,
    StackLimit: DWORD64,
    BuildVersion: DWORD64,
    RetpolineStubFunctionTableSize: DWORD64,
    RetpolineStubOffset: DWORD64,
    RetpolineStubSize: DWORD64,
    Reserved0: [DWORD64; 2],
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct STACKFRAME64 {
    AddrPC: ADDRESS64,
    AddrReturn: ADDRESS64,
    AddrFrame: ADDRESS64,
    AddrStack: ADDRESS64,
    AddrBStore: ADDRESS64,
    FuncTableEntry: *mut c_void,
    Params: [DWORD64; 4],
    Far: BOOL,
    Virtual: BOOL,
    Reserved: [DWORD64; 3],
    KdHelp: KDHELP64,
}

const MAX_SYM_NAME: usize = 2000;

#[repr(C)]
struct SYMBOL_INFO {
    SizeOfStruct: u32,
    TypeIndex: u32,
    Reserved: [u64; 2],
    Index: u32,
    Size: u32,
    ModBase: u64,
    Flags: u32,
    Value: u64,
    Address: u64,
    Register: u32,
    Scope: u32,
    Tag: u32,
    NameLen: u32,
    MaxNameLen: u32,
    Name: [u8; MAX_SYM_NAME],
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct IMAGEHLP_LINE64 {
    SizeOfStruct: DWORD,
    Key: *mut c_void,
    LineNumber: DWORD,
    FileName: *const u8,
    Address: DWORD64,
}

#[repr(C)]
struct IMAGEHLP_MODULE64 {
    SizeOfStruct: DWORD,
    BaseOfImage: DWORD64,
    ImageSize: DWORD,
    TimeDateStamp: DWORD,
    CheckSum: DWORD,
    NumSyms: DWORD,
    SymType: DWORD,
    ModuleName: [u8; 32],
    ImageName: [u8; 256],
    LoadedImageName: [u8; 256],
    LoadedPdbName: [u8; 256],
    CVSig: DWORD,
    CVData: [u8; 780],
    PdbSig: DWORD,
    PdbSig70: [u8; 16],
    PdbAge: DWORD,
    PdbUnmatched: BOOL,
    DbgUnmatched: BOOL,
    LineNumbers: BOOL,
    GlobalSymbols: BOOL,
    TypeInfo: BOOL,
    SourceIndexed: BOOL,
    Publics: BOOL,
    MachineType: DWORD,
    Reserved: DWORD,
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn OpenProcess(dwDesiredAccess: DWORD, bInheritHandle: BOOL, dwProcessId: DWORD) -> HANDLE;
    fn OpenThread(dwDesiredAccess: DWORD, bInheritHandle: BOOL, dwThreadId: DWORD) -> HANDLE;
    fn CloseHandle(h: HANDLE) -> BOOL;
    fn CreateToolhelp32Snapshot(dwFlags: DWORD, th32ProcessID: DWORD) -> HANDLE;
    fn Thread32First(hSnapshot: HANDLE, lpte: *mut THREADENTRY32) -> BOOL;
    fn Thread32Next(hSnapshot: HANDLE, lpte: *mut THREADENTRY32) -> BOOL;
    fn SuspendThread(h: HANDLE) -> DWORD;
    fn ResumeThread(h: HANDLE) -> DWORD;
    fn GetThreadContext(h: HANDLE, ctx: *mut CONTEXT_ARM64) -> BOOL;
    fn GetLastError() -> DWORD;
    fn ReadProcessMemory(
        hProcess: HANDLE,
        lpBaseAddress: *const c_void,
        lpBuffer: *mut c_void,
        nSize: usize,
        lpNumberOfBytesRead: *mut usize,
    ) -> BOOL;
}

#[link(name = "dbghelp")]
unsafe extern "system" {
    fn SymInitialize(hProcess: HANDLE, UserSearchPath: *const u8, fInvadeProcess: BOOL) -> BOOL;
    fn SymSetOptions(SymOptions: DWORD) -> DWORD;
    fn SymCleanup(hProcess: HANDLE) -> BOOL;
    fn SymFunctionTableAccess64(hProcess: HANDLE, AddrBase: DWORD64) -> *mut c_void;
    fn SymGetModuleBase64(hProcess: HANDLE, Address: DWORD64) -> DWORD64;
    fn StackWalk64(
        MachineType: DWORD,
        hProcess: HANDLE,
        hThread: HANDLE,
        StackFrame: *mut STACKFRAME64,
        ContextRecord: *mut c_void,
        ReadMemoryRoutine: *mut c_void,
        FunctionTableAccessRoutine: *mut c_void,
        GetModuleBaseRoutine: *mut c_void,
        TranslateAddress: *mut c_void,
    ) -> BOOL;
    fn SymFromAddr(
        hProcess: HANDLE,
        Address: DWORD64,
        Displacement: *mut DWORD64,
        Symbol: *mut SYMBOL_INFO,
    ) -> BOOL;
    fn SymGetLineFromAddr64(
        hProcess: HANDLE,
        dwAddr: DWORD64,
        pdwDisplacement: *mut DWORD,
        Line: *mut IMAGEHLP_LINE64,
    ) -> BOOL;
    fn SymGetModuleInfo64(
        hProcess: HANDLE,
        qwAddr: DWORD64,
        ModuleInfo: *mut IMAGEHLP_MODULE64,
    ) -> BOOL;
}

fn cstr_to_string(p: *const u8) -> String {
    if p.is_null() {
        return String::new();
    }
    let mut out = Vec::new();
    unsafe {
        let mut i = 0isize;
        loop {
            let b = *p.offset(i);
            if b == 0 || i > 4096 {
                break;
            }
            out.push(b);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Symbolize one return address and print it as a frame line.
unsafe fn print_frame(hproc: HANDLE, raw_addr: u64, n: usize) {
    unsafe {
        // Some frames come back with the top 16-19 bits tagged (measured: the
        // first chained frame out of an ntdll wait). The low 48 bits are the
        // real user-mode address, so retry masked when the raw value resolves
        // to nothing.
        let mut addr = raw_addr;
        if SymGetModuleBase64(hproc, addr) == 0 {
            let masked = raw_addr & 0x0000_FFFF_FFFF_FFFF;
            if SymGetModuleBase64(hproc, masked) != 0 {
                addr = masked;
            }
        }
        let mut buf: Vec<u8> = vec![0u8; std::mem::size_of::<SYMBOL_INFO>()];
        let sym = buf.as_mut_ptr() as *mut SYMBOL_INFO;
        (*sym).SizeOfStruct = 88;
        (*sym).MaxNameLen = (MAX_SYM_NAME - 1) as u32;
        let mut disp: DWORD64 = 0;
        let name = if SymFromAddr(hproc, addr, &mut disp, sym) != 0 {
            let namelen = (*sym).NameLen as usize;
            let nb =
                std::slice::from_raw_parts((*sym).Name.as_ptr(), namelen.min(MAX_SYM_NAME - 1));
            format!("{}+0x{:x}", String::from_utf8_lossy(nb), disp)
        } else {
            let base = SymGetModuleBase64(hproc, addr);
            let mut mi: IMAGEHLP_MODULE64 = std::mem::zeroed();
            mi.SizeOfStruct = std::mem::size_of::<IMAGEHLP_MODULE64>() as DWORD;
            let modname = if base != 0 && SymGetModuleInfo64(hproc, addr, &mut mi) != 0 {
                cstr_to_string(mi.ModuleName.as_ptr())
            } else {
                String::from("<unknown>")
            };
            if base != 0 {
                format!("{}+0x{:x}", modname, addr - base)
            } else {
                String::from("<no module>")
            }
        };

        let mut line: IMAGEHLP_LINE64 = std::mem::zeroed();
        line.SizeOfStruct = std::mem::size_of::<IMAGEHLP_LINE64>() as DWORD;
        let mut ldisp: DWORD = 0;
        let src = if SymGetLineFromAddr64(hproc, addr, &mut ldisp, &mut line) != 0 {
            format!("  [{}:{}]", cstr_to_string(line.FileName), line.LineNumber)
        } else {
            String::new()
        };

        println!("   #{:<3} 0x{:016x}  {}{}", n, addr, name, src);
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: stackdump <pid> [--symdir <dir>] [--resume] [--maxframes N]");
        std::process::exit(2);
    }
    let pid: u32 = args[1].parse().expect("pid must be a number");
    let mut symdir = String::new();
    let mut resume = false;
    let mut max_frames = 128usize;
    let mut i = 2;
    while i < args.len() {
        match args[i].as_str() {
            "--symdir" => {
                symdir = args[i + 1].clone();
                i += 2;
            }
            "--resume" => {
                resume = true;
                i += 1;
            }
            "--maxframes" => {
                max_frames = args[i + 1].parse().unwrap_or(128);
                i += 2;
            }
            other => {
                eprintln!("unknown arg {}", other);
                std::process::exit(2);
            }
        }
    }

    unsafe {
        let hproc = OpenProcess(PROCESS_ALL_ACCESS, 0, pid);
        if hproc.is_null() {
            eprintln!("OpenProcess failed: {}", GetLastError());
            std::process::exit(1);
        }

        SymSetOptions(
            SYMOPT_UNDNAME
                | SYMOPT_DEFERRED_LOADS
                | SYMOPT_LOAD_LINES
                | SYMOPT_FAIL_CRITICAL_ERRORS
                | SYMOPT_NO_PROMPTS,
        );
        let search: Vec<u8> = if symdir.is_empty() {
            Vec::new()
        } else {
            let mut v = symdir.clone().into_bytes();
            v.push(0);
            v
        };
        let search_ptr = if search.is_empty() {
            std::ptr::null()
        } else {
            search.as_ptr()
        };
        if SymInitialize(hproc, search_ptr, 1) == 0 {
            eprintln!("SymInitialize failed: {}", GetLastError());
        }

        // Enumerate the target's threads.
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snap as isize == -1 {
            eprintln!("CreateToolhelp32Snapshot failed: {}", GetLastError());
            std::process::exit(1);
        }
        let mut te: THREADENTRY32 = std::mem::zeroed();
        te.dwSize = std::mem::size_of::<THREADENTRY32>() as DWORD;
        let mut tids: Vec<u32> = Vec::new();
        if Thread32First(snap, &mut te) != 0 {
            loop {
                if te.th32OwnerProcessID == pid {
                    tids.push(te.th32ThreadID);
                }
                te.dwSize = std::mem::size_of::<THREADENTRY32>() as DWORD;
                if Thread32Next(snap, &mut te) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);

        println!("=== stackdump pid {} : {} threads ===", pid, tids.len());

        for (idx, tid) in tids.iter().enumerate() {
            let hthread = OpenThread(THREAD_ALL_ACCESS, 0, *tid);
            if hthread.is_null() {
                println!("\n-- thread {} (#{}) : OpenThread failed {}", tid, idx, GetLastError());
                continue;
            }
            let susp = SuspendThread(hthread);
            if susp == u32::MAX {
                println!("\n-- thread {} (#{}) : SuspendThread failed {}", tid, idx, GetLastError());
                CloseHandle(hthread);
                continue;
            }

            let mut ctx = CONTEXT_ARM64::default();
            ctx.ContextFlags = CONTEXT_ARM64_FULL;
            if GetThreadContext(hthread, &mut ctx) == 0 {
                println!("\n-- thread {} (#{}) : GetThreadContext failed {}", tid, idx, GetLastError());
                ResumeThread(hthread);
                CloseHandle(hthread);
                continue;
            }

            println!("\n-- thread {} (#{})  pc=0x{:016x} sp=0x{:016x}", tid, idx, ctx.Pc, ctx.Sp);

            // ------------------------------------------------------------------
            // ARM64 FRAME-POINTER WALK.
            //
            // dbghelp's StackWalk64 does not support IMAGE_FILE_MACHINE_ARM64 --
            // it returns the PC and the LR and then garbage (measured: the third
            // frame comes back with the low 48 bits of a plausible address and
            // junk in the top 16). The Windows ARM64 ABI instead REQUIRES a
            // frame-pointer chain for every non-leaf function: x29 points at a
            // pair [saved x29, saved LR]. Walking that by hand with
            // ReadProcessMemory is exact for framed functions and only ever
            // misses a leaf, whose return address is still in LR (frame #1).
            // ------------------------------------------------------------------
            let mut n = 0usize;
            print_frame(hproc, ctx.Pc, n);
            n += 1;
            if ctx.X[30] != 0 {
                print_frame(hproc, ctx.X[30], n); // LR
                n += 1;
            }
            let mut fp = ctx.X[29];
            while n < max_frames && fp != 0 {
                let mut pair: [u64; 2] = [0, 0];
                let mut got: usize = 0;
                if ReadProcessMemory(
                    hproc,
                    fp as *const c_void,
                    pair.as_mut_ptr() as *mut c_void,
                    16,
                    &mut got,
                ) == 0
                    || got != 16
                {
                    break;
                }
                let next_fp = pair[0];
                let ret = pair[1];
                if ret == 0 {
                    break;
                }
                print_frame(hproc, ret, n);
                n += 1;
                // The chain must climb; anything else is a corrupt or ended stack.
                if next_fp <= fp {
                    break;
                }
                fp = next_fp;
            }

            if resume {
                ResumeThread(hthread);
            }
            CloseHandle(hthread);
        }

        SymCleanup(hproc);
        CloseHandle(hproc);
    }
}
