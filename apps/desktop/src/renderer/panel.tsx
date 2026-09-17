import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { LiveUpdate } from "../shared/contracts.js";
import { liveFailureText, livePanelPaused, livePanelShowsPause, liveStateLabel } from "./live-state.js";
import { createMockApi } from "./mock-api.js";
import "./styles.css";

// Outside Electron there is no main process to open this page with a live
// session already running, so the browser dev server plays a scripted one
// against the mock — the same fallback App.tsx uses for the record card —
// which is how this panel gets checked visually without a sidecar.
const browserMock = createMockApi();

/**
 * The always-on-top HUD (spec §6.3). Every decision it makes — the label,
 * whether it is paused, what the failure says, which buttons show — is a
 * pure function in `live-state.ts`; this component only reads `window.replay`
 * and lays the result out. Main resends the most recent update as soon as
 * this page finishes loading, so there is no "Starting" flash before the
 * first real state arrives.
 */
function Panel() {
  const api = window.replay ?? browserMock;
  const [update, setUpdate] = useState<LiveUpdate>();
  useEffect(() => api.onLiveUpdate(setUpdate), [api]);

  const state = update?.state ?? "starting";
  const paused = livePanelPaused(state);
  const failureText = liveFailureText(state, update?.error);

  return (
    <div className="live-panel">
      <div className="live-panel-head">
        <span className={`live-panel-state ${state}`}>{liveStateLabel(state)}</span>
        <span className={`live-share-dot ${update?.sharing ? "on" : ""}`} title="Sharing screen with Claude" />
      </div>
      <p className="live-panel-heard">{update?.heard?.text ?? "…"}</p>
      <p className="live-panel-said">{update?.said ?? ""}</p>
      {failureText ? <p className="live-panel-error">{failureText}</p> : undefined}
      {paused ? <small className="live-panel-note">Narration still recording</small> : undefined}
      <div className="live-panel-actions">
        {livePanelShowsPause(state)
          ? <button onClick={() => { void api.setLivePaused(!paused); }}>{paused ? "Resume" : "Pause"}</button>
          : undefined}
        <button onClick={() => { void api.endLive(); }}>End Live</button>
      </div>
    </div>
  );
}

const root = document.querySelector<HTMLElement>("#root");
if (!root) throw new Error("Missing panel root");

// Electron always provides `window.replay`; only the browser dev server does
// not, and that is exactly when the scripted session should start itself.
if (!window.replay) void browserMock.startRecording({ microphone: true, live: true });

createRoot(root).render(
  <StrictMode>
    <Panel />
  </StrictMode>,
);
