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
      setTelemetry(hw);
      setPorts(pt);
      setMedia(md);
    } catch {
      // ignore transient error during boot
    }
  }, []);

  useEffect(() => {
    novaApi.fetchSnapshot().then(setSnapshot).catch(() => {});
    refreshSystem();
    novaApi.fetchGitHub().then(setGithub).catch(() => {});

    const disconnect = connectNovaRealtime({
      onSnapshot: (snap) => setSnapshot(snap),
      onFocusTick: (focus) =>
        setSnapshot((prev) => (prev ? { ...prev, focus } : prev)),
    });

    const sysInterval = window.setInterval(refreshSystem, 5000);
    return () => {
      disconnect();
      window.clearInterval(sysInterval);
    };
  }, [refreshSystem]);

  if (!snapshot) {
    return (
      <div className="nova-boot-screen">
        <div className="boot-pulse" />
        <span>Connecting to NOVA Core Engine...</span>
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
