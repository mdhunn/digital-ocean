import { create } from "zustand";

/** Frame-polled camera holds — not React state, so OrbitControls stay smooth. */
export const cameraInput = {
  az: 0,
  pol: 0,
  zoom: 0,
  resetSeq: 0,
  autoRotate: true,
};

export type OceanUiState = {
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;
  fullscreen: boolean;
  setFullscreen: (on: boolean) => void;
  musicOn: boolean;
  setMusicOn: (on: boolean) => void;
  autoRotate: boolean;
  setAutoRotate: (on: boolean) => void;
};

export const useOceanStore = create<OceanUiState>((set) => ({
  panelOpen: false,
  setPanelOpen: (open) => set({ panelOpen: open }),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  fullscreen: false,
  setFullscreen: (on) => set({ fullscreen: on }),
  musicOn: false,
  setMusicOn: (on) => set({ musicOn: on }),
  autoRotate: true,
  setAutoRotate: (on) => {
    cameraInput.autoRotate = on;
    set({ autoRotate: on });
  },
}));
