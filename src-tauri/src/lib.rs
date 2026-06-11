mod ai;
mod commands;
mod config;
#[cfg(test)]
mod e2e;
mod generate;
mod paths;
mod queue;
mod state;
mod store;
mod types;
mod util;
mod wb;

use state::AppState;
use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Per-user writable data dir (the app bundle is read-only).
            let dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."))
                .join("data");
            let state = Arc::new(AppState::new(dir));
            app.manage(state.clone());
            // Resume any batch jobs left pending from a previous run.
            tauri::async_runtime::spawn(queue::resume_worker_if_needed(state));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::get_settings,
            commands::save_settings,
            commands::generate,
            commands::publish,
            commands::list_listings,
            commands::get_listing,
            commands::delete_listing,
            commands::import_excel,
            commands::list_jobs,
            commands::enqueue_jobs,
            commands::clear_jobs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
