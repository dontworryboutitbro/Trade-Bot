// Safe challenger generation. Parameter ranges are HARDCODED below — Claude
// may suggest values via strict JSON, but anything outside these ranges is
// rejected and deterministic code alone decides what gets stored. No code
// generation, no SQL, no risk-limit or mode changes are possible from here.

import type { StrategyVersion } from "./types";

export const MAX_NEW_CHALLENGERS_PER_WEEK = 3;

/** Hardcoded allowed ranges per strategy family. Anything else is rejected. */
export const PARAM_RANGES: Record<string, Record<string, { min: number; max: number; step: number }>> = {
  "trend-pullback": {
    maShort: { min: 10, max: 30, step: 5 },
    maLong: { min: 40, max: 100, step: 10 },
    pullbackMin: { min: 1, max: 4, step: 1 },
    pullbackMax: { min: 4, max: 10, step: 1 },
    stopLossPct: { min: 3, max: 8, step: 1 },
    maxHoldingDays: { min: 10, max: 40, step: 5 },
  },
  "relative-momentum": {
    lookback: { min: 21, max: 126, step: 21 },
    momentumMinPct: { min: 3, max: 12, step: 1 },
    maLong: { min: 40, max: 100, step: 10 },
    stopLossPct: { min: 4, max: 10, step: 1 },
    maxHoldingDays: { min: 21, max: 63, step: 7 },
  },
  "mean-reversion": {
    window: { min: 3, max: 10, step: 1 },
    oversoldPct: { min: -8, max: -2, step: 1 },
    supportBufferPct: { min: 3, max: 12, step: 1 },
    stopLossPct: { min: 2, max: 6, step: 1 },
    maxHoldingDays: { min: 5, max: 15, step: 1 },
  },
  "defensive-rotation": {
    ma: { min: 10, max: 50, step: 5 },
    stopLossPct: { min: 3, max: 8, step: 1 },
    maxHoldingDays: { min: 15, max: 45, step: 5 },
  },
};

export function validateChallengerParams(
  familyId: string,
  params: Record<string, number>,
): { ok: boolean; reasons: string[] } {
  const ranges = PARAM_RANGES[familyId];
  if (!ranges) return { ok: false, reasons: [`No challenger ranges defined for ${familyId}.`] };
  const reasons: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    const range = ranges[key];
    if (!range) {
      reasons.push(`Parameter ${key} is not tunable for ${familyId}.`);
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      reasons.push(`Parameter ${key} must be a finite number.`);
    } else if (value < range.min || value > range.max) {
      reasons.push(`${key}=${value} outside [${range.min}, ${range.max}].`);
    }
  }
  if (Object.keys(params).length === 0) reasons.push("No parameters provided.");
  return { ok: reasons.length === 0, reasons };
}

/**
 * Deterministic systematic variants: nudge one parameter at a time by one step
 * in the direction suggested by recent results (provided by the caller as a
 * simple preference), seeded by a date string for reproducibility.
 */
export function generateSystematicVariants(
  familyId: string,
  championParams: Record<string, number>,
  dateSeed: string,
  maxVariants: number,
): Record<string, number>[] {
  const ranges = PARAM_RANGES[familyId];
  if (!ranges) return [];
  const paramKeys = Object.keys(ranges);
  // Deterministic seed → which params to nudge today.
  let hash = 0;
  for (const ch of `${familyId}:${dateSeed}`) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  const variants: Record<string, number>[] = [];
  for (let i = 0; i < paramKeys.length && variants.length < maxVariants; i++) {
    const key = paramKeys[(Math.abs(hash) + i) % paramKeys.length];
    const range = ranges[key];
    const current = championParams[key] ?? (range.min + range.max) / 2;
    const direction = (Math.abs(hash) + i) % 2 === 0 ? 1 : -1;
    const next = current + direction * range.step;
    if (next < range.min || next > range.max) continue;
    if (next === current) continue;
    variants.push({ ...championParams, [key]: next });
  }
  return variants;
}

export function nextVersionId(familyId: string, existing: StrategyVersion[]): string {
  const numbers = existing
    .filter((v) => v.familyId === familyId)
    .map((v) => Number(v.versionId.split("@")[1] ?? 0));
  return `${familyId}@${Math.max(1, ...numbers) + 1}`;
}
