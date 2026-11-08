//! The desktop shell: a window, one child process, and the lines between them.
//!
//! Nothing about a file, a device, a config or a delete lives in this crate.
//! Every rule the engine enforces stays in the engine (D27, D28).

mod engine;

use tauri::{Manager, RunEvent, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Single instance must be registered first: a second launch hands its
        // argv here instead of opening a second window over the same engine.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(engine::EngineState::default())
        .invoke_handler(tauri::generate_handler![
            engine::engine_send,
            engine::engine_status,
            engine::engine_restart
        ])
        .setup(|app| {
            // A sidecar that will not start must not abort the window: an empty
            // window says nothing, while the events below put a stopped engine
            // and a manual restart in front of the person using it.
            if let Err(err) = engine::start(app.handle()) {
                eprintln!("portage: could not start the engine: {err}");
                engine::report_start_failure(app.handle(), &err);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // No zombie may outlive the window.
            if matches!(event, WindowEvent::Destroyed) && window.label() == "main" {
                engine::shutdown(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the tauri application")
        .run(|app, event| match event {
            // Nothing in this app calls `prevent_exit`, so an `ExitRequested` is
            // always followed by `Exit`, and killing here cannot strand a live
            // window with a dead engine.
            RunEvent::ExitRequested { .. } | RunEvent::Exit => engine::shutdown(app),
            _ => {}
        });
}
