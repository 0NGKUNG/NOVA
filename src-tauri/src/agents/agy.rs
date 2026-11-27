//! Antigravity CLI adapter.
//!
//! Keep AGY command discovery and its persistent stream protocol isolated here
//! so other agent CLIs can have their own command builders and event parsers.

use std::path::{Path, PathBuf};
use std::process::Child;

pub fn resolve_cli_path() -> Option<PathBuf> {
    crate::system_tools::resolve_agy_cli_path()
}

#[allow(clippy::too_many_arguments)]
pub fn spawn_turn(
    cli_path: &Path,
    workspace_dir: &Path,
    conversation_id: Option<&str>,
    prompt: &str,
    mode: &str,
    model: Option<&str>,
    effort: Option<&str>,
    skip_permissions: bool,
    persistent_stream: bool,
) -> Result<Child, String> {
    crate::system_tools::spawn_headless_agy_turn(
        cli_path,
        workspace_dir,
        conversation_id,
        prompt,
        mode,
        model,
        effort,
        skip_permissions,
        persistent_stream,
    )
}
