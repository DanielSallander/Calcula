//! FILENAME: app/src-tauri/src/main.rs
// PURPOSE: Desktop entry point with unified logging (frontend + backend in one file).
// FORMAT: seq|level|category|message

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // NOTE: the app runs on the OS main thread (tao requires the event loop
    // there). The large command surface (~660 `generate_handler!` entries)
    // needs a bigger-than-default main-thread stack — that is set at link time
    // via `/STACK` in build.rs (Windows' default 1 MB overflows in debug).
    app_lib::run();
}
