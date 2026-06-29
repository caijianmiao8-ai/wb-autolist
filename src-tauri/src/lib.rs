mod ai;
mod commands;
mod config;
mod db;
mod dub;
#[cfg(test)]
mod e2e;
mod generate;
mod paths;
mod queue;
mod state;
mod store;
mod templates;
mod types;
mod util;
mod wb;

use state::AppState;
use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
            commands::open_url,
            commands::get_settings,
            commands::save_settings,
            commands::default_templates,
            commands::generate,
            commands::regenerate_image,
            commands::generate_rest,
            commands::update_copy,
            commands::set_listing_video,
            commands::update_params,
            commands::publish,
            commands::list_listings,
            commands::get_listing,
            commands::delete_listing,
            commands::trash_card,
            commands::retry_pricing,
            commands::import_excel,
            commands::list_jobs,
            commands::enqueue_jobs,
            commands::clear_jobs,
            commands::list_job_listings,
            commands::list_media_files,
            commands::read_file_b64,
            commands::search_subjects,
            commands::subject_characteristics,
            commands::predict_characteristics,
            commands::update_dimensions,
            commands::wb_colors,
            commands::wb_tnved,
            commands::list_warehouses,
            commands::test_aurixel,
            commands::aurixel_balance,
            commands::test_wb,
            commands::db_list_cards,
            commands::sync_products,
            commands::sync_warehouses,
            commands::sync_stocks,
            commands::sync_prices,
            commands::set_card_stock,
            commands::set_card_price,
            commands::trash_cards,
            dub::dub_preflight,
            dub::dub_pick_video,
            dub::dub_start,
            dub::dub_cancel,
            dub::dub_prepare_engine,
            dub::dub_engine_status,
            dub::pick_folder,
            dub::open_path,
            dub::reveal_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
