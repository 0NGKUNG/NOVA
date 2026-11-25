# NOVA — Personal AI Agent Mission Control & Dynamic Island for Windows

**NOVA** is a custom, Antigravity-first Windows desktop companion, Dynamic Island, Smart Approval Engine, Bilingual (English + ภาษาไทย) Voice Suite, and Developer HUD built on **Tauri v2 (Rust) + React 19 + TypeScript**.

See [INTERVIEW.md](./INTERVIEW.md) for the complete 25-decision personalization blueprint.

## Highlights
- **Switchable NOVA AI Core / Orb + Pro Minimal HUD** with Deep Obsidian, Frosted Acrylic Glass, and Tactical Monospace themes + 4 custom aura palettes.
- **Configurable Snap Zones & Smart Ergonomics**: Top-Center Dynamic Island, Corners, Bottom Dock, or Free-drag; 250ms smart dwell hover, click-to-pin, and automatic fullscreen game/video suppression.
- **Detachable Desktop Floating Orb / Mini HUD** (`?surface=orb`).
- **1st-Class Antigravity Hook Integration (`nova-hook.exe`)**:
  - Sub-250ms fail-open native Rust CLI relay (`target/release/nova-hook.exe`).
  - Safe `~/.gemini/config/hooks.json` diff-preview installer with dated backups & Coucou co-existence toggle.
  - **Mission Control**: Parallel workspace & subagent tracking, git branch badges, live unified file diffs, and 1-click Window/IDE jump.
  - **All 4 Smart Approval Upgrades**: Command Risk Analyzer, 1-Click Scoped Rule Builder, Inline File-Write Diff Preview, and Safe Auto-Approve Rules.
- **Unified Raycast-Style Command Bar (`Ctrl+Alt+Space`)** with AltGr layout guard.
- **Multi-Backend AI Chat + Windows Context Superpowers**: Gemini, Claude, OpenAI, Groq, OpenRouter, Ollama, LM Studio, & Zero-Key CLI Subscription Relay; Screen Vision Snip, Smart Clipboard History, and File Drop.
- **Bilingual Thai + English (`ไทย / EN`) Voice & Meeting Notetaker**: Hybrid Whisper/Gemini/WebSpeech STT, Thai+English Tech Dictionary, Voice Snippets, and action-item summarization.
- **Built-in Dev & Focus Utilities**: Localhost Port Manager (Open / Kill), CPU/RAM/GPU Hardware Monitor, Universal Windows Media Controller, GitHub PRs & CI, Novadoro Focus Timer + Scratchpad, Shareable `1080×1920` Recap Story PNG + Markdown Devlog, and **QR Mobile Web / PWA + Telegram Approval Bridge**.

## Quick Commands

```powershell
# Run automated tests
npm test
cargo test --workspace

# Launch native Windows Tauri desktop app (Island + Hub + System Tray + Core Server on :47920)
.\target\debug\nova.exe

# Or run NOVA Core Engine headless (:47920)
.\target\debug\nova.exe --headless
```
