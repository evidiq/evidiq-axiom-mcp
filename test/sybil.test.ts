import { describe, expect, it } from "vitest";
import {
  attestationWeight,
  computeScore,
  OnchainObservation,
  SCORE_VERSION,
} from "../lib/axiom/score.js";
import {
  dedupeKey,
  ProofVerifier,
  ProofVerdict,
  verifyProof,
} from "../lib/axiom/proof.js";

const stubVerifier: ProofVerifier = {
  async verifyJob(jobId) {
    return { ok: true, terminalState: "done" };
  },
  async verifySettlementTx(txHash) {
    return { ok: true, from: "0xattester", to: "0xsubjectPayTo" };
  },
  async verifyChallenge(endpoint) {
    return { ok: true };
  },
};

async function run(over: {
  attester?: string;
  subject?: string;
  proof?: Parameters<typeof verifyProof>[0]["proof"];
  knownRefs?: Set<string>;
  verifier?: ProofVerifier;
}): Promise<ProofVerdict> {
  return verifyProof({
    attester: over.attester ?? "0xAAAA",
    subject: over.subject ?? "0xBBBB",
    proof:
      over.proof ?? { type: "a2a_job", jobId: "job-1", terminalState: "done", valueUsdt: 100 },
    verifier: over.verifier ?? stubVerifier,
    knownRefs: over.knownRefs ?? new Set(),
    subjectServicePayTo: "0xsubjectPayTo",
  });
}

describe("§4 Sybil rules — hard failures when violated", () => {
  it("S1: self-attestation is rejected (attester === subject)", async () => {
    const v = await run({ attester: "0xAAAA", subject: "0xAAAA" });
    expect(v.status).toBe("unverified");
    expect(v.reason).toMatch(/self-attestation/);
  });

  it("S2: one attestation per proof — replaying a proof does not add weight", async () => {
    const known = new Set([dedupeKey({ type: "a2a_job", jobId: "job-1", terminalState: "done", valueUsdt: 100 })]);
    const first = await run({ knownRefs: new Set() });
    const second = await run({ knownRefs: known });
    expect(first.status).toBe("verified");
    expect(second.status).toBe("unverified");
    expect(second.reason).toMatch(/already used/);
  });

  it("S3: an unproven submission is stored as unverified, never an error", async () => {
    const v = await run({
      verifier: { ...stubVerifier, async verifyJob() { return { ok: false, reason: "job not found" }; } },
    });
    expect(v.status).toBe("unverified");
    expect(v.reason).toMatch(/not verified/);
  });

  it("S4: new address vouching for new address is worth approximately nothing", async () => {
    // attesterStanding below the floor → weight 0 → behavioural stays unproven.
    const weight = attestationWeight("a2a_job", 1000, 0.01);
    expect(weight).toBe(0);
    const observations: OnchainObservation[] = [
      { address: "0xBBBB", kind: "total_value", payload: { totalValueUsdt: 1000 }, observedAt: "2026-08-05T00:00:00.000Z" },
    ];
    const attestations = [
      { seq: 1, proofType: "a2a_job" as const, proofRef: "job-1", valueUsdt: 1000, attesterStanding: 0.01, weight, verified: true, frozen: false },
    ];
    const res = computeScore(observations, attestations, { nowIso: "2026-08-05T00:00:00.000Z" });
    expect(res.factors.behavioural).toBeNull();
    expect(res.familiesUnproven).toContain("proven-interactions");
    expect(res.notes.some((n) => n.includes("negligible weight"))).toBe(true);
  });
});

describe("attestation weight scaling", () => {
  it("scales with proven value and attester standing, per proof type", () => {
    expect(attestationWeight("a2a_job", 100, 1)).toBe(100);
    expect(attestationWeight("x402_tx", 100, 1)).toBe(80);
    expect(attestationWeight("challenge_response", 100, 1)).toBe(30);
    expect(attestationWeight("a2a_job", 100, 0.5)).toBe(50);
  });
});

describe("computeScore (§11 determinism)", () => {
  const obs: OnchainObservation[] = [
    { address: "0xBBBB", kind: "total_value", payload: { totalValueUsdt: 1000 }, observedAt: "2026-08-05T00:00:00.000Z" },
    { address: "0xBBBB", kind: "token_scan", payload: { totalValueUsdt: 1000, honeypotValueUsdt: 0, highTaxValueUsdt: 0 }, observedAt: "2026-08-05T00:00:00.000Z" },
    { address: "0xBBBB", kind: "approvals", payload: { checked: true, unlimitedApprovalsToUnknown: 0 }, observedAt: "2026-08-05T00:00:00.000Z" },
    { address: "0xBBBB", kind: "activities", payload: { lastActivityAt: "2026-08-04T00:00:00.000Z" }, observedAt: "2026-08-05T00:00:00.000Z" },
  ];

  it("returns the scoreVersion and reproducible factors", () => {
    const a = computeScore(obs, [], { nowIso: "2026-08-05T00:00:00.000Z" });
    const b = computeScore(obs, [], { nowIso: "2026-08-05T00:00:00.000Z" });
    expect(a.scoreVersion).toBe(SCORE_VERSION);
    expect(a).toEqual(b);
  });

  it("zero-attestation agent scores from on-chain alone, behavioural named unproven", () => {
    const res = computeScore(obs, [], { nowIso: "2026-08-05T00:00:00.000Z" });
    expect(res.factors.solvency).toBe(80);
    expect(res.factors.behavioural).toBeNull();
    expect(res.familiesProven).toContain("solvency");
    expect(res.familiesUnproven).toContain("proven-interactions");
    expect(res.score).toBeGreaterThan(0);
    expect(res.evidenceCount).toBeGreaterThanOrEqual(3);
  });

  it("frozen or unverified attestations are excluded from the score", () => {
    const frozen = [{ seq: 1, proofType: "a2a_job" as const, proofRef: "job-1", valueUsdt: 1000, attesterStanding: 1, weight: 1000, verified: true, frozen: true }];
    const res = computeScore(obs, frozen, { nowIso: "2026-08-05T00:00:00.000Z" });
    expect(res.factors.behavioural).toBeNull();
    expect(res.notes.some((n) => n.includes("frozen"))).toBe(true);
  });

  it("honeypots count double against asset quality", () => {
    const bad = computeScore(
      [{ address: "0xBBBB", kind: "token_scan", payload: { totalValueUsdt: 1000, honeypotValueUsdt: 500, highTaxValueUsdt: 0 }, observedAt: "2026-08-05T00:00:00.000Z" }],
      [],
      { nowIso: "2026-08-05T00:00:00.000Z" }
    );
    expect(bad.factors.assetQuality).toBe(0);
  });

  it("score never depends on wall-clock drift — only on stored observations", () => {
    const later = computeScore(obs, [], { nowIso: "2026-08-10T00:00:00.000Z" });
    const res = computeScore(obs, [], { nowIso: "2026-08-05T00:00:00.000Z" });
    expect(later.factors.solvency).toBe(res.factors.solvency);
    expect(later.factors.assetQuality).toBe(res.factors.assetQuality);
  });
});
