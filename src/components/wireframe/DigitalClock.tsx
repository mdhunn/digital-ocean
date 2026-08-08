import { useCallback, useEffect, useMemo, useState } from "react";

export type ClockMode = "12" | "24" | "hidden";

const STORAGE_KEY = "wireframe-ocean-clock-mode-v2";
const MODES: ClockMode[] = ["24", "12", "hidden"];
const DEFAULT_MODE: ClockMode = "24";
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"] as const;

function readMode(): ClockMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "12" || raw === "24" || raw === "hidden") return raw;
  } catch {
    /* ignore */
  }
  return DEFAULT_MODE;
}

function formatTime(now: Date, mode: "12" | "24") {
  if (mode === "24") {
    const h = String(now.getHours()).padStart(2, "0");
    const m = String(now.getMinutes()).padStart(2, "0");
    const s = String(now.getSeconds()).padStart(2, "0");
    return `${h}:${m}:${s}`;
  }

  let hours = now.getHours() % 12;
  if (hours === 0) hours = 12;
  const m = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  const ampm = now.getHours() >= 12 ? "PM" : "AM";
  return `${hours}:${m}:${s} ${ampm}`;
}

function buildMonthGrid(year: number, month: number) {
  const first = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const startDow = first.getDay();
  const cells: (number | null)[] = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export function DigitalClock() {
  const [mounted, setMounted] = useState(false);
  const [mode, setMode] = useState<ClockMode>(DEFAULT_MODE);
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setMounted(true);
    setMode(readMode());
    setNow(new Date());
    const id = window.setInterval(() => setNow(new Date()), 250);
    return () => window.clearInterval(id);
  }, []);

  const cycle = useCallback(() => {
    setMode((prev) => {
      const idx = MODES.indexOf(prev);
      const next = MODES[(idx + 1) % MODES.length]!;
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const year = now?.getFullYear() ?? 0;
  const month = now?.getMonth() ?? 0;
  const dayNum = now?.getDate() ?? 0;
  const monthLabel = now
    ? now.toLocaleString("en-US", { month: "short" }).toUpperCase()
    : "";
  const dateLine = now ? `${monthLabel} ${String(dayNum).padStart(2, "0")}` : "";
  const timeLine = now && mode !== "hidden" ? formatTime(now, mode) : "";

  const cells = useMemo(() => {
    if (!now) return [] as (number | null)[];
    return buildMonthGrid(year, month);
  }, [now, year, month]);

  if (!mounted || !now) {
    return (
      <div className="clock-dock">
        <button type="button" className="clock-btn" data-mode="24" aria-label="Clock">
          <span className="clock-date">&nbsp;</span>
          <span className="clock-time">&nbsp;</span>
        </button>
      </div>
    );
  }

  const visible = mode !== "hidden";

  return (
    <div className="clock-dock">
      <button
        type="button"
        className="clock-btn"
        data-mode={mode}
        onClick={cycle}
        aria-label="Clock"
      >
        {visible ? (
          <>
            <span className="clock-date">{dateLine}</span>
            <span className="clock-time">{timeLine}</span>
            <div className="clock-cal" aria-hidden>
              <div className="clock-cal-week">
                {WEEKDAYS.map((d, i) => (
                  <span key={i} className="clock-cal-dow">
                    {d}
                  </span>
                ))}
              </div>
              <div className="clock-cal-grid">
                {cells.map((d, i) =>
                  d === null ? (
                    <span key={i} className="clock-cal-cell is-empty" />
                  ) : (
                    <span
                      key={i}
                      className={
                        d === dayNum
                          ? "clock-cal-cell is-today"
                          : "clock-cal-cell"
                      }
                    >
                      {d}
                    </span>
                  ),
                )}
              </div>
            </div>
          </>
        ) : (
          <span className="clock-dot" aria-hidden />
        )}
      </button>
    </div>
  );
}
