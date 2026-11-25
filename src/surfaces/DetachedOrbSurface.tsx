import React from "react";
import { Minimize2 } from "lucide-react";
import { NovaSnapshot } from "../types";
import { NovaOrb, OrbState } from "../components/NovaOrb";
import { isTauriRuntime, novaApi } from "../lib/novaClient";

interface DetachedOrbSurfaceProps {
  snapshot: NovaSnapshot;
}

export const DetachedOrbSurface: React.FC<DetachedOrbSurfaceProps> = ({ snapshot }) => {
  const { settings, sessions, pendingApprovals, focus } = snapshot;
  const activeCount = sessions.filter(
    (s) => s.status === "active" || s.status === "waiting_approval"
  ).length;

  const orbState: OrbState =
    pendingApprovals.length > 0 ? "alert" : activeCount > 0 ? "active" : "idle";

  const startDrag = async () => {
    if (!isTauriRuntime()) return;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().startDragging();
    } catch {
      // ignore
    }
  };

  return (
    <div
      className={`nova-detached-orb theme-${settings.theme} aura-${settings.aura}`}
      onMouseDown={startDrag}
    >
      <NovaOrb
        mode={settings.avatarMode}
        aura={settings.aura}
        state={orbState}
        size={46}
        activeCount={activeCount}
      />
      <div className="detached-info">
        <div className="detached-title">
          NOVA {pendingApprovals.length > 0 ? `• !${pendingApprovals.length} Alert` : ""}
        </div>
        <div className="detached-sub">
          {activeCount} active · {Math.floor(focus.remainingSec / 60)}m focus
        </div>
      </div>
      <button
        className="nova-icon-btn"
        title="Dock back into Island"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() =>
          novaApi.saveSettings({ ...settings, detachedOrbVisible: false })
        }
      >
        <Minimize2 size={13} />
      </button>
    </div>
  );
};
