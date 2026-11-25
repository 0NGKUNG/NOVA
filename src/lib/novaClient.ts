import {
  ApprovalRule,
  FocusState,
  GitHubOverview,
  HardwareTelemetry,
  MediaStatus,
  NovaSettings,
  NovaSnapshot,
  PortProcessInfo,
  TechTerm,
  TodoItem,
  VoiceNote,
  VoiceSnippet,
} from "../types";
import { playNovaCue, SoundCue } from "./soundEngine";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
  }
}

export function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(
    window.__TAURI_INTERNALS__ ||
      window.__TAURI__ ||
      window.location.hostname === "tauri.localhost" ||
      window.location.protocol === "tauri:"
  );
}

function getApiBase(): string {
  if (typeof window === "undefined") return "http://127.0.0.1:47920";
  const { protocol, hostname, port } = window.location;
  // When running inside Tauri production protocol (`tauri://localhost` or `http://tauri.localhost`)
  if (hostname === "tauri.localhost" || protocol === "tauri:") {
    return "http://127.0.0.1:47920";
  }
  // When accessed via Vite dev server (:1420) or direct Core port (:47920) or LAN Mobile PWA
  if (port === "1420") {
    return ""; // Vite proxy forwards /api and /ws
  }
  return `${protocol}//${hostname}:${port || "47920"}`;
}

let cachedAuthToken: string | null = null;
let pendingTokenPromise: Promise<string> | null = null;

async function resolveAuthToken(): Promise<string> {
  if (cachedAuthToken) return cachedAuthToken;
  if (typeof window === "undefined") return "";

  const urlToken = new URLSearchParams(window.location.search).get("token") ?? "";
  if (urlToken) {
    cachedAuthToken = urlToken;
    return urlToken;
  }

  if (isTauriRuntime()) {
    if (!pendingTokenPromise) {
      pendingTokenPromise = import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke<string>("get_ipc_token"))
        .then((tok) => {
          cachedAuthToken = tok || "";
          return cachedAuthToken;
        })
        .catch(() => "")
        .finally(() => {
          pendingTokenPromise = null;
        });
    }
    return pendingTokenPromise;
  }

  return "";
}

async function getWsUrl(): Promise<string> {
  if (typeof window === "undefined") return "ws://127.0.0.1:47920/ws";
  const { protocol, hostname, port } = window.location;
  const token = await resolveAuthToken();
  const qs = token ? `?token=${encodeURIComponent(token)}` : "";

  if (hostname === "tauri.localhost" || protocol === "tauri:") {
    return `ws://127.0.0.1:47920/ws${qs}`;
  }
  const wsProto = protocol === "https:" ? "wss:" : "ws:";
  return `${wsProto}//${hostname}:${port || "47920"}/ws${qs}`;
}

async function postJson<T = Record<string, unknown>>(path: string, body: unknown): Promise<T> {
  const token = await resolveAuthToken();
  const res = await fetch(`${getApiBase()}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-Nova-Token": token } : {}),
    },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

async function getJson<T>(path: string): Promise<T> {
  const token = await resolveAuthToken();
  const res = await fetch(`${getApiBase()}${path}`, {
    headers: token ? { "X-Nova-Token": token } : undefined,
  });
  return (await res.json()) as T;
}

export const novaApi = {
  fetchSnapshot: () => getJson<NovaSnapshot>("/api/snapshot"),
  fetchTelemetry: () => getJson<HardwareTelemetry>("/api/telemetry"),
  fetchPorts: () => getJson<PortProcessInfo[]>("/api/ports"),
  killPortPid: (pid: number) => postJson<{ ok: boolean; message?: string; error?: string }>("/api/ports/kill", { pid }),
  fetchMedia: () => getJson<MediaStatus>("/api/media"),
  controlMedia: (action: "toggle" | "next" | "prev") => postJson<{ ok: boolean; status?: MediaStatus }>("/api/media/control", { action }),
  fetchGitHub: () => getJson<GitHubOverview>("/api/github"),

  resolveApproval: (
    approvalId: string,
    decision: "allow" | "deny" | "ask",
    createRuleScope?: "session" | "workspace" | "global",
    editedCommand?: string,
    denyReason?: string
  ) =>
    postJson("/api/approvals/resolve", {
      approvalId,
      decision,
      createRuleScope,
      editedCommand,
      denyReason,
    }),

  sendSessionPrompt: (payload: {
    workspacePath?: string;
    conversationId?: string | null;
    prompt: string;
    mode?: "auto" | "accept-edits" | "plan";
    effort?: string;
    imageDataUrl?: string | null;
  }) =>
    postJson<{ ok: boolean; delivery?: string; error?: string }>("/api/session/send", payload),

  stopSession: (conversationId: string) =>
    postJson<{ ok: boolean; error?: string }>("/api/session/stop", { conversationId }),

  setPermissionMode: (payload: {
    globalMode?: "follow_agy" | "turbo" | "smart_auto" | "request_review";
    conversationId?: string;
    sessionOverride?: string;
  }) => postJson<{ ok: boolean; error?: string }>("/api/session/permission", payload),

  revertSessionDiff: (conversationId: string, filePath: string) =>
    postJson<{ ok: boolean; message?: string; error?: string }>("/api/session/revert-diff", {
      conversationId,
      filePath,
    }),

  addRule: (rule: Partial<ApprovalRule>) => postJson("/api/rules/add", rule),
  deleteRule: (id: string) => postJson("/api/rules/delete", { id }),

  saveSettings: async (settings: NovaSettings) => {
    const out = await postJson("/api/settings", settings);
    if (isTauriRuntime()) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("apply_snap_zone", {
          zone: settings.snapZone,
          monitorIndex: settings.monitorIndex,
        });
        await invoke("toggle_detached_orb", { visible: settings.detachedOrbVisible });
      } catch {
        // Ignore outside Tauri window
      }
    }
    return out;
  },

  setSecret: (name: string, value: string) => postJson<{ ok: boolean; error?: string }>("/api/secrets/set", { name, value }),
  applyAntigravityHooks: (action: "install" | "uninstall" | "disable_coucou" | "enable_coucou") =>
    postJson<{ ok: boolean; backupPath?: string; error?: string }>("/api/hooks/antigravity", { action }),

  sendChat: (payload: {
    threadId: string;
    content: string;
    provider?: string;
    model?: string;
    personaId?: string;
    imageDataUrl?: string | null;
    attachedFile?: string | null;
  }) => postJson<{ ok: boolean; reply?: string; error?: string }>("/api/chat/send", payload),

  newChatThread: (personaId?: string) => postJson<{ ok: boolean; threadId: string }>("/api/chat/new", { personaId }),
  deleteChatThread: (id: string) => postJson("/api/chat/delete", { id }),

  captureScreenSnip: () => postJson<{ ok: boolean; dataUrl?: string; error?: string }>("/api/context/snip", {}),
  copyToClipboard: (text: string) => postJson("/api/context/clipboard-copy", { text }),
  toggleClipboardPin: (id: string) => postJson("/api/context/clipboard-pin", { id }),

  focusSessionWindow: (conversationId: string) => postJson("/api/workspace/focus", { conversationId }),
  openInEditor: (filePath: string, line?: number, editor?: string) =>
    postJson("/api/workspace/open-editor", { filePath, line, editor }),
  launchSession: (workspacePath: string, agentCli: string, initialPrompt?: string) =>
    postJson("/api/workspace/launch", { workspacePath, agentCli, initialPrompt }),
  openExternalUrl: (url: string) => postJson("/api/workspace/open-url", { url }),

  controlFocusTimer: (action: "start" | "pause" | "reset" | "set_mode", mode?: string, goal?: string) =>
    postJson("/api/focus/control", { action, mode, goal }),
  saveTodos: (todos: TodoItem[]) => postJson("/api/focus/todos", todos),
  saveScratchpad: (text: string) => postJson("/api/focus/scratchpad", { text }),

  transcribeAudioBlob: async (blob: Blob, autoPaste: boolean) => {
    const token = await resolveAuthToken();
    const form = new FormData();
    form.append("file", blob, "dictation.webm");
    form.append("autoPaste", String(autoPaste));
    const res = await fetch(`${getApiBase()}/api/voice/transcribe`, {
      method: "POST",
      headers: token ? { "X-Nova-Token": token } : undefined,
      body: form,
    });
    return (await res.json()) as { ok: boolean; text?: string; raw?: string; error?: string };
  },
  processVoiceText: (rawText: string, autoPaste: boolean) =>
    postJson<{ ok: boolean; text: string }>("/api/voice/process-text", { rawText, autoPaste }),
  saveVoiceNote: (title: string, mode: "meeting" | "memo", transcript: string, durationSec: number) =>
    postJson<{ ok: boolean; note: VoiceNote }>("/api/voice/save-note", { title, mode, transcript, durationSec }),
  toggleVoiceNoteAction: (noteId: string, actionId: string) =>
    postJson("/api/voice/toggle-action", { noteId, actionId }),
  saveDictionary: (terms: TechTerm[]) => postJson("/api/voice/dictionary", terms),
  saveSnippets: (snippets: VoiceSnippet[]) => postJson("/api/voice/snippets", snippets),

  exportDevlogMarkdown: () => getJson<{ ok: boolean; markdown: string }>("/api/recap/devlog"),

  setIslandExpanded: async (
    expanded: boolean,
    zone: string,
    monitorIndex: number,
    foldedW?: number,
    foldedH?: number
  ) => {
    if (!isTauriRuntime()) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("apply_snap_zone", {
        zone,
        monitorIndex,
        expanded,
        foldedW,
        foldedH,
      });
    } catch {
      // ignore
    }
  },
  setIslandRect: async (x: number, y: number, w: number, h: number) => {
    if (!isTauriRuntime()) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_island_rect", { x, y, w, h });
    } catch {
      // ignore
    }
  },
  onIslandPointer: async (
    handler: (payload: { inside: boolean; x: number; y: number }) => void
  ): Promise<() => void> => {
    if (!isTauriRuntime()) return () => {};
    try {
      const { listen } = await import("@tauri-apps/api/event");
      const unlisten = await listen<{ inside: boolean; x: number; y: number }>(
        "nova-island-pointer",
        (ev) => handler(ev.payload)
      );
      return unlisten;
    } catch {
      return () => {};
    }
  },
  setIslandPassthrough: async (ignore: boolean) => {
    if (!isTauriRuntime()) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_island_passthrough", { ignore });
    } catch {
      // ignore
    }
  },
  focusIslandWindow: async () => {
    if (!isTauriRuntime()) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("focus_island_window");
    } catch {
      // ignore
    }
  },
  openHubWindow: async () => {
    if (isTauriRuntime()) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("show_hub_window");
        return;
      } catch {
        // fallback below
      }
    }
    window.open("/?surface=hub", "_blank");
  },
};

export function connectNovaRealtime(handlers: {
  onSnapshot: (snap: NovaSnapshot) => void;
  onFocusTick: (focus: FocusState) => void;
}) {
  let ws: WebSocket | null = null;
  let closed = false;
  let retryTimer: number | undefined;
  let soundEnabledRef = true;

  const connect = async () => {
    if (closed) return;
    try {
      const wsUrl = await getWsUrl();
      if (closed) return;
      ws = new WebSocket(wsUrl);
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          if (msg.type === "snapshot" && msg.data) {
            const snap = msg.data as NovaSnapshot;
            soundEnabledRef = snap.settings.soundEnabled;
            handlers.onSnapshot(snap);
            if (msg.sound) {
              playNovaCue(msg.sound as SoundCue, soundEnabledRef);
            }
          } else if (msg.type === "focus_tick" && msg.data) {
            handlers.onFocusTick(msg.data as FocusState);
          }
        } catch {
          // ignore malformed frame
        }
      };
      ws.onclose = () => {
        if (!closed) {
          retryTimer = window.setTimeout(connect, 1500);
        }
      };
    } catch {
      retryTimer = window.setTimeout(connect, 2000);
    }
  };

  connect();

  return () => {
    closed = true;
    if (retryTimer) window.clearTimeout(retryTimer);
    ws?.close();
  };
}
