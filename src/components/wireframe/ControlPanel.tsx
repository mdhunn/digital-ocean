import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Maximize2,
  Minimize2,
  Minus,
  Orbit,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { cameraInput, useOceanStore } from "./oceanStore";
import { resumeOceanAudio, setOceanMusic, unlockOceanAudio } from "./oceanAudio";

function isFullscreenActive() {
  const doc = document as Document & { webkitFullscreenElement?: Element | null };
  return Boolean(document.fullscreenElement || doc.webkitFullscreenElement);
}

async function enterFullscreen() {
  const el = document.documentElement as HTMLElement & {
    webkitRequestFullscreen?: () => Promise<void> | void;
  };
  const req = el.requestFullscreen?.bind(el) ?? el.webkitRequestFullscreen?.bind(el);
  if (req) await req();
}

async function exitFullscreen() {
  const doc = document as Document & { webkitExitFullscreen?: () => Promise<void> | void };
  const exit = document.exitFullscreen?.bind(document) ?? doc.webkitExitFullscreen?.bind(doc);
  if (exit) await exit();
}

function HoldButton({
  label,
  className,
  onHold,
  children,
}: {
  label: string;
  className?: string;
  onHold: (down: boolean) => void;
  children: ReactNode;
}) {
  const holding = useRef(false);

  const end = useCallback(() => {
    if (!holding.current) return;
    holding.current = false;
    onHold(false);
  }, [onHold]);

  const start = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic events have no active pointer */
      }
      holding.current = true;
      onHold(true);
    },
    [onHold],
  );

  useEffect(() => end, [end]);

  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      onPointerDown={start}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
    >
      {children}
    </button>
  );
}

export function ControlPanel() {
  const panelOpen = useOceanStore((s) => s.panelOpen);
  const setPanelOpen = useOceanStore((s) => s.setPanelOpen);
  const fullscreen = useOceanStore((s) => s.fullscreen);
  const setFullscreen = useOceanStore((s) => s.setFullscreen);
  const musicOn = useOceanStore((s) => s.musicOn);
  const setMusicOn = useOceanStore((s) => s.setMusicOn);
  const autoRotate = useOceanStore((s) => s.autoRotate);
  const setAutoRotate = useOceanStore((s) => s.setAutoRotate);

  useEffect(() => {
    const sync = () => setFullscreen(isFullscreenActive());
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, [setFullscreen]);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") resumeOceanAudio();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", resumeOceanAudio);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", resumeOceanAudio);
    };
  }, []);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (isFullscreenActive()) await exitFullscreen();
      else await enterFullscreen();
    } catch {
      /* iOS / denied — UI stays in current state via event */
    }
    setFullscreen(isFullscreenActive());
  }, [setFullscreen]);

  const toggleMusic = useCallback(() => {
    unlockOceanAudio();
    const next = !useOceanStore.getState().musicOn;
    setOceanMusic(next);
    setMusicOn(next);
  }, [setMusicOn]);

  const toggleSpin = useCallback(() => {
    setAutoRotate(!useOceanStore.getState().autoRotate);
  }, [setAutoRotate]);

  const resetView = useCallback(() => {
    cameraInput.resetSeq += 1;
  }, []);

  return (
    <div className="ctrl-dock">
      {panelOpen ? (
        <div className="ctrl-panel" role="dialog" aria-label="Controls">
          <div className="ctrl-head">
            <span className="ctrl-title">Controls</span>
            <button
              type="button"
              className="ctrl-icon-btn"
              aria-label="Close"
              onClick={() => setPanelOpen(false)}
            >
              <X size={18} strokeWidth={1.75} />
            </button>
          </div>

          <div className="ctrl-row">
            <button
              type="button"
              className="ctrl-chip"
              data-on={fullscreen ? "1" : "0"}
              aria-pressed={fullscreen}
              aria-label="Fullscreen"
              onClick={() => void toggleFullscreen()}
            >
              {fullscreen ? (
                <Minimize2 size={16} strokeWidth={1.75} />
              ) : (
                <Maximize2 size={16} strokeWidth={1.75} />
              )}
              <span>Full</span>
            </button>
            <button
              type="button"
              className="ctrl-chip"
              data-on={musicOn ? "1" : "0"}
              aria-pressed={musicOn}
              aria-label="Music"
              onClick={toggleMusic}
            >
              {musicOn ? (
                <Volume2 size={16} strokeWidth={1.75} />
              ) : (
                <VolumeX size={16} strokeWidth={1.75} />
              )}
              <span>Music</span>
            </button>
          </div>

          <div className="ctrl-section">
            <span className="ctrl-kicker">Camera</span>
            <div className="ctrl-row">
              <button
                type="button"
                className="ctrl-chip"
                aria-label="Reset camera"
                onClick={resetView}
              >
                <RotateCcw size={16} strokeWidth={1.75} />
                <span>Reset</span>
              </button>
              <button
                type="button"
                className="ctrl-chip"
                data-on={autoRotate ? "1" : "0"}
                aria-pressed={autoRotate}
                aria-label="Auto orbit"
                onClick={toggleSpin}
              >
                <Orbit size={16} strokeWidth={1.75} />
                <span>Spin</span>
              </button>
            </div>

            <div className="ctrl-zoom">
              <HoldButton
                label="Zoom out"
                className="ctrl-pad-btn"
                onHold={(down) => {
                  cameraInput.zoom = down ? -1 : 0;
                }}
              >
                <Minus size={18} strokeWidth={1.85} />
              </HoldButton>
              <span className="ctrl-zoom-label">Zoom</span>
              <HoldButton
                label="Zoom in"
                className="ctrl-pad-btn"
                onHold={(down) => {
                  cameraInput.zoom = down ? 1 : 0;
                }}
              >
                <Plus size={18} strokeWidth={1.85} />
              </HoldButton>
            </div>

            <div className="ctrl-pad">
              <span className="ctrl-pad-spacer" />
              <HoldButton
                label="Look up"
                className="ctrl-pad-btn"
                onHold={(down) => {
                  cameraInput.pol = down ? 1 : 0;
                }}
              >
                <ChevronUp size={20} strokeWidth={1.85} />
              </HoldButton>
              <span className="ctrl-pad-spacer" />
              <HoldButton
                label="Look left"
                className="ctrl-pad-btn"
                onHold={(down) => {
                  cameraInput.az = down ? 1 : 0;
                }}
              >
                <ChevronLeft size={20} strokeWidth={1.85} />
              </HoldButton>
              <span className="ctrl-pad-center" aria-hidden />
              <HoldButton
                label="Look right"
                className="ctrl-pad-btn"
                onHold={(down) => {
                  cameraInput.az = down ? -1 : 0;
                }}
              >
                <ChevronRight size={20} strokeWidth={1.85} />
              </HoldButton>
              <span className="ctrl-pad-spacer" />
              <HoldButton
                label="Look down"
                className="ctrl-pad-btn"
                onHold={(down) => {
                  cameraInput.pol = down ? -1 : 0;
                }}
              >
                <ChevronDown size={20} strokeWidth={1.85} />
              </HoldButton>
              <span className="ctrl-pad-spacer" />
            </div>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="ctrl-fab"
          aria-label="Controls"
          onClick={() => setPanelOpen(true)}
        >
          <SlidersHorizontal size={20} strokeWidth={1.75} />
        </button>
      )}
    </div>
  );
}
