export interface ProcessAncestor {
  pid: number;
  name: string;
}

export interface ShortcutBinding {
  id: string;
  label: string;
  accelerator: string;
  enabled: boolean;
  altgrConflict?: string | null;
}

export type PermissionMode = "follow_agy" | "turbo" | "smart_auto" | "request_review";

export interface NovaSettings {
  theme: "obsidian" | "acrylic" | "tactical";
  aura: "cyan" | "amber" | "violet" | "emerald";
  avatarMode: "orb" | "hud";
  snapZone: "top-center" | "top-left" | "top-right" | "bottom-dock" | "free";
  monitorIndex: number;
  followActiveMonitor: boolean;
  dwellMs: number;
  suppressFullscreen: boolean;
  soundEnabled: boolean;
  customSoundsDir: string;
  language: "en" | "th";
  permissionMode?: PermissionMode;
  guardCriticalInFollow?: boolean;
  autoApproveSafeReads: boolean;
  agyApproveInIsland: boolean;
  sttProvider: "groq" | "gemini" | "openai" | "webspeech";
  bilingualCleanup: boolean;
  defaultChatProvider: string;
  defaultChatModel: string;
  ollamaUrl: string;
  lmstudioUrl: string;
  remoteLanEnabled: boolean;
  telegramEnabled: boolean;
  detachedOrbVisible: boolean;
  autostart: boolean;
  shortcuts: ShortcutBinding[];
}

export interface RiskAssessment {
  level: "safe" | "low" | "medium" | "high" | "critical";
  score: number;
  reasons: string[];
  tags: string[];
  suggestedRulePattern?: string | null;
}

export interface FileDiffPreview {
  filePath: string;
  addedLines: number;
  removedLines: number;
  unifiedDiff: string;
  timestamp: string;
  startLine?: number | null;
  undoTarget?: string | null;
  undoReplacement?: string | null;
  reverted?: boolean;
}

export interface SessionStep {
  id: string;
  callId?: string | null;
  stepIdx?: number | null;
  event: string;
  toolName?: string | null;
  summary: string;
  detail?: string | null;
  verb?: string;
  filePath?: string | null;
  lineRange?: string | null;
  startLine?: number | null;
  addedLines?: number | null;
  removedLines?: number | null;
  status: "running" | "done" | "error" | "waiting";
  timestamp: string;
}

export interface PlanStepItem {
  title: string;
  status: "pending" | "in_progress" | "done" | "skipped" | "failed" | string;
}

export interface FocusGroup {
  id: string;
  title: string;
  explicitFocus?: boolean;
  startedAt: string;
  endedAt?: string | null;
  steps: SessionStep[];
}

export interface SubagentNode {
  id: string;
  role: string;
  status: string;
  startedAt: string;
}

export interface AgentSession {
  conversationId: string;
  agent: string;
  workspacePath: string;
  workspaceName: string;
  gitBranch?: string | null;
  modelName?: string | null;
  lastUserInput?: string | null;
  status: "active" | "waiting_approval" | "idle" | "completed" | "error";
  phase?: "thinking" | "working" | "waiting_approval" | "done" | "error" | "idle" | string;
  currentFocus?: string | null;
  midProcessNote?: string | null;
  latestThinking?: string | null;
  latestOutput?: string | null;
  planSteps?: PlanStepItem[];
  focusGroups?: FocusGroup[];
  transcriptPath?: string | null;
  queuedMessages?: string[];
  stopRequested?: boolean;
  bgRunning?: boolean;
  cliConversationId?: string | null;
  lastError?: string | null;
  detectedIdePermission?: string | null;
  permissionOverride?: PermissionMode | string | null;
  activeTool?: string | null;
  steps: SessionStep[];
  diffs: FileDiffPreview[];
  subagents: SubagentNode[];
  processChain: ProcessAncestor[];
  startedAt: string;
  updatedAt: string;
  commandsCount: number;
  filesTouchedCount: number;
}

export interface PendingApproval {
  id: string;
  conversationId: string;
  agent: string;
  workspacePath: string;
  workspaceName: string;
  gitBranch?: string | null;
  toolName: string;
  commandLine?: string | null;
  targetFile?: string | null;
  toolArgs: Record<string, unknown>;
  risk: RiskAssessment;
  diffPreview?: FileDiffPreview | null;
  createdAt: string;
  expiresInSec: number;
}

export interface ApprovalRule {
  id: string;
  action: "allow" | "deny";
  scope: "session" | "workspace" | "global";
  scopeTarget?: string | null;
  toolMatcher: string;
  pattern: string;
  label: string;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  thinking?: string | null;
  provider?: string | null;
  model?: string | null;
  imageDataUrl?: string | null;
  attachedFile?: string | null;
  timestamp: string;
}

export interface ChatPersona {
  id: string;
  name: string;
  icon: string;
  systemPrompt: string;
}

export interface ChatThread {
  id: string;
  title: string;
  personaId: string;
  messages: ChatMessage[];
  updatedAt: string;
}

export interface ClipboardEntry {
  id: string;
  kind: "text" | "code" | "path" | "url";
  content: string;
  preview: string;
  pinned: boolean;
  timestamp: string;
}

export interface TechTerm {
  spoken: string;
  canonical: string;
}

export interface VoiceSnippet {
  trigger: string;
  expansion: string;
}

export interface ActionItem {
  id: string;
  text: string;
  done: boolean;
}

export interface VoiceNote {
  id: string;
  title: string;
  mode: "meeting" | "memo" | "dictation";
  language: string;
  rawTranscript: string;
  summary: string;
  actionItems: ActionItem[];
  durationSec: number;
  wordCount: number;
  createdAt: string;
}

export interface PortProcessInfo {
  port: number;
  proto: string;
  localAddress: string;
  pid: number;
  processName: string;
  frameworkHint?: string | null;
}

export interface GpuTelemetry {
  name: string;
  loadPercent: number;
  vramUsedMb: number;
  vramTotalMb: number;
  tempC?: number | null;
}

export interface TopProcessInfo {
  pid: number;
  name: string;
  cpuPercent: number;
  memoryMb: number;
}

export interface HardwareTelemetry {
  cpuPercent: number;
  cpuBrand: string;
  coreCount: number;
  ramUsedGb: number;
  ramTotalGb: number;
  ramPercent: number;
  gpu?: GpuTelemetry | null;
  topProcesses: TopProcessInfo[];
  fullscreenActive: boolean;
}

export interface MediaStatus {
  active: boolean;
  playing: boolean;
  title: string;
  artist: string;
  sourceApp: string;
}

export interface GitHubPullItem {
  number: number;
  title: string;
  repo: string;
  url: string;
  state: string;
  draft: boolean;
  updatedAt: string;
}

export interface GitHubWorkflowItem {
  id: number;
  name: string;
  repo: string;
  status: string;
  conclusion?: string | null;
  branch: string;
  url: string;
}

export interface GitHubOverview {
  connected: boolean;
  username?: string | null;
  avatarUrl?: string | null;
  myPrs: GitHubPullItem[];
  reviewRequests: GitHubPullItem[];
  recentRuns: GitHubWorkflowItem[];
  fetchedAt?: string | null;
  error?: string | null;
}

export interface TodoItem {
  id: string;
  text: string;
  completed: boolean;
  createdAt: string;
}

export interface FocusState {
  running: boolean;
  mode: "focus" | "short_break" | "long_break";
  remainingSec: number;
  totalSec: number;
  currentGoal: string;
  completedBlocksToday: number;
  totalFocusMinutes: number;
  todos: TodoItem[];
  scratchpadMarkdown: string;
}

export interface AnalyticsCounters {
  totalSessions: number;
  totalCommandsInspected: number;
  approvalsAllowed: number;
  approvalsDenied: number;
  approvalsAutoPassed: number;
  filesEdited: number;
  linesAdded: number;
  linesRemoved: number;
  dictationsCount: number;
  dictatedWords: number;
  focusMinutes: number;
  topWorkspaces: Record<string, number>;
}

export interface AgyHookStatus {
  hooksJsonPath: string;
  hookBinaryPath: string;
  hookBinaryExists: boolean;
  novaInstalled: boolean;
  novaEnabled: boolean;
  coucouDetected: boolean;
  coucouEnabled: boolean;
  diffPreview: string;
  proposedJson: string;
}

export interface SecretPresenceMap {
  gemini: boolean;
  anthropic: boolean;
  openai: boolean;
  groq: boolean;
  openrouter: boolean;
  github: boolean;
  telegramToken: boolean;
  telegramChatId: boolean;
}

export interface MobilePairingInfo {
  enabled: boolean;
  lanIp: string;
  port: number;
  mobileUrl: string;
  pairingToken: string;
  qrSvg: string;
  telegramConfigured: boolean;
  telegramEnabled: boolean;
}

export interface WorkspaceEntry {
  name: string;
  path: string;
}

export interface NovaSnapshot {
  version: string;
  settings: NovaSettings;
  sessions: AgentSession[];
  pendingApprovals: PendingApproval[];
  approvalRules: ApprovalRule[];
  threads: ChatThread[];
  personas: ChatPersona[];
  clipboardHistory: ClipboardEntry[];
  techDictionary: TechTerm[];
  voiceSnippets: VoiceSnippet[];
  voiceNotes: VoiceNote[];
  focus: FocusState;
  analytics: AnalyticsCounters;
  agyHooks: AgyHookStatus;
  secrets: SecretPresenceMap;
  mobile: MobilePairingInfo;
  recentWorkspaces?: WorkspaceEntry[];
  agyCliAvailable?: boolean;
  detectedIdePermission?: string | null;
}
