mod commands;
mod sidecar;
mod storage;

use std::sync::Mutex;
use tauri::Manager;

pub struct AppState {
    pub storage_root: String,
    pub sidecar_handle: Mutex<Option<sidecar::SidecarHandle>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let storage_root = storage::resolve_storage_root(&app.path().resource_dir()?);
            app.manage(AppState {
                storage_root,
                sidecar_handle: Mutex::new(None),
            });
            log::info!("Novel Agent started");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::books::init_book,
            commands::books::search_books,
            commands::books::ping_book,
            commands::archive::get_file,
            commands::archive::update_file,
            commands::archive::append_file,
            commands::archive::get_archive_range,
            commands::archive::get_markdown_outline,
            commands::archive::get_markdown_section,
            commands::archive::get_core_archive,
            commands::draft::draft_append_section,
            commands::draft::draft_replace_section,
            commands::draft::draft_sync_all,
            commands::draft::draft_confirm,
            commands::draft::draft_rollback,
            commands::git::git_log,
            commands::git::git_diff,
            commands::git::git_branch_list,
            commands::git::git_checkout_branch,
            commands::tools::read_chapter,
            commands::tools::search_chapter_index,
            commands::tools::extract_chapter_highlights,
            commands::tools::validate_chapter_lengths,
            commands::sidecar_cmd::start_sidecar,
            commands::sidecar_cmd::stop_sidecar,
            commands::sidecar_cmd::sidecar_deduce,
            commands::sidecar_cmd::sidecar_deduce_stream,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
