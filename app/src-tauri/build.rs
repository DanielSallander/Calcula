//! FILENAME: app/src-tauri/build.rs
// PURPOSE: Tauri build script.

fn main() {
    // The main thread runs the tao/WebView2 event loop AND the huge
    // `generate_handler!` command dispatch (~660 commands). Windows' default
    // 1 MB main-thread stack overflows in debug builds ("thread 'main' has
    // overflowed its stack"). Reserve a 32 MB main-thread stack in the PE
    // header (MSVC `/STACK:reserve`) so the event loop stays on the main thread
    // with ample headroom. Only affects the final `app` binary link.
    #[cfg(target_env = "msvc")]
    println!("cargo:rustc-link-arg-bin=app=/STACK:33554432");

    tauri_build::build()
}
