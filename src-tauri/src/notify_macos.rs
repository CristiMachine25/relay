//! macOS system notifications through UNUserNotificationCenter.
//!
//! The notification plugin posts through the legacy NSUserNotificationCenter. Current macOS still
//! files those in Notification Center's database but never shows them as banners, and the plugin
//! drops the result, so they vanish without a trace. This posts through the modern API instead.
//! It needs a real .app bundle: outside one (`tauri dev`, tests) `available()` is false and the
//! caller keeps using the plugin.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use block2::{DynBlock, RcBlock};
use objc2::rc::Retained;
use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread};
use objc2_foundation::{NSBundle, NSError, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use tauri::AppHandle;

/// Banners from Relay stack under one thread in Notification Center.
const THREAD: &str = "relay";

static APP: OnceLock<AppHandle> = OnceLock::new();
static WARNED: AtomicBool = AtomicBool::new(false);

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "RelayNotificationDelegate"]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        // Without this macOS shows nothing while Relay is the frontmost app.
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(&self, _center: &UNUserNotificationCenter, _n: &UNNotification, handler: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>) {
            handler.call((UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::List,));
        }

        // A click on a banner brings Relay forward on its Notifications screen.
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(&self, _center: &UNUserNotificationCenter, _r: &UNNotificationResponse, handler: &DynBlock<dyn Fn()>) {
            if let Some(app) = APP.get() {
                crate::show_main_window(app);
                crate::events::emit(app, &crate::events::Navigate("notifications"));
            }
            handler.call(());
        }
    }
);

/// True when running from an .app bundle, the only place UNUserNotificationCenter works
/// (elsewhere `currentNotificationCenter` throws).
pub fn available() -> bool {
    static IN_BUNDLE: OnceLock<bool> = OnceLock::new();
    *IN_BUNDLE.get_or_init(|| {
        let bundle = NSBundle::mainBundle();
        bundle.bundleIdentifier().is_some() && bundle.bundlePath().to_string().ends_with(".app")
    })
}

fn center() -> Retained<UNUserNotificationCenter> {
    UNUserNotificationCenter::currentNotificationCenter()
}

/// Install the delegate. Call once at startup, before any notification is posted.
pub fn init(app: &AppHandle) {
    if !available() || APP.set(app.clone()).is_err() {
        return;
    }
    let delegate: Retained<Delegate> = unsafe { msg_send![Delegate::alloc(), init] };
    center().setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    // The center keeps only a weak reference; the delegate lives as long as the app.
    std::mem::forget(delegate);
}

/// Ask macOS for permission to show banners and resolve to whether it is granted. macOS asks the
/// user only the first time; later calls answer from the stored choice without a prompt.
pub async fn authorize() -> bool {
    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        let tx = Mutex::new(Some(tx));
        let done = RcBlock::new(move |granted: Bool, error: *mut NSError| {
            if let Some(e) = unsafe { error.as_ref() } {
                log::warn!("macOS notification permission request failed: {}", e.localizedDescription());
            }
            if let Some(tx) = tx.lock().ok().and_then(|mut t| t.take()) {
                let _ = tx.send(granted.as_bool());
            }
        });
        center().requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound, &done);
    }
    let granted = rx.await.unwrap_or(false);
    if !granted {
        warn_blocked();
    }
    granted
}

/// Post one banner and resolve to whether macOS accepted it.
pub async fn post(title: &str, body: &str) -> bool {
    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        content.setBody(&NSString::from_str(body));
        content.setThreadIdentifier(&NSString::from_str(THREAD));
        let id = NSString::from_str(&uuid::Uuid::new_v4().to_string());
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&id, &content, None);
        let tx = Mutex::new(Some(tx));
        let done = RcBlock::new(move |error: *mut NSError| {
            let error = unsafe { error.as_ref() }.map(|e| e.localizedDescription().to_string());
            if let Some(tx) = tx.lock().ok().and_then(|mut t| t.take()) {
                let _ = tx.send(error);
            }
        });
        center().addNotificationRequest_withCompletionHandler(&request, Some(&done));
    }
    match rx.await {
        Ok(None) => true,
        Ok(Some(e)) => {
            if !WARNED.swap(true, Ordering::Relaxed) {
                log::warn!("macOS refused a notification: {e}");
            }
            false
        }
        Err(_) => false,
    }
}

fn warn_blocked() {
    if !WARNED.swap(true, Ordering::Relaxed) {
        log::warn!("macOS is not allowing Relay's notifications; allow them in System Settings > Notifications > Relay");
    }
}
