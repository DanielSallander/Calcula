//! FILENAME: app/src-tauri/src/main.rs
// PURPOSE: Desktop entry point with unified logging (frontend + backend in one file).
// FORMAT: seq|level|category|message

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    app_lib::run();
}