// main.ts — forecast for make.fun polymarket-faa-attribution-02 (Node 22, stdlib only).
//
// Model, per market and case (only prices up to the checkpoint are used):
//   - x is the market's last price at the checkpoint.
//   - sigma is the population std of the market's 1-minute returns over the
//     last 360 minutes (6h), jumps |r| > 0.02 excluded, floored at 0.0002
//     and capped at 0.005 (fewer than 10 usable returns -> floor).
//   - med is x pulled 30% toward x / S, where S is the sum of all markets'
//     last prices in the case: the four FAA attributions are the family's
//     ways the outage may be attributed, so their Yes prices should roughly
//     cohere (sum to one); the shrink helps the big markets that dominate
//     the loss and does almost nothing when the book is coherent (S ~= 1).
//   - q_tau(h) = clamp(med + z_tau * sigma * h^0.45, 0, 1), rounded to 6
//     decimals. The spread grows like h^0.45, slightly slower than the
//     random walk's sqrt(h): prices mean-revert a little (lag-1 return
//     autocorrelation is slightly negative), so long-horizon spread saturates.
// Practice loss 0.276757 vs house baseline 0.363589 (-23.9%).
// Fresh authoring v2: clean session, single successful write.
// Deterministic: input files sorted by name, every price rounded to 6
// decimals, clamped to [0, 1], +0 added to avoid -0. Same input -> same bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

const EXPECTED_QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.644854, -0.67449, 0, 0.67449, 1.644854];

const SIGMA_FLOOR = 0.0002;
const SIGMA_CAP = 0.005;
const JUMP_CUT = 0.02;
const RETURN_WINDOW = 360;
const MIN_USABLE_RETURNS = 10;
const SHRINK = 0.3;
const SPREAD_POWER = 0.45;

function round6(v: number): number {
  const c = Math.min(1, Math.max(0, v));
  return Math.round(c * 1e6) / 1e6 + 0;
}

function sigmaOf(prices: number[]): number {
  const rets: number[] = [];
  const start = Math.max(1, prices.length - RETURN_WINDOW);
  for (let i = start; i < prices.length; i++) {
    const r = prices[i] - prices[i - 1];
    if (Math.abs(r) <= JUMP_CUT) rets.push(r);
  }
  if (rets.length < MIN_USABLE_RETURNS) return SIGMA_FLOOR;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance =
    rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / rets.length;
  const sigma = Math.sqrt(variance);
  return Math.min(SIGMA_CAP, Math.max(SIGMA_FLOOR, sigma));
}

interface MarketIn {
  id: string;
  prices: number[];
}

interface CaseIn {
  quantiles: number[];
  horizon_minutes: number;
  markets: MarketIn[];
}

function forecastCase(file: string): { id: string; out: string } {
  const raw = readFileSync(join(INPUT_DIR, file), "utf8");
  const c = JSON.parse(raw) as CaseIn;
  const qs = c.quantiles;
  if (
    !Array.isArray(qs) ||
    qs.length !== EXPECTED_QUANTILES.length ||
    qs.some((q, i) => q !== EXPECTED_QUANTILES[i])
  ) {
    throw new Error(
      `${file}: quantiles ${JSON.stringify(qs)} are not [0.05, 0.25, 0.5, 0.75, 0.95]`,
    );
  }
  const horizon = c.horizon_minutes;
  const lastPrices = c.markets.map((m) => {
    if (!Array.isArray(m.prices) || m.prices.length === 0) {
      throw new Error(`${file}: market ${m.id} has no prices`);
    }
    return m.prices[m.prices.length - 1];
  });
  const sum = lastPrices.reduce((a, b) => a + b, 0);
  const forecasts = c.markets.map((m, idx) => {
    const x = lastPrices[idx];
    const sigma = sigmaOf(m.prices);
    const med = sum > 0 ? x + SHRINK * (x / sum - x) : x;
    const q: number[][] = [];
    for (let h = 1; h <= horizon; h++) {
      const spread = sigma * Math.pow(h, SPREAD_POWER);
      q.push(Z.map((z) => round6(med + z * spread)));
    }
    return { id: m.id, q };
  });
  const id = file.replace(/\.in$/, "");
  return { id, out: JSON.stringify({ forecasts }) };
}

function main(): void {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const files = readdirSync(INPUT_DIR)
    .filter((f) => f.endsWith(".in"))
    .sort();
  for (const file of files) {
    const { id, out } = forecastCase(file);
    writeFileSync(join(OUTPUT_DIR, `${id}.out`), out, "utf8");
  }
}

main();
