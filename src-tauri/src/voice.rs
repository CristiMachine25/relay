//! Voice input. Claude Code's voice mode (hold-to-talk dictation) is a setting in each account's own
//! settings.json, so an account that never had it turned on has no voice: Relay turns it on in every
//! Claude account it starts, and a chat that moves to another account keeps it. Relay's own text
//! fields use the system's dictation.
use std::path::Path;

use serde_json::{json, Value};

/// Turn voice mode on in a Claude home's settings.json, keeping the user's mode (hold or tap) and
/// every other setting. A file it can't read as a JSON object is left alone. True when it wrote.
pub fn enable_claude_voice(home: &Path) -> anyhow::Result<bool> {
    let link = home.join("settings.json");
    // Settings shared between accounts are a link: write the file it points at, not over the link.
    let path = match std::fs::canonicalize(&link) {
        Ok(p) => p,
        Err(_) if link.symlink_metadata().is_ok() => return Ok(false), // a dangling link
        Err(_) => link,
    };
    let mut settings = match std::fs::read_to_string(&path) {
        Ok(text) if text.trim().is_empty() => json!({}),
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(v @ Value::Object(_)) => v,
            _ => return Ok(false),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(e.into()),
    };
    let before = settings.clone();
    // The CLI reads `voice.enabled`, then the older `voiceEnabled`, and its /voice command writes both.
    settings["voiceEnabled"] = json!(true);
    if !settings["voice"].is_object() {
        settings["voice"] = json!({});
    }
    settings["voice"]["enabled"] = json!(true);
    if !settings["voice"]["mode"].is_string() {
        settings["voice"]["mode"] = json!("hold");
    }
    if settings == before {
        return Ok(false);
    }
    crate::util::write_json_atomic(&path, &settings)?;
    Ok(true)
}

/// Start the system's dictation in whatever text field has focus (macOS: the same as Edit > Start
/// Dictation). Must run on the main thread. False where there is no system dictation to start.
#[cfg(target_os = "macos")]
pub fn start_dictation() -> bool {
    use std::ffi::c_void;
    type Id = *mut c_void;
    #[link(name = "objc")]
    extern "C" {
        fn objc_getClass(name: *const std::ffi::c_char) -> Id;
        fn sel_registerName(name: *const std::ffi::c_char) -> Id;
        fn objc_msgSend();
    }
    // SAFETY: plain Objective-C messages to NSApplication with the argument types they take: no
    // arguments for +sharedApplication, one object (nil sender) for -startDictation:.
    unsafe {
        let send0 = std::mem::transmute::<unsafe extern "C" fn(), unsafe extern "C" fn(Id, Id) -> Id>(objc_msgSend);
        let send1 = std::mem::transmute::<unsafe extern "C" fn(), unsafe extern "C" fn(Id, Id, Id)>(objc_msgSend);
        let class = objc_getClass(c"NSApplication".as_ptr());
        if class.is_null() {
            return false;
        }
        let app = send0(class, sel_registerName(c"sharedApplication".as_ptr()));
        if app.is_null() {
            return false;
        }
        send1(app, sel_registerName(c"startDictation:".as_ptr()), std::ptr::null_mut());
    }
    true
}

#[cfg(not(target_os = "macos"))]
pub fn start_dictation() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(path: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn a_home_without_settings_gets_voice_in_hold_mode() {
        let home = tempfile::tempdir().unwrap();
        assert!(enable_claude_voice(home.path()).unwrap());
        assert_eq!(read(&home.path().join("settings.json")), json!({ "voiceEnabled": true, "voice": { "enabled": true, "mode": "hold" } }));
    }

    #[test]
    fn turning_voice_on_keeps_the_other_settings_and_the_chosen_mode() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("settings.json");
        std::fs::write(&path, r#"{ "model": "opus", "voiceEnabled": false, "voice": { "enabled": false, "mode": "tap" } }"#).unwrap();
        assert!(enable_claude_voice(home.path()).unwrap());
        assert_eq!(read(&path), json!({ "model": "opus", "voiceEnabled": true, "voice": { "enabled": true, "mode": "tap" } }));
        // Already on: nothing to write.
        assert!(!enable_claude_voice(home.path()).unwrap());
    }

    #[test]
    fn a_settings_file_that_is_not_json_is_left_alone() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("settings.json");
        std::fs::write(&path, "{ not json").unwrap();
        assert!(!enable_claude_voice(home.path()).unwrap());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json");
    }

    #[cfg(unix)]
    #[test]
    fn shared_settings_are_written_through_the_link() {
        let dir = tempfile::tempdir().unwrap();
        let shared = dir.path().join("shared.json");
        std::fs::write(&shared, r#"{ "theme": "dark" }"#).unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir(&home).unwrap();
        std::os::unix::fs::symlink(&shared, home.join("settings.json")).unwrap();
        assert!(enable_claude_voice(&home).unwrap());
        assert!(home.join("settings.json").symlink_metadata().unwrap().file_type().is_symlink());
        assert_eq!(read(&shared)["voice"]["enabled"], json!(true));
        assert_eq!(read(&shared)["theme"], json!("dark"));
    }
}
