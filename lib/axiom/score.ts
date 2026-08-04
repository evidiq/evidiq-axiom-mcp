// The pure, versioned scoring function — an outsider can recompute the score
// from the attestation set and the recorded on-chain observations alone (§11).
// No wall-clock reads, no hidden decay, no re-reads mid-computation.

export const SCORE_VERSION = "1.0.0";

export type ObservationKind = "total_value" | "token_scan" | "approvals" | "activities" | "pnl";

export interface OnchainObservation {
  address: string;
  kind: ObservationKind;
  payload: Record<string, unknown>;
  observedAt: string;
  ref?: string; // block or snapshot reference when the API exposes one
}

export interface AttestationFactor {
  seq: number;
  proofType: "a2a_job" | "x402_tx" | "challenge_response";
  proofRef: string;
  valueUsdt: number;
  attesterStanding: number; // 0..1, the attester's own normalised standing
  weight: number;
  verified: boolean;
  frozen: boolean;
}

export interface ScoreResult {
  score: number; // 0-100
  scoreVersion: string;
  factors: {
    solvency: number | null;
    assetQuality: number | null;
    approvalExposure: number | null;
    activity: number | null;
    tradingPnL: number | null;
    behavioural: number | null;
  };
  familiesProven: string[];
  familiesUnproven: string[];
  evidenceCount: number;
  notes: string[];
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

// ── attestation weight (PLAN §4: weight scales with proven value × attester standing) ──

export const PROOF_TYPE_MULTIPLIER: Record<AttestationFactor["proofType"], number> = {
  a2a_job: 1.0, // full value — a job that reached a terminal state
  x402_tx: 0.8, // settlement proves payment, not necessarily delivery
  challenge_response: 0.3, // availability only, never outcome
};

/**
 * The standing floor: an attester below this normalised standing contributes
 * approximately nothing (§4 — a brand-new address vouching for a brand-new
 * address must not move the score). The attestation is still stored; it just
 * carries zero weight until the attester's own standing is established.
 */
export const STANDING_FLOOR = 0.1;

export function attestationWeight(
  proofType: AttestationFactor["proofType"],
  valueUsdt: number,
  attesterStanding: number
): number {
  if (attesterStanding < STANDING_FLOOR) return 0;
  return valueUsdt * attesterStanding * PROOF_TYPE_MULTIPLIER[proofType];
}

// ── factor functions ─────────────────────────────────────────────────────────

function solvencyScore(totalValueUsdt: number | null): number | null {
  if (totalValueUsdt === null || totalValueUsdt < 0) return null;
  if (totalValueUsdt >= 10_000) return 100;
  if (totalValueUsdt >= 1_000) return 80;
  if (totalValueUsdt >= 300) return 60;
  if (totalValueUsdt >= 100) return 40;
  if (totalValueUsdt >= 10) return 20;
  if (totalValueUsdt > 0) return 10;
  return 0;
}

function assetQualityScore(payload: Record<string, unknown>): number | null {
  const total = Number(payload.totalValueUsdt ?? 0);
  const honeypot = Number(payload.honeypotValueUsdt ?? 0);
  const highTax = Number(payload.highTaxValueUsdt ?? 0);
  if (total <= 0) return null;
  const bad = (honeypot * 2 + highTax) / total; // honeypots count double — they cannot move
  return clamp(Math.round(100 * (1 - bad)), 0, 100);
}

function approvalExposureScore(payload: Record<string, unknown>): number | null {
  const unlimitedUnknown = Number(payload.unlimitedApprovalsToUnknown ?? 0);
  if (payload.checked === false) return null;
  return clamp(100 - 20 * unlimitedUnknown, 0, 100);
}

function activityScore(payload: Record<string, unknown>, nowIso: string): number | null {
  const last = payload.lastActivityAt as string | undefined;
  if (!last) return null;
  const ageMs = Date.parse(nowIso) - Date.parse(last);
  if (Number.isNaN(ageMs)) return null;
  const days = ageMs / 86_400_000;
  if (days < 1) return 100;
  if (days < 3) return 80;
  if (days < 7) return 60;
  if (days < 30) return 40;
  if (days < 90) return 20;
  return 10;
}

function tradingPnlScore(payload: Record<string, unknown>): number | null {
  if (payload.isTradingAgent !== true) return null;
  const pnl = Number(payload.pnlUsdt ?? 0);
  const base = Number(payload.baseUsdt ?? 1) || 1;
  const pnlPct = (pnl / base) * 100;
  if (pnlPct >= 20) return 100;
  if (pnlPct >= 5) return 80;
  if (pnlPct >= 0) return 60;
  if (pnlPct >= -5) return 40;
  if (pnlPct >= -20) return 20;
  return 0;
}

function behaviouralScore(attestations: AttestationFactor[]): number | null {
  const totalWeight = attestations
    .filter((a) => a.verified && !a.frozen)
    .reduce((acc, a) => acc + a.weight, 0);
  if (totalWeight <= 0) return null;
  if (totalWeight >= 500) return 100;
  if (totalWeight >= 200) return 90;
  if (totalWeight >= 100) return 80;
  if (totalWeight >= 50) return 70;
  if (totalWeight >= 20) return 60;
  if (totalWeight >= 10) return 50;
  if (totalWeight >= 5) return 40;
  if (totalWeight >= 1) return 30;
  return 20;
}

// ── the score ────────────────────────────────────────────────────────────────

export function computeScore(
  observations: OnchainObservation[],
  attestations: AttestationFactor[],
  opts: { nowIso: string }
): ScoreResult {
  const byKind = (kind: ObservationKind) =>
    observations.filter((o) => o.kind === kind).sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];

  const tv = byKind("total_value");
  const ts = byKind("token_scan");
  const ap = byKind("approvals");
  const ac = byKind("activities");
  const pn = byKind("pnl");

  const factors = {
    solvency: tv ? solvencyScore(Number(tv.payload.totalValueUsdt ?? null)) : null,
    assetQuality: ts ? assetQualityScore(ts.payload) : null,
    approvalExposure: ap ? approvalExposureScore(ap.payload) : null,
    activity: ac ? activityScore(ac.payload, opts.nowIso) : null,
    tradingPnL: pn ? tradingPnlScore(pn.payload) : null,
    behavioural: behaviouralScore(attestations),
  };

  const proven: [keyof typeof factors, string][] = [
    ["solvency", "solvency"],
    ["assetQuality", "asset-quality"],
    ["approvalExposure", "approval-exposure"],
    ["activity", "activity"],
    ["tradingPnL", "trading-pnl"],
    ["behavioural", "proven-interactions"],
  ];
  const familiesProven = proven.filter(([k]) => factors[k] !== null).map(([, name]) => name);
  const familiesUnproven = proven.filter(([k]) => factors[k] === null).map(([, name]) => name);

  const values = Object.values(factors).filter((v): v is number => v !== null);
  const score = values.length > 0 ? clamp(Math.round(values.reduce((a, b) => a + b, 0) / values.length), 0, 100) : 0;

  const notes: string[] = [];
  if (familiesUnproven.includes("proven-interactions")) {
    notes.push("behavioural family unproven: no verified interactions on record yet — this is the honest state at launch, not a penalty");
  }
  if (attestations.length > 0) {
    const unverified = attestations.filter((a) => !a.verified).length;
    if (unverified > 0) notes.push(`${unverified} submission(s) stored unverified and excluded from the score`);
    const storedWeight = attestations.filter((a) => a.verified && !a.frozen).reduce((acc, a) => acc + a.weight, 0);
    if (storedWeight === 0) {
      notes.push("attestation(s) recorded but carry negligible weight — attester standing below the contribution floor");
    }
  }
  if (attestations.some((a) => a.frozen)) notes.push("one or more attestations are frozen by an open dispute and excluded from the score");

  return {
    score,
    scoreVersion: SCORE_VERSION,
    factors,
    familiesProven,
    familiesUnproven,
    evidenceCount: values.length,
    notes,
  };
}
