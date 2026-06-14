/**
 * Small statistics helpers for the analysis models' refinements: a deterministic RNG + bootstrap
 * confidence intervals (R3, overlap-aware via cluster resampling), a two-sided p-value and
 * Benjamini–Hochberg FDR (R4, multiple comparisons across members), empirical-Bayes shrinkage
 * (R4), and OLS (R5, the α/β market model). Deterministic (seeded) so reports are reproducible.
 *
 * These quantify uncertainty; they do not turn correlation into causation — see the methodology docs.
 */

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** mulberry32 — tiny deterministic PRNG so bootstraps are reproducible across runs. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface CI {
  mean: number | null;
  lo: number | null;
  hi: number | null;
}

/**
 * Percentile bootstrap CI for the mean. Pass cluster-level values (e.g. one mean per ticker-month)
 * to make it overlap-aware: resampling whole clusters respects that nearby events share a price path.
 */
export function bootstrapMeanCI(values: number[], iters = 2000, seed = 12345, alpha = 0.05): CI {
  if (values.length === 0) return { mean: null, lo: null, hi: null };
  const m = mean(values);
  if (values.length < 3) return { mean: m, lo: null, hi: null };
  const r = rng(seed);
  const means: number[] = new Array(iters);
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < values.length; j++) s += values[Math.floor(r() * values.length)];
    means[i] = s / values.length;
  }
  means.sort((a, b) => a - b);
  return { mean: m, lo: means[Math.floor((alpha / 2) * iters)], hi: means[Math.floor((1 - alpha / 2) * iters)] };
}

function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return Math.sign(x) * y;
}

/** Two-sided p-value that the mean differs from 0 (normal approx; null when n<2 or no dispersion). */
export function twoSidedP(m: number, std: number | null, n: number): number | null {
  if (n < 2 || !std || std === 0) return null;
  const z = m / (std / Math.sqrt(n));
  const p = 2 * (1 - 0.5 * (1 + erf(Math.abs(z) / Math.SQRT2)));
  return Math.max(0, Math.min(1, p));
}

/** Benjamini–Hochberg FDR: returns, aligned to input order, whether each null hypothesis is rejected. */
export function benjaminiHochberg(pvalues: (number | null)[], q = 0.1): boolean[] {
  const valid = pvalues.map((p, i) => ({ p, i })).filter((x): x is { p: number; i: number } => x.p != null);
  const m = valid.length;
  const rej = new Array(pvalues.length).fill(false);
  if (!m) return rej;
  valid.sort((a, b) => a.p - b.p);
  let kmax = -1;
  for (let k = 0; k < m; k++) if (valid[k].p <= ((k + 1) / m) * q) kmax = k;
  for (let k = 0; k <= kmax; k++) rej[valid[k].i] = true;
  return rej;
}

/** Empirical-Bayes-ish shrink of a group mean toward the grand mean; weight n/(n+k). */
export function shrink(groupMean: number, n: number, grandMean: number, k = 10): number {
  const w = n / (n + k);
  return grandMean + w * (groupMean - grandMean);
}

/** Ordinary least squares y = alpha + beta·x. null if undetermined. */
export function ols(xs: number[], ys: number[]): { alpha: number; beta: number } | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  if (sxx === 0) return null;
  const beta = sxy / sxx;
  return { alpha: my - beta * mx, beta };
}
