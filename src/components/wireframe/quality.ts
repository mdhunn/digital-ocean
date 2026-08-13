export type QualityTier = "high" | "medium" | "low";

export type QualityParams = {
  tier: QualityTier;
  oceanW: number;
  oceanD: number;
  deepW: number;
  deepD: number;
  dprMax: number;
  coralSway: boolean;
  oceanStride: number;
};

const PARAMS: Record<QualityTier, QualityParams> = {
  high: {
    tier: "high",
    oceanW: 140,
    oceanD: 108,
    deepW: 36,
    deepD: 28,
    dprMax: 1.65,
    coralSway: true,
    oceanStride: 1,
  },
  medium: {
    tier: "medium",
    oceanW: 96,
    oceanD: 74,
    deepW: 28,
    deepD: 22,
    dprMax: 1.35,
    coralSway: true,
    oceanStride: 1,
  },
  low: {
    tier: "low",
    oceanW: 68,
    oceanD: 52,
    deepW: 22,
    deepD: 16,
    dprMax: 1.15,
    coralSway: false,
    oceanStride: 2,
  },
};

export function detectInitialQuality(): QualityTier {
  if (typeof window === "undefined") return "medium";
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const short = Math.min(window.innerWidth, window.innerHeight) < 520;
  const cores = navigator.hardwareConcurrency || 4;
  const mem =
    (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  if (cores <= 2 || mem <= 2) return "low";
  if (coarse || short || cores <= 4 || mem <= 4) return "medium";
  return "high";
}

export function qualityParams(tier: QualityTier): QualityParams {
  return PARAMS[tier];
}

export function softItersFor(base: number, tier: QualityTier): number {
  const cut = tier === "low" ? 2 : tier === "medium" ? 1 : 0;
  return Math.max(2, base - cut);
}

export const qualityRuntime: { tier: QualityTier; params: QualityParams } = {
  tier: "high",
  params: PARAMS.high,
};

export function initQuality(): QualityParams {
  const tier = detectInitialQuality();
  qualityRuntime.tier = tier;
  qualityRuntime.params = PARAMS[tier];
  return qualityRuntime.params;
}

export function dropQuality(): QualityParams | null {
  const next: QualityTier | null =
    qualityRuntime.tier === "high"
      ? "medium"
      : qualityRuntime.tier === "medium"
        ? "low"
        : null;
  if (!next) return null;
  qualityRuntime.tier = next;
  qualityRuntime.params = PARAMS[next];
  return qualityRuntime.params;
}
