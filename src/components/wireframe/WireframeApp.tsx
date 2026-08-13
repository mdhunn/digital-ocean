import { useEffect, useState, type ComponentType } from "react";
import { DigitalClock } from "./DigitalClock";
import { ControlPanel } from "./ControlPanel";

export function WireframeApp() {
  const [Scene, setScene] = useState<ComponentType | null>(null);

  useEffect(() => {
    let cancelled = false;
    void import("./WireframeScene").then((mod) => {
      if (!cancelled) setScene(() => mod.WireframeScene);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="app-shell">
      <div className="canvas-host">{Scene ? <Scene /> : null}</div>
      <DigitalClock />
      <ControlPanel />
    </div>
  );
}
