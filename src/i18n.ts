export type Lang = "en" | "th";

const STRINGS: Record<string, { en: string; th: string }> = {
  missionControl: { en: "Mission Control", th: "ศูนย์ควบคุมเอเจนต์" },
  missionDescription: {
    en: "Monitor parallel Antigravity workspaces, subagent swarms, live file diffs, and smart approvals.",
    th: "ติดตาม Workspace ของ Antigravity, งานจาก Subagent, การเปลี่ยนแปลงไฟล์ และคำขออนุมัติได้ในที่เดียว",
  },
  readyWhenYouAre: { en: "READY WHEN YOU ARE", th: "พร้อมเมื่อคุณเริ่ม" },
  nothingRunning: { en: "Nothing running yet", th: "ยังไม่มีเซสชันที่กำลังทำงาน" },
  connectAntigravityHint: {
    en: "Connect Antigravity to see live workspaces, approvals, and file changes here.",
    th: "เชื่อมต่อ Antigravity เพื่อดู Workspace ที่กำลังทำงาน คำขออนุมัติ และการเปลี่ยนแปลงไฟล์ที่นี่",
  },
  setupAntigravity: { en: "Set up Antigravity", th: "ตั้งค่า Antigravity" },
  quickChat: { en: "AI Chat & Context", th: "แชท AI & บริบทหน้าจอ" },
  voiceSuite: { en: "Voice & Notes", th: "สั่งงานเสียง & จดประชุม" },
  devTools: { en: "Dev & Focus", th: "เครื่องมือ Dev & โฟกัส" },
  commandPlaceholder: {
    en: "Search workspaces, approve commands, kill ports, clipboard, or ask NOVA...",
    th: "ค้นหาโปรเจกต์, อนุมัติคำสั่ง, ปิดพอร์ต, คลิปบอร์ด หรือถาม NOVA...",
  },
  activeAgents: { en: "active", th: "กำลังทำงาน" },
  waitingApproval: { en: "approval waiting", th: "รออนุมัติ" },
  idleReady: { en: "NOVA Ready", th: "NOVA พร้อมทำงาน" },
  allowOnce: { en: "Allow Once", th: "อนุญาตครั้งนี้" },
  allowSession: { en: "Allow Session", th: "อนุญาตตลอดเซสชัน" },
  allowRepo: { en: "Always in Repo", th: "อนุญาตในโปรเจกต์นี้เสมอ" },
  deny: { en: "Deny", th: "ปฏิเสธ" },
  askTerminal: { en: "Reply in IDE", th: "ตอบใน IDE" },
  openHub: { en: "Settings", th: "ตั้งค่า" },
  foldIsland: { en: "Fold Island", th: "พับเก็บ" },
  screenSnip: { en: "Screen Snip", th: "แคปหน้าจอส่ง AI" },
  clipboardHistory: { en: "Clipboard", th: "ประวัติคลิปบอร์ด" },
  portsManager: { en: "Localhost Ports", th: "จัดการพอร์ต Localhost" },
  hardwareMonitor: { en: "Hardware Load", th: "สถานะ CPU / RAM / GPU" },
  novadoro: { en: "Novadoro Focus", th: "จับเวลาโฟกัส Novadoro" },
  mediaPill: { en: "Windows Media", th: "ควบคุมเพลง & มีเดีย" },
  githubPill: { en: "GitHub PRs & CI", th: "GitHub PR & สถานะ CI" },
  hooksAndRules: { en: "Antigravity Hooks & Rules", th: "ตั้งค่า Hook & กฎอนุมัติอัตโนมัติ" },
  aiAndKeys: { en: "AI Providers & Keys", th: "ตั้งค่าโมเดล AI & คีย์ความปลอดภัย" },
  bilingualVoice: { en: "Flow Bilingual Voice (EN/TH)", th: "พิมพ์ด้วยเสียง ไทย+อังกฤษ" },
  meetingNotetaker: { en: "Meeting & Memo Notetaker", th: "สรุปประชุม & บันทึกเสียง" },
  recapInsights: { en: "Dev Recap & Devlog", th: "สรุปสถิติงาน & ส่งออก Devlog" },
  mobileAndRemote: { en: "Mobile QR PWA & Telegram", th: "เชื่อมต่อมือถือ QR & Telegram" },
  appearanceShortcuts: { en: "Appearance, Zones & Hotkeys", th: "ธีม, ตำแหน่งเกาะ & คีย์ลัด" },
  startDictation: { en: "Hold or Click to Dictate (TH/EN)", th: "คลิกเพื่อพูดพิมพ์ ไทย/อังกฤษ" },
  stopDictation: { en: "Stop & Transcribe", th: "หยุดและแปลงเสียงเป็นข้อความ" },
  jumpWindow: { en: "Focus Window", th: "สลับไปหน้าต่างงาน" },
  launchSession: { en: "Launch Agent Session", th: "เปิดเซสชันเอเจนต์ใหม่" },
  noActiveSessions: {
    en: "No active sessions right now — start a task in Antigravity or launch a workspace session below.",
    th: "ยังไม่มีเซสชันที่กำลังทำงาน — เริ่มงานใน Antigravity หรือเปิดเซสชันใหม่ด้านล่าง",
  },
};

export function t(lang: Lang, key: keyof typeof STRINGS | string): string {
  const entry = STRINGS[key];
  if (!entry) return String(key);
  return entry[lang] ?? entry.en;
}
