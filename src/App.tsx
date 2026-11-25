import React, { useCallback, useEffect, useState } from "react";
import {
  GitHubOverview,
  HardwareTelemetry,
  MediaStatus,
  NovaSnapshot,
  PortProcessInfo,
} from "./types";
import { connectNovaRealtime, novaApi } from "./lib/novaClient";
import { IslandSurface } from "./surfaces/IslandSurface";
import { HubSurface } from "./surfaces/HubSurface";
import { DetachedOrbSurface } from "./surfaces/DetachedOrbSurface";
import { MobilePwaSurface } from "./surfaces/MobilePwaSurface";

export const App: React.FC = () => {
  const [snapshot, setSnapshot] = useState<NovaSnapshot | null>(null);
  const [telemetry, setTelemetry] = useState<HardwareTelemetry | null>(null);
  const [ports, setPorts] = useState<PortProcessInfo[]>([]);
  const [media, setMedia] = useState<MediaStatus | null>(null);
  const [github, setGithub] = useState<GitHubOverview | null>(null);
  const [bootTimedOut, setBootTimedOut] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setBootTimedOut(true), 2500);
    return () => window.clearTimeout(timer);
  }, []);

  const surface = (() => {
    const params = new URLSearchParams(window.location.search);
    const s = params.get("surface");
    if (s === "island" || s === "orb" || s === "mobile" || s === "hub") return s;
    if (window.innerWidth <= 620) return "mobile";
    return "hub";
  })();

  useEffect(() => {
    document.body.dataset.surface = surface;
    document.documentElement.dataset.surface = surface;
  }, [surface]);

  const refreshSystem = useCallback(async () => {
    try {
      const [hw, pt, md] = await Promise.all([
        novaApi.fetchTelemetry(),
        novaApi.fetchPorts(),
        novaApi.fetchMedia(),
      ]);
      if (hw && typeof hw.cpuPercent === "number") setTelemetry(hw);
      if (Array.isArray(pt)) setPorts(pt);
      if (md && typeof md.active === "boolean") setMedia(md);
    } catch {
      // ignore transient error during boot
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    let bootRetryTimer: number | undefined;

    const loadInitialSnapshot = async () => {
      try {
        const snap = await novaApi.fetchSnapshot();
        if (mounted && snap && snap.settings && Array.isArray(snap.sessions)) {
          setSnapshot(snap);
          return;
        }
      } catch {
        // Core HTTP server may still be binding during initial boot; retry shortly
      }
      if (mounted) {
        bootRetryTimer = window.setTimeout(loadInitialSnapshot, 600);
      }
    };

    void loadInitialSnapshot();
    refreshSystem();
    novaApi.fetchGitHub().then(setGithub).catch(() => {});

    const disconnect = connectNovaRealtime({
      onSnapshot: (snap) => {
        if (snap && snap.settings && Array.isArray(snap.sessions)) {
          if (bootRetryTimer) {
            window.clearTimeout(bootRetryTimer);
            bootRetryTimer = undefined;
          }
          setSnapshot(snap);
        }
      },
      onFocusTick: (focus) =>
        setSnapshot((prev) => (prev ? { ...prev, focus } : prev)),
    });

    const sysInterval = window.setInterval(refreshSystem, 5000);
    return () => {
      mounted = false;
      if (bootRetryTimer) window.clearTimeout(bootRetryTimer);
      disconnect();
      window.clearInterval(sysInterval);
    };
  }, [refreshSystem]);

  if (!snapshot) {
    if ((surface === "island" || surface === "orb") && !bootTimedOut) {
      return null;
    }
    return (
      <div className="nova-boot-screen">
        <div className="boot-pulse" />
        <span>Connecting to NOVA Core Engine...</span>
        {bootTimedOut && (
          <div style={{ marginTop: 12, textAlign: "center", maxWidth: 360 }}>
            <p style={{ fontSize: 11, color: "#94a3b8", marginBottom: 8 }}>
              If opening in a browser, enter your IPC Token (found in <code>%LOCALAPPDATA%\NOVA\ipc.token</code>) or click Connect:
            </p>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type="text"
                placeholder="Paste IPC token..."
                id="manual-token-input"
                style={{
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.15)",
                  color: "#fff",
                  padding: "4px 8px",
                  borderRadius: 6,
                  fontSize: 11,
                  flex: 1,
                }}
              />
              <button
                type="button"
                onClick={() => {
                  const val = (document.getElementById("manual-token-input") as HTMLInputElement)?.value.trim();
                  if (val) {
                    try {
                      localStorage.setItem("nova_token", val);
                    } catch {}
                    window.location.search = `?surface=${surface}&token=${encodeURIComponent(val)}`;
                  }
                }}
                style={{
                  background: "#38bdf8",
                  color: "#0b0f19",
                  border: "none",
                  padding: "4px 10px",
                  borderRadius: 6,
                  fontWeight: 600,
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                Connect
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (surface === "island") {
    return (
      <IslandSurface
        snapshot={snapshot}
        telemetry={telemetry}
        ports={ports}
        media={media}
        github={github}
        onRefreshSystem={refreshSystem}
      />
    );
  }

  if (surface === "orb") {
    return <DetachedOrbSurface snapshot={snapshot} />;
  }

  if (surface === "mobile") {
    return <MobilePwaSurface snapshot={snapshot} />;
  }

  return (
    <HubSurface
      snapshot={snapshot}
      telemetry={telemetry}
      ports={ports}
      media={media}
      github={github}
      onRefreshSystem={refreshSystem}
    />
  );
};
