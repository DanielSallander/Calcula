//! FILENAME: app/src-tauri/src/browser_accelerator_keys.rs
//! PURPOSE: F5 / Ctrl+R / Ctrl+Shift+R and the keyboard's Refresh key never
//!          RELOAD a window (and throw away what it holds), in every window
//!          and every build, from the first keystroke -- while the page still
//!          receives the key, so F5 stays Go To.
//!
//! CONTEXT: BUG-0393, reviews revG#6 and rev3C#1. A reload key no binding took
//!          reaches WebView2's reload, which throws away the open workbook's
//!          session. The app window's JS guard (`api/keybindings.ts`,
//!          `isUnboundBrowserReloadKey`) prevents it in the app's OWN document,
//!          and the script-frame loader (`script_frame.rs`) carries the same
//!          guard for keys typed inside a script's `ui.html` frame. The other
//!          windows -- the Model Editor, the Chart Spec Editor, the Object
//!          Script Editor, the Package Inspector, created from TypeScript with
//!          `new WebviewWindow(...)` -- install no guard at all, so Ctrl+R there
//!          reloaded the window and lost its unsaved edits.
//!
//! TWO LAYERS, both installed through a plugin's `on_webview_ready` (which
//! fires for the windows TypeScript opens too; tauri 2.9.5 exposes neither):
//!
//! 1. THE RELOAD KEYS, every build: a controller-level `AcceleratorKeyPressed`
//!    handler. For a reload key ([`is_browser_reload_key`], the same rule as
//!    the two JS guards) it sets
//!    `ICoreWebView2AcceleratorKeyPressedEventArgs2::IsBrowserAcceleratorKeyEnabled`
//!    to FALSE: the browser's own action for that one keystroke does not run,
//!    and the key is NOT marked handled, so the page still gets its keydown --
//!    F5 is still Go To, Ctrl+R still Fill Right, an editor that listens for
//!    them still hears them. The handler acts on the very next keystroke.
//!    This is the layer that answers rev3C#1: the settings switch below is set
//!    AFTER the window's first navigation has begun (wry calls `Navigate`
//!    inside its own webview build, and `on_webview_ready` runs after that
//!    build, posted to the main thread -- wry 0.53.5 `webview2/mod.rs`,
//!    tauri 2.9.5 `manager/webview.rs`), and WebView2 applies a setting
//!    changed after NavigationStarting only from the NEXT top-level
//!    navigation. Without the handler, the first Ctrl+R in a fresh Model
//!    Editor still reloaded it. It stays on in DEBUG builds too: it touches no
//!    key but the reload keys, so F12 / Ctrl+Shift+I DevTools are unaffected,
//!    and a debug build's editor windows no longer depend on a JS guard they
//!    never had.
//!
//! 2. THE OTHER BROWSER KEYS, release builds only:
//!    `ICoreWebView2Settings3::AreBrowserAcceleratorKeysEnabled(false)`, the
//!    switch wry sets for `with_browser_accelerator_keys(false)`. It turns off
//!    (Microsoft's list) Ctrl+F / F3 find on page, Ctrl+P print, F5 / Ctrl+R
//!    reload, Ctrl+Plus / Ctrl+Minus zoom (already off: tauri's
//!    `zoomHotkeysEnabled` defaults to false), Ctrl+Shift+I / Ctrl+Shift+J /
//!    Ctrl+Shift+C / F12 DevTools, F7 caret browsing, and the browser's Back /
//!    Forward / Search keys. Editing and movement keys (Ctrl+C / V / X / A / Z,
//!    Home, End, Page Up / Down) are NOT affected, nor is any key the page
//!    handles itself -- JavaScript still receives every keydown. It STAYS,
//!    deliberately: a release app should not offer the browser's find bar over
//!    an editor's HTML, a print preview of the web page, the F7 caret-browsing
//!    prompt or Back / Forward; the app binds its own Find (Ctrl+F), Print
//!    (Ctrl+P) and Save, and Monaco binds its own Find in the editor windows.
//!    That it lands one navigation late costs nothing: the reload keys are
//!    layer 1's from the first keystroke, and Back has no earlier page to go
//!    to in a window's first document. Debug builds keep these keys so F12
//!    still opens DevTools (a release build has none to open: the `devtools`
//!    feature is off).
//!
//! Both functions are compiled in EVERY build (the choice is a `cfg!` value,
//! not a `#[cfg]` attribute), so a debug build and `cargo test` prove the
//! release path still compiles and links.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// The plugin's name (tauri requires one; nothing invokes it -- it has no commands).
pub const PLUGIN_NAME: &str = "calcula-browser-keys";

/// The Windows virtual-key codes the reload rule reads (winuser.h). `R` is
/// read by its virtual key, as WebView2's own accelerator is: on a Cyrillic
/// layout the same key types a Cyrillic letter and still reloads.
pub const VK_F5: u32 = 0x74;
pub const VK_R: u32 = 0x52;
pub const VK_BROWSER_REFRESH: u32 = 0xA8;

/// The modifier keys held at a keystroke. Shift is not here: it never decides
/// (Shift+F5 and Ctrl+Shift+R are reloads like F5 and Ctrl+R).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HeldModifiers {
    pub ctrl: bool,
    /// Alt -- and so AltGr, which Windows reports as Ctrl+Alt.
    pub alt: bool,
    /// Either Windows key.
    pub win: bool,
}

/// Is this keystroke one of the browser's RELOAD keys? F5 and Ctrl+R, with or
/// without Ctrl / Shift (the hard reloads Ctrl+F5, Shift+F5, Ctrl+Shift+R),
/// and the keyboard's own Refresh key -- never with Alt (AltGr+R types a
/// character on some layouts) or a Windows key. The same rule as
/// `isUnboundBrowserReloadKey` (api/keybindings.ts) and the script-frame
/// loader's guard (script_frame.rs).
pub const fn is_browser_reload_key(virtual_key: u32, held: HeldModifiers) -> bool {
    if held.alt || held.win {
        return false;
    }
    match virtual_key {
        VK_F5 | VK_BROWSER_REFRESH => true,
        VK_R => held.ctrl,
        _ => false,
    }
}

/// What a build installs on every webview.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BrowserKeyPolicy {
    /// Layer 1: the reload keys never reach WebView2's reload.
    pub guard_reload_keys: bool,
    /// Layer 2: the other browser accelerator keys are off too.
    pub disable_browser_keys: bool,
}

/// The policy of a build: every build guards the reload keys; only a release
/// build turns the other browser keys off (a debug build keeps F12 DevTools).
pub const fn browser_key_policy(debug_build: bool) -> BrowserKeyPolicy {
    BrowserKeyPolicy { guard_reload_keys: true, disable_browser_keys: !debug_build }
}

/// The plugin: on every webview's creation, install this build's policy.
pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new(PLUGIN_NAME)
        .on_webview_ready(|webview| {
            let policy = browser_key_policy(cfg!(debug_assertions));
            if !policy.guard_reload_keys && !policy.disable_browser_keys {
                return;
            }
            let label = webview.label().to_string();
            let dispatched = webview.with_webview(move |platform| {
                if policy.guard_reload_keys {
                    if let Err(reason) = guard_reload_keys_on(&platform) {
                        log::warn!(
                            "[browser-keys] could not guard the reload keys in '{}': {}",
                            label,
                            reason
                        );
                    }
                }
                if policy.disable_browser_keys {
                    if let Err(reason) = disable_on(&platform) {
                        log::warn!(
                            "[browser-keys] could not turn the browser accelerator keys off in '{}': {}",
                            label,
                            reason
                        );
                    }
                }
            });
            if let Err(err) = dispatched {
                log::warn!("[browser-keys] could not reach a new webview: {}", err);
            }
        })
        .build()
}

/// Layer 1 on one webview: an `AcceleratorKeyPressed` handler on its
/// controller that keeps the browser from acting on a reload key (and on
/// nothing else). Registered for the webview's lifetime, like wry's own
/// handlers, so the token is not kept.
#[cfg(windows)]
fn guard_reload_keys_on(platform: &tauri::webview::PlatformWebview) -> Result<(), String> {
    use webview2_com::AcceleratorKeyPressedEventHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2AcceleratorKeyPressedEventArgs2, COREWEBVIEW2_PHYSICAL_KEY_STATUS,
    };
    use windows::core::Interface;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VIRTUAL_KEY, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN};

    // The modifier state comes from the UI thread's key state, which is what
    // WebView2's own samples read in this event (it runs on that thread).
    fn down(key: VIRTUAL_KEY) -> bool {
        // SAFETY: GetKeyState only reads the calling thread's keyboard state.
        unsafe { GetKeyState(i32::from(key.0)) < 0 }
    }

    let handler = AcceleratorKeyPressedEventHandler::create(Box::new(|_controller, args| {
        let Some(args) = args else { return Ok(()) };
        // SAFETY: COM calls on the event arguments WebView2 hands this handler,
        // on the UI thread that raised the event.
        unsafe {
            let mut virtual_key = 0u32;
            args.VirtualKey(&mut virtual_key)?;
            let mut status = COREWEBVIEW2_PHYSICAL_KEY_STATUS::default();
            args.PhysicalKeyStatus(&mut status)?;
            let held = HeldModifiers {
                ctrl: down(VK_CONTROL),
                alt: status.IsMenuKeyDown.as_bool() || down(VK_MENU),
                win: down(VK_LWIN) || down(VK_RWIN),
            };
            if !is_browser_reload_key(virtual_key, held) {
                return Ok(());
            }
            // Every kind of the keystroke (down, its auto-repeats, up): the
            // browser never acts on it. NOT `SetHandled(true)`, which would
            // also keep the key from the page and break F5 Go To.
            match args.cast::<ICoreWebView2AcceleratorKeyPressedEventArgs2>() {
                Ok(args2) => args2.SetIsBrowserAcceleratorKeyEnabled(false)?,
                Err(_) => warn_old_runtime_once(),
            }
        }
        Ok(())
    }));
    let mut token = 0i64;
    // SAFETY: registered on the controller tauri hands this closure, on the
    // main thread that owns the webview (`with_webview`), as wry registers its
    // own handlers.
    unsafe { platform.controller().add_AcceleratorKeyPressed(&handler, &mut token) }
        .map_err(|e| e.to_string())
}

/// A WebView2 runtime older than 1.0.1293 (mid-2022) has no per-key switch.
/// The JS guards and, in a release build, layer 2 from the next navigation
/// are what is left; said once, not per keystroke.
#[cfg(windows)]
fn warn_old_runtime_once() {
    static WARNED: std::sync::Once = std::sync::Once::new();
    WARNED.call_once(|| {
        log::warn!(
            "[browser-keys] this WebView2 runtime cannot turn one browser key off; F5 / Ctrl+R may reload a window that has no guard of its own"
        );
    });
}

#[cfg(not(windows))]
fn guard_reload_keys_on(_platform: &tauri::webview::PlatformWebview) -> Result<(), String> {
    Ok(())
}

/// Layer 2 on one webview: `AreBrowserAcceleratorKeysEnabled = false`, exactly
/// as wry does at creation for `with_browser_accelerator_keys(false)`. A
/// runtime too old for `ICoreWebView2Settings3` answers an error and changes
/// nothing. Takes effect from the webview's next navigation (module header).
#[cfg(windows)]
fn disable_on(platform: &tauri::webview::PlatformWebview) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows::core::Interface;
    // SAFETY: COM calls on the controller tauri hands this closure, which runs
    // on the main thread that owns the webview (`with_webview`), the same
    // calls wry makes in `set_webview_settings`.
    unsafe {
        let core = platform.controller().CoreWebView2().map_err(|e| e.to_string())?;
        let settings = core.Settings().map_err(|e| e.to_string())?;
        let settings3 = settings.cast::<ICoreWebView2Settings3>().map_err(|e| e.to_string())?;
        settings3.SetAreBrowserAcceleratorKeysEnabled(false).map_err(|e| e.to_string())
    }
}

#[cfg(not(windows))]
fn disable_on(_platform: &tauri::webview::PlatformWebview) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONE: HeldModifiers = HeldModifiers { ctrl: false, alt: false, win: false };
    const CTRL: HeldModifiers = HeldModifiers { ctrl: true, alt: false, win: false };
    const ALT: HeldModifiers = HeldModifiers { ctrl: false, alt: true, win: false };
    /// AltGr: Windows reports it as Ctrl+Alt.
    const ALTGR: HeldModifiers = HeldModifiers { ctrl: true, alt: true, win: false };
    const WIN: HeldModifiers = HeldModifiers { ctrl: false, alt: false, win: true };

    const VK_F12: u32 = 0x7B;
    const VK_C: u32 = 0x43;
    const VK_F: u32 = 0x46;
    const VK_I: u32 = 0x49;
    const VK_P: u32 = 0x50;

    /// The trade-off, pinned (rev3C#1 and the owner question round 3 left): a
    /// reload key is guarded in EVERY build; only a release build turns the
    /// browser's other keys off, so a debug build's F12 still opens DevTools.
    #[test]
    fn every_build_guards_the_reload_keys_and_only_a_release_build_turns_the_rest_off() {
        let release = browser_key_policy(false);
        let debug = browser_key_policy(true);
        assert!(release.guard_reload_keys, "a release build lets F5 / Ctrl+R reload a window");
        assert!(debug.guard_reload_keys, "a debug build lets F5 / Ctrl+R reload a window that has no JS guard");
        assert!(release.disable_browser_keys, "a release build left the browser's find / print / back keys on");
        assert!(!debug.disable_browser_keys, "a debug build lost F12 / Ctrl+Shift+I (DevTools)");
    }

    /// The keys the guard takes from the browser -- the same list the two JS
    /// guards are proved against (scriptFrameReloadKeys.test.ts `RELOADS`;
    /// Shift is not a modifier the rule reads).
    #[test]
    fn the_reload_keys_are_f5_ctrl_r_and_the_refresh_key_with_or_without_ctrl_or_shift() {
        assert!(is_browser_reload_key(VK_F5, NONE), "F5 (Shift+F5 alike) reaches the reload");
        assert!(is_browser_reload_key(VK_F5, CTRL), "Ctrl+F5 reaches the reload");
        assert!(
            is_browser_reload_key(VK_R, CTRL),
            "Ctrl+R (Ctrl+Shift+R, and Ctrl+R on a Cyrillic layout, alike) reaches the reload"
        );
        assert!(is_browser_reload_key(VK_BROWSER_REFRESH, NONE), "the keyboard's Refresh key reaches the reload");
        assert!(is_browser_reload_key(VK_BROWSER_REFRESH, CTRL));
    }

    /// The keys it leaves to the browser: DevTools, find, print, copy, a plain
    /// R, and anything with Alt (AltGr+R types a character) or a Windows key.
    #[test]
    fn every_other_key_is_left_to_the_browser() {
        assert!(!is_browser_reload_key(VK_R, NONE), "a plain r is a typed character");
        assert!(!is_browser_reload_key(VK_R, ALTGR), "AltGr+R types a character on some layouts");
        assert!(!is_browser_reload_key(VK_F5, ALT), "Alt+F5 is not a reload");
        assert!(!is_browser_reload_key(VK_R, WIN), "Win+R is the Run box");
        assert!(!is_browser_reload_key(VK_F12, NONE), "F12 (DevTools) is untouched");
        assert!(!is_browser_reload_key(VK_I, CTRL), "Ctrl+Shift+I (DevTools) is untouched");
        assert!(!is_browser_reload_key(VK_F, CTRL), "Ctrl+F is untouched");
        assert!(!is_browser_reload_key(VK_P, CTRL), "Ctrl+P is untouched");
        assert!(!is_browser_reload_key(VK_C, CTRL), "Ctrl+C is untouched");
    }
}
