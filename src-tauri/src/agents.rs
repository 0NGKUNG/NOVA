//! Agent runtime boundary.
//!
//! Workspace sessions carry a provider identity independently from the IDE/app
//! that may also report activity for the same folder. Provider-specific CLI
//! launch, streaming, resume, model, and permission behavior belongs behind this
//! module as additional runtimes are added.

pub mod agy;

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Child;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentProvider {
    /// Antigravity's headless `agy.exe` CLI. This remains the default runtime.
    #[default]
    Agy,
}

impl AgentProvider {
    pub fn id(self) -> &'static str {
        match self {
            Self::Agy => "agy",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Self::Agy => "Antigravity CLI",
        }
    }

    /// Parses an explicitly requested provider. Unknown values fail closed so
    /// a future provider can never silently run a different agent by mistake.
    pub fn parse(value: Option<&str>) -> Result<Self, String> {
        let normalized = value
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_ascii_lowercase);
        match normalized.as_deref() {
            None | Some("agy") | Some("antigravity") => Ok(Self::Agy),
            Some(other) => Err(format!(
                "Agent provider '{other}' is not available yet. Select Antigravity CLI."
            )),
        }
    }
}

pub fn resolve_cli_path(provider: AgentProvider) -> Option<PathBuf> {
    match provider {
        AgentProvider::Agy => agy::resolve_cli_path(),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn spawn_turn(
    provider: AgentProvider,
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
    match provider {
        AgentProvider::Agy => agy::spawn_turn(
            cli_path,
            workspace_dir,
            conversation_id,
            prompt,
            mode,
            model,
            effort,
            skip_permissions,
            persistent_stream,
        ),
    }
}

/// Provider capabilities let the UI and dispatcher avoid assuming every CLI
/// supports AGY's persistent stream, model catalog, or permission semantics.
#[derive(Debug, Clone, Copy)]
pub struct AgentCapabilities {
    pub persistent_stream: bool,
    pub resume: bool,
    pub model_selection: bool,
    pub effort_selection: bool,
    pub host_permission_controls: bool,
    pub ide_hook_observation: bool,
}

impl AgentProvider {
    pub fn capabilities(self) -> AgentCapabilities {
        match self {
            Self::Agy => AgentCapabilities {
                persistent_stream: true,
                resume: true,
                model_selection: true,
                effort_selection: true,
                host_permission_controls: true,
                ide_hook_observation: true,
            },
        }
    }
}
