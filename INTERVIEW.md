# NOVA — Product & Personalization Interview Spec

> Recorded live one-by-one to define the custom architecture, UX, workflows, and personal style of **NOVA** (evolving beyond Coucou).

## Interview Responses

### 1. Name & Brand Identity
- **Question:** What should we name your custom app and hook relay?
- **Answer:** **NOVA** (`nova-hook` CLI relay & brand identity).

### 2. Companion / Avatar Persona
- **Question:** Instead of Coucou's Mochi, how should NOVA visually represent itself in the island?
- **Answer:** **Switchable** — Animated **NOVA AI Core/Orb** (reactive rings, pulse, voice waveform) + optional **Pro Minimal HUD** mode.

### 3. Visual Theme & Materials
- **Question:** What look and feel should NOVA's surfaces have?
- **Answer:** **Themeable Presets** — Deep Obsidian Dynamic Island default + Frosted Acrylic Glass, Tactical Monospace HUD, and custom accent/orb auras.

### 4. Sound Design & Audio Cues
- **Question:** How should NOVA handle sound feedback?
- **Answer:** **Subtle synthesized futuristic micro-chimes** (procedural WebAudio + custom sound pack folder + quick mute toggle).

### 5. Screen Placement & Multi-Monitor
- **Question:** Where should NOVA live on your screen(s)?
- **Answer:** **Configurable Snap Zones** — Top-Center Dynamic Island default, plus Top-Left/Right corners, Bottom Taskbar dock, or free-drag, with monitor picker & follow-active-monitor option.

### 6. Closed / Idle Bar Glanceables
- **Question:** Which items do you want available in NOVA's folded compact pill?
- **Answer:** **NOVA Orb + Active Coding Agent count & live status pulse** (clean, focused, distraction-free).

### 7. Open / Fold Interaction
- **Question:** How should NOVA open and close so it never gets in the way of browser tabs or fullscreen apps?
- **Answer:** **Smart Dwell Hover (~250ms) + Click-to-Pin + Auto-suppress during fullscreen games/videos**.

### 8. Detachable Desktop Mode
- **Question:** How should NOVA handle desktop detachment?
- **Answer:** **Detachable Floating Orb / Mini HUD** — drag NOVA out of the island as a compact floating orb or pinned mini status widget that docks back on alerts.

### 9. AI Coding Agents
- **Question:** Which coding agents do you use or want NOVA's hook installer & live monitor to support?
- **Answer:** **Antigravity-first** (`.gemini/config/hooks.json` + command approvals as 1st-class flagship integration on Windows, with clean generic hook protocol support).

### 10. Multi-Session & Subagent Handling
- **Question:** How should NOVA display parallel workspaces and subagents?
- **Answer:** **Mission Control View** — track multiple parallel Antigravity workspaces, subagents/swarms, branch names, and queued approvals side-by-side.

### 11. Permission & Approval Card Upgrades
- **Question:** Which smart approval features should NOVA add beyond Coucou's basic Allow/Deny?
- **Answer:** **All 4 upgrades** — Command Risk Analyzer + 1-Click Scoped Rule Builder + Inline File-Write Diff Preview + Configurable Safe Auto-Approve Rules.

### 12. Editor & Terminal Jump
- **Question:** Which editors and terminals do you use so NOVA's "Open File at Line" and "Focus Session Window" target your exact setup?
- **Answer:** **Antigravity + Windows Terminal / PowerShell + VS Code** (auto-detect owning window & jump to exact `file:line`).

### 13. Session Launcher & File Drop
- **Question:** How much task launching and file routing should NOVA do from the island?
- **Answer:** **Full Command Dispatch** — Launch new project sessions, send follow-up instructions from the island, AND drag-drop files/screenshots onto active sessions or chat.

### 14. Built-in Quick AI Chat
- **Question:** How do you want NOVA's instant island chat (`Ctrl+Alt+Space`) to be powered?
- **Answer:** **Unified Multi-Backend** — Zero-key CLI subscription relay (Antigravity/Gemini/Claude) + Direct API keys (Gemini, Anthropic, OpenAI, OpenRouter, Groq) + Local Ollama/LM Studio.

### 15. Windows Context Superpowers
- **Question:** Which Windows context tools should NOVA include?
- **Answer:** **All 4 Context Superpowers** — Active Window / Screen Region Vision Snip + Selected-Text Quick Action + Smart Dev Clipboard History + Persistent Searchable Chat Threads & Custom Personas.

### 16. Push-to-Talk Voice Dictation
- **Question:** How should NOVA handle global hold-key voice dictation?
- **Answer:** **Hybrid STT** — Instant lightweight Groq Whisper / Gemini / OpenAI STT + Web Speech API fallback + custom tech dictionary & snippets (no mandatory 700MB download).

### 17. Languages & Bilingual Code-Switching
- **Question:** Which language(s) should NOVA's voice dictation, AI cleanup, and UI optimize for?
- **Answer:** **Bilingual Thai + English** (seamless Thai + English technical code-switching in dictation/AI cleanup, plus full **English / ไทย UI toggle** — fixing Coucou Windows's missing Thai localization!).

### 18. Meeting Notetaker & Voice Commands
- **Question:** Beyond dictation, how should NOVA handle voice notes, calls, and spoken commands?
- **Answer:** **Both** — Bot-free Meeting & Voice Memo Notetaker (Mic + System Audio -> Summary + Action Items + Markdown export) + Push-to-Talk Voice Command hotkey (zero idle mic drain).

### 19. External Service Integrations
- **Question:** Which external service integrations fit your workflow?
- **Answer:** **GitHub** (PRs, Review Requests, CI/Actions status, Contribution Streak — skipping legacy Outlook/Stripe/Resend/WhatsApp bloat).

### 20. Built-in Developer & Focus Pills
- **Question:** Which local utility pills should NOVA ship right inside the island?
- **Answer:** **All 4 Dev & Focus Utilities** — Universal Windows Media Pill + Localhost Port & Dev Server Manager + System & AI Hardware Monitor + Deep Focus Pomodoro Timer ("Novadoro") & Daily Scratchpad.

### 21. Analytics & Weekly Recap
- **Question:** How should NOVA track and summarize your personal productivity?
- **Answer:** **Personal Dev & Focus Insights** — 100% local Daily/Weekly Recap (coding hours, sessions, lines changed, focus blocks, dictation WPM) + Markdown Devlog export & shareable NOVA card.

### 22. Mobile & Remote Access
- **Question:** How do you want to monitor and approve sessions from your phone?
- **Answer:** **QR Mobile Web / PWA + Optional Telegram Bot Bridge** — scan a QR code on Wi-Fi/Tailscale to approve, view diffs & chat from any phone browser, OR use inline Telegram `[Allow]`/`[Deny]` buttons with zero APK sideloading.

### 23. Tech Stack & Platform
- **Question:** Which stack should we build NOVA on?
- **Answer:** **Tauri v2 (Rust + native `nova-hook.exe`) + React 19 + TypeScript + Vite** — optimized 100% for Windows 11/10 with ultra-low RAM & clean modular components.

### 24. Shortcuts & Command Bar
- **Question:** Should NOVA add a Raycast-style unified Command Bar inside the Island alongside customizable shortcuts?
- **Answer:** **Unified Command Palette inside the Island (`Ctrl+Alt+Space`) + customizable global hotkeys with AltGr collision guard** (search sessions, approvals, ports, clipboard, focus timer & AI chat from 1 bar).

### 25. Final Launch & REA Setup Check
- **Question:** Should I also apply & verify the 2-step REA Antigravity setup from earlier before building and serving NOVA?
- **Answer:** **Yes** — apply & verify the 2-step REA Antigravity setup (`mcp_config.json` + personal skill), then build and launch **NOVA** immediately.

---

## Finalized NOVA Master Blueprint (Synthesized from 25 Interview Decisions)

| Pillar | Chosen Specification |
| :--- | :--- |
| **Brand & Relay** | **NOVA** desktop host (`nova.exe`) + **`nova-hook.exe`** standalone Rust CLI relay |
| **Avatar & HUD** | Switchable **Animated NOVA AI Core/Orb** (Canvas 2D rings, pulse, reactive audio waveform) + **Pro Minimal HUD** mode |
| **Visual Themes** | **Deep Obsidian Dynamic Island** (default), **Frosted Acrylic Glass**, **Tactical Monospace HUD**, + custom aura accents |
| **Audio Feedback** | Synthesized **WebAudio futuristic micro-chimes** + custom sound folder override + instant mute |
| **Placement & Ergonomics** | Configurable snap zones (Top-Center default, Corners, Bottom Taskbar dock, Free-drag) + multi-monitor + **250ms smart dwell hover**, click-to-pin, fullscreen suppression |
| **Closed Bar** | Clean **NOVA Orb + Active Agent count & live status pulse** |
| **Desktop Detachment** | **Detachable Floating Orb / Mini HUD** window that docks back on urgent approvals |
| **Flagship Agent Loop** | **Antigravity-first** (`.gemini/config/hooks.json` safe diff-preview installer + dated backup + generic hook support) with **Mission Control** parallel workspace/subagent/swarm tracking |
| **Smart Approvals** | **Command Risk Analyzer** + **1-Click Scoped Rule Builder** + **Inline File-Write Diff Preview** + **Configurable Safe Auto-Approve Rules** |
| **Editor & Dispatch** | Auto-focus & `file:line` jump for **Antigravity, Windows Terminal / PowerShell, VS Code**; launch new sessions, send follow-ups, & drag-drop files/screenshots |
| **Quick AI Chat** | Unified **CLI Subscription Relay** (Antigravity/Gemini/Claude) + **Cloud API Keys** (Windows Credential Manager) + **Local Ollama/LM Studio** |
| **Windows Context Tools** | **Screen/Window Vision Capture** + **Selected-Text Quick Action** + **Smart Dev Clipboard History** + **Persistent Searchable Threads & Personas** |
| **Voice & Localization** | **Hybrid STT** (Groq Whisper / Gemini / OpenAI + Web Speech fallback + tech dictionary/snippets), **Bilingual English + ไทย (Thai)** code-switching & full EN/TH UI toggle, **Bot-free Meeting/Memo Notetaker**, + **Push-to-Talk Voice Commands** |
| **Integrations & Dev Pills** | **GitHub** (PRs, Reviews, Actions CI, Streak) + **Universal Windows Media** + **Localhost Port Manager** (detect/open/kill `3000`/`5173`/`8080`) + **CPU/RAM/GPU Hardware Monitor** + **Novadoro Focus Timer & Scratchpad** |
| **Insights & Mobile** | Local **Daily/Weekly Dev & Focus Recap** + Markdown Devlog export + **QR Mobile Web / PWA Server** + optional **Telegram Bot Bridge** |
| **Stack & Command Bar** | **Tauri v2 (Rust) + React 19 + TypeScript + Vite** (100% Windows 11/10 optimized) + **Unified Raycast-style Command Palette (`Ctrl+Alt+Space`)** with AltGr guard |
