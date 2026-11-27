import React, { useState } from "react";
import { FolderOpen } from "lucide-react";
import { Lang, t } from "../i18n";
import { NovaSnapshot } from "../types";
import { novaApi } from "../lib/novaClient";
import { getRecentProjectPaths, rememberRecentProjectPath } from "../lib/projectHistory";
import { withNativeDialog } from "../lib/nativeDialog";
import { NovaOrb } from "./NovaOrb";

export const ProjectSelectHero: React.FC<{
  snapshot: NovaSnapshot;
  lang: Lang;
  aura: NovaSnapshot["settings"]["aura"];
  compact?: boolean;
  onSelectWorkspace?: (path: string) => void | Promise<void>;
}> = ({ snapshot, lang, aura, compact = false, onSelectWorkspace }) => {
  const [notice, setNotice] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [recentPaths, setRecentPaths] = useState<string[]>(getRecentProjectPaths);
  const recent = recentPaths.map((path) => ({
        path,
        name: snapshot.recentWorkspaces?.find((workspace) => workspace.path.toLowerCase() === path.toLowerCase())?.name
          || path.split(/[\\/]/).filter(Boolean).pop()
          || path,
      }));

  const openProject = async (path: string) => {
    setOpening(true);
    setNotice(null);
    try {
      if (onSelectWorkspace) {
        await onSelectWorkspace(path);
        setRecentPaths(getRecentProjectPaths());
        return;
      }
      const result = await novaApi.openInEditor(path, undefined, "antigravity");
      const response = result as { ok?: boolean; error?: string };
      if (response.ok === false) throw new Error(response.error || "Could not open project.");
      setRecentPaths(rememberRecentProjectPath(path));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not open project.");
    } finally {
      setOpening(false);
    }
  };

  const chooseProject = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await withNativeDialog(() => open({ directory: true, multiple: false, title: lang === "th" ? "เลือกโฟลเดอร์โปรเจกต์" : "Select project folder" }));
      if (typeof selected === "string") await openProject(selected);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : (lang === "th" ? "เปิดตัวเลือกโฟลเดอร์ไม่ได้" : "Could not open the folder picker."));
    }
  };

  return (
    <section
      className={`project-select-hero ${compact ? "compact" : ""}`}
      aria-labelledby={!compact ? "project-select-title" : undefined}
      aria-label={compact ? (lang === "th" ? "เลือกโปรเจกต์" : "Select a project") : undefined}
    >
      {!compact && (
        <>
          <div className="project-select-orb-frame"><NovaOrb mode="orb" aura={aura} state="idle" size={76} /></div>
          <div className="project-select-status"><span className="hub-empty-status-dot" /> {t(lang, "readyWhenYouAre")}</div>
          <div className="project-select-copy">
            <h2 id="project-select-title">{lang === "th" ? "เลือกโปรเจกต์" : "Choose a project"}</h2>
            <p>{lang === "th" ? "เลือกโฟลเดอร์โปรเจกต์เพื่อเปิดใน Antigravity" : "Select a project folder to open it in Antigravity."}</p>
          </div>
        </>
      )}
      <button className="nova-btn nova-btn-primary project-select-button" onClick={() => void chooseProject()} disabled={opening}>
        <FolderOpen size={15} /> {opening ? (lang === "th" ? "กำลังเปิด…" : "Opening…") : (lang === "th" ? "เลือกโฟลเดอร์โปรเจกต์" : "Choose project folder")}
      </button>
      {recent.length > 0 && (
        <div className="project-select-recents">
          <span>{lang === "th" ? "ล่าสุด" : "Recent"}</span>
          <div className="project-select-recent-list">
            {recent.slice(0, 6).map((project) => (
              <button key={project.path} type="button" className="project-select-recent" title={project.path} onClick={() => void openProject(project.path)} disabled={opening}>
                <FolderOpen size={13} /> {project.name}
              </button>
            ))}
          </div>
        </div>
      )}
      {notice && <p role="status" className="project-select-notice">{notice}</p>}
    </section>
  );
};
