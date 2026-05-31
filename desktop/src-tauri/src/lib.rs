mod commands;
mod engine;
mod storage;

use std::sync::Mutex;
use tauri::Manager;

pub struct AppState {
    pub storage_root: String,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = env_logger::try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let storage_root = storage::resolve_storage_root(&app.path().resource_dir()?);
            app.manage(AppState {
                storage_root,
            });
            log::info!("Novel Agent started");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::books::init_book,
            commands::books::search_books,
            commands::books::ping_book,
            commands::books::delete_book,
            commands::archive::get_file,
            commands::archive::update_file,
            commands::archive::append_file,
            commands::archive::get_archive_range,
            commands::archive::get_markdown_outline,
            commands::archive::get_markdown_section,
            commands::archive::get_core_archive,
            commands::archive::checkout,
            commands::archive::repo_integrity,
            commands::archive::repair_layout,
            commands::archive::list_hot_files,
            commands::archive::prepend_file,
            commands::archive::add_chapter,
            commands::draft::draft_append_section,
            commands::draft::draft_replace_section,
            commands::draft::draft_sync_all,
            commands::draft::draft_confirm,
            commands::draft::draft_rollback,
            commands::git::git_log,
            commands::git::git_diff,
            commands::git::git_branch_list,
            commands::git::git_checkout_branch,
            commands::git::git_working_tree,
            commands::git::git_stage,
            commands::git::git_stage_all,
            commands::git::git_unstage,
            commands::git::git_commit_staged,
            commands::git::git_commit_files,
            commands::git::git_merge,
            commands::git::git_rename_branch,
            commands::git::git_hard_rollback,
            commands::tools::read_chapter,
            commands::tools::search_chapter_index,
            commands::tools::extract_chapter_highlights,
            commands::tools::validate_chapter_lengths,
            commands::tools::adaptive_slice,
            commands::config::get_config,
            commands::config::save_config,
            commands::ai::deduce_stream,
            commands::ai::deduce_blocking,
            commands::ai::stop_generation,
            commands::pipeline::run_pipeline,
            commands::style::style_init,
            commands::rolling::rolling_state,
            commands::import::import_preview,
            commands::import::import_confirm,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
