import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAxiomServer } from "../server.js";
import { openStore } from "../lib/axiom/store.js";
import { handleX402Gate } from "../lib/x402/gate.js";
import { StubOnchainSource } from "../lib/axiom/onchain.js";
import type { ProofVerifier } from "../lib/axiom/proof.js";
import { signDigest } from "../lib/axiom/chain.js";
import { attestationSubmissionMessage } from "../lib/axiom/attest.js";

const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // anvil #0 - throwaway, test-only
const ATTESTER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // anvil #0 address
const SUBJECT = "0x2a8efe3093278bb4bd3b2d9c7b5ba992ca4fc9b0";

let dbDir: string;
let db: ReturnType<typeof openStore>;
let handler: (req: Request) => Promise<Response>;

const stubOnchain = new StubOnchainSource({
  total_value: { address: "", kind: "total_value", payload: { totalValueUsdt: 1000 }, observedAt: "2026-08-05T00:00:00.000Z", ref: "snap-1" },
  token_scan: { address: "", kind: "token_scan", payload: { totalValueUsdt: 1000, honeypotValueUsdt: 0, highTaxValueUsdt: 0, tokenCount: 3 }, observedAt: "2026-08-05T00:00:00.000Z" },
  approvals: { address: "", kind: "approvals", payload: { checked: true, unlimitedApprovalsToUnknown: 0 }, observedAt: "2026-08-05T00:00:00.000Z" },
  activities: { address: "", kind: "activities", payload: { activityCount: 4, lastActivityAt: "2026-08-04T00:00:00.000Z" }, observedAt: "2026-08-05T00:00:00.000Z" },
  pnl: { address: "", kind: "pnl", payload: { isTradingAgent: true, pnlUsdt: 50, baseUsdt: 300 }, observedAt: "2026-08-05T00:00:00.000Z" },
});

const stubVerifier: ProofVerifier = {
  async verifyJob(jobId) {
    return { ok: true, terminalState: "done" };
  },
  async verifySettlementTx(txHash) {
    if (txHash === "0xnotonchain") return { ok: false, reason: "transaction not found on chain" };
    return { ok: true, from: ATTESTER, to: SUBJECT };
  },
  async verifyChallenge(challenge) {
    return { ok: challenge.subject.toLowerCase() === SUBJECT.toLowerCase() };
  },
};

beforeAll(async () => {
  process.env.AXIOM_SIGNER_PRIVATE_KEY = TEST_KEY;
  process.env.AXIOM_X402_BYPASS = "1";
  process.env.X402_PAY_TO = SUBJECT;
  dbDir = await mkdtemp(join(tmpdir(), "axiom-test-"));
  db = openStore(join(dbDir, "test.db"));
  const inner = createAxiomServer({
    db,
    onchain: stubOnchain,
    proofVerifier: stubVerifier,
    signerAvailable: true,
    clientIp: () => "test-ip",
  });
  handler = (req) => handleX402Gate(req, inner);
});

afterAll(() => {
  delete process.env.AXIOM_SIGNER_PRIVATE_KEY;
  delete process.env.AXIOM_X402_BYPASS;
  delete process.env.X402_PAY_TO;
  db.close();
});

async function call(name: string, args: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const res = await handler(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    })
  );
  let body: any;
  try {
    body = await res.json();
  } catch {
    body = await res.text();
  }
  return { status: res.status, body };
}

async function textOf(res: { status: number; body: any }): Promise<any> {
  if (typeof res.body === "string") return JSON.parse(res.body);
  return JSON.parse(res.body.result.content[0].text);
}

async function attesterSignature(args: {
  subject: string;
  proofType: string;
  proofRef: string;
  valueUsdt: number;
  terminalState?: string | null;
}): Promise<string> {
  const digest = "0x" + require("node:crypto").createHash("sha256").update(attestationSubmissionMessage(args), "utf8").digest("hex");
  const { signature } = await signDigest(digest, TEST_KEY);
  return signature;
}

describe("Axiom MCP server (bypass on)", () => {
  it("lists exactly the eleven tools of §5", async () => {
    const res = await handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      })
    );
    const body = await res.json();
    const names = (body.result.tools as { name: string }[]).map((t) => t.name);
    expect(names.length).toBe(11);
    for (const free of ["axiom_capabilities", "wallet_profile", "verify_attestation", "trust_score", "estimate_cost"]) {
      expect(names).toContain(free);
    }
    for (const paid of ["attest_interaction", "recommend_agent", "verify_claim", "credit_report", "dispute_attestation", "reputation_watch"]) {
      expect(names).toContain(paid);
    }
  });

  it("free tools answer bare {} with 200", async () => {
    for (const name of ["axiom_capabilities", "wallet_profile", "verify_attestation", "trust_score", "estimate_cost", "reputation_watch"]) {
      const res = await call(name, {});
      expect(res.status).toBe(200);
      const t = await textOf(res);
      expect(t.ok).toBeDefined();
    }
  });

  it("estimate_cost matches the price ladder", async () => {
    const t = await textOf(await call("estimate_cost", { tool: "dispute_attestation" }));
    expect(t.amountAtomic).toBe("30000");
    expect(t.amountHuman).toBe("0.03 USDT0");
  });

  it("wallet_profile returns the on-chain footprint without marketplace fields", async () => {
    const t = await textOf(await call("wallet_profile", { address: SUBJECT }));
    expect(t.ok).toBe(true);
    expect(t.totalValueUsdt).toBe(1000);
    expect(t.tokenCount).toBe(3);
    expect(t.attestationCount).toBe(0);
    expect(t.boundary).toMatch(/never/);
  });

  it("trust_score returns a defensible number with zero attestations, behavioural named unproven", async () => {
    const t = await textOf(await call("trust_score", { address: SUBJECT }));
    expect(t.ok).toBe(true);
    expect(t.scoreVersion).toBe("1.0.0");
    expect(t.score).toBeGreaterThan(0);
    expect(t.familiesProven).toContain("solvency");
    expect(t.familiesUnproven).toContain("proven-interactions");
    expect(t.behaviouralFamily).toBe("no proven interactions yet");
  });

  it("attest_interaction records a verified attestation from the signature-derived attester", async () => {
    const submission = { subject: SUBJECT, proofType: "x402_tx", proofRef: "0xtx123", valueUsdt: 100 };
    const signature = await attesterSignature(submission);
    const t = await textOf(await call("attest_interaction", { ...submission, attesterSignature: signature }));
    expect(t.ok).toBe(true);
    expect(t.status).toBe("verified");
    expect(t.signer).toBeDefined();
    expect(t.anchor).toBeDefined();
    expect(t.seq).toBe(0);
  });

  it("S1 live: self-attestation is rejected (subject == recovered attester)", async () => {
    const submission = { subject: ATTESTER, proofType: "a2a_job", proofRef: "job-self", valueUsdt: 100, terminalState: "done" };
    const signature = await attesterSignature(submission);
    const t = await textOf(await call("attest_interaction", { ...submission, attesterSignature: signature }));
    expect(t.status).toBe("unverified");
    expect(t.reason).toMatch(/self-attestation/);
  });

  it("S2 live: replaying the same proof is stored unverified (one per proof)", async () => {
    const submission = { subject: SUBJECT, proofType: "a2a_job", proofRef: "job-dup", valueUsdt: 50, terminalState: "done" };
    const signature = await attesterSignature(submission);
    const first = await textOf(await call("attest_interaction", { ...submission, attesterSignature: signature }));
    const second = await textOf(await call("attest_interaction", { ...submission, attesterSignature: signature }));
    expect(first.status).toBe("verified");
    expect(second.status).toBe("unverified");
    expect(second.reason).toMatch(/already used/);
  });

  it("S3 live: an unverifiable proof is stored unverified with an honest receipt", async () => {
    const submission = { subject: SUBJECT, proofType: "x402_tx", proofRef: "0xnotonchain", valueUsdt: 10 };
    const signature = await attesterSignature(submission);
    const t = await textOf(await call("attest_interaction", { ...submission, attesterSignature: signature }));
    expect(t.status).toBe("unverified");
    expect(t.note).toMatch(/does not count/);
  });

  it("verify_attestation detects a removed record (sequence gap)", async () => {
    // Re-store a verified attestation so the middle of the chain exists, then
    // delete it and verify the chain walk reports the gap instead of silence.
    const sub = { subject: SUBJECT, proofType: "a2a_job", proofRef: "job-gap", valueUsdt: 40, terminalState: "done" };
    const r = await textOf(await call("attest_interaction", { ...sub, attesterSignature: await attesterSignature(sub) }));
    expect(r.status).toBe("verified");
    const middleSeq = r.seq as number;
    const victim = db.prepare(`SELECT seq FROM attestations WHERE proof_ref = 'job-gap'`).get() as { seq: number } | undefined;
    expect(victim).toBeDefined();
    db.prepare(`DELETE FROM attestations WHERE seq = ?`).run(victim!.seq);
    const last = db.prepare(`SELECT MAX(seq) AS m FROM attestations`).get() as { m: number | null };
    const t = await textOf(await call("verify_attestation", { seq: last.m ?? 0 }));
    expect(t.ok).toBe(true);
    expect(t.chainOk).toBe(false);
    expect(t.chainGaps.some((g: string) => g.includes("sequence gap"))).toBe(true);
  });

  it("verify_attestation checks signature and anchor of a stored receipt", async () => {
    const t = await textOf(await call("verify_attestation", { seq: 0 }));
    expect(t.ok).toBe(true);
    expect(t.signatureValid).toBe(true);
    expect(t.anchor).not.toBeNull();
  });

  it("credit_report returns the underwriting picture", async () => {
    const t = await textOf(await call("credit_report", { address: SUBJECT }));
    expect(t.ok).toBe(true);
    expect(t.solvency.totalValueUsdt).toBe(1000);
    expect(t.assetQuality).toBeDefined();
    expect(t.approvalExposure).toBeDefined();
    expect(t.attestations).toBeDefined();
    expect(t.boundary).toMatch(/never/);
  });

  it("verify_claim returns verified with citations for a settled claim", async () => {
    const t = await textOf(await call("verify_claim", { claim: "this agent can pay a 50 USDT job", address: SUBJECT }));
    expect(t.ok).toBe(true);
    expect(t.verdict).toBe("verified");
    expect(t.citations.length).toBeGreaterThan(0);
    expect(t.draftedBy).toBe("mechanical");
  });

  it("verify_claim returns insufficient evidence for an unsettled claim", async () => {
    const t = await textOf(await call("verify_claim", { claim: "this agent delivered on schedule last week", address: SUBJECT }));
    expect(t.verdict).toBe("insufficient evidence");
  });

  it("dispute_attestation freezes the challenged attestation's weight", async () => {
    const candidate = db.prepare(`SELECT seq FROM attestations WHERE status = 'verified' AND frozen = 0 ORDER BY seq LIMIT 1`).get() as { seq: number } | undefined;
    expect(candidate).toBeDefined();
    const t = await textOf(await call("dispute_attestation", { attestationSeq: candidate!.seq, reason: "the proof reference is fabricated" }));
    expect(t.ok).toBe(true);
    expect(t.effect).toMatch(/frozen/);
    expect(t.dispute.state).toBe("open");
    // frozen attestation no longer contributes: behavioural family back to unproven
    const score = await textOf(await call("trust_score", { address: SUBJECT }));
    expect(score.familiesUnproven).toContain("proven-interactions");
  });

  it("recommend_agent with no attested standing is an honest empty answer", async () => {
    const t = await textOf(await call("recommend_agent", { task: "settle a 50 USDT invoice", candidates: ["0xDEADBEEF00000000000000000000000000000000"] }));
    expect(t.ok).toBe(true);
    expect(t.finding).toMatch(/no candidates|insufficient evidence/i);
  });
});

describe("§17 #6 — the Compass boundary is enforced mechanically", () => {
  it("no response surface contains a marketplace metric", async () => {
    const surfaces: string[] = [];
    const responses = [
      await textOf(await call("axiom_capabilities", {})),
      await textOf(await call("wallet_profile", { address: SUBJECT })),
      await textOf(await call("trust_score", { address: SUBJECT })),
      await textOf(await call("credit_report", { address: SUBJECT })),
      await textOf(await call("verify_claim", { claim: "can pay", address: SUBJECT })),
      await textOf(await call("recommend_agent", { task: "x", candidates: [SUBJECT] })),
      await textOf(await call("dispute_attestation", { attestationSeq: 2, reason: "test" })),
    ];
    for (const r of responses) {
      surfaces.push(JSON.stringify(r));
    }
    for (const surface of surfaces) {
      expect(surface.toLowerCase()).not.toContain("soldcount");
      expect(surface.toLowerCase()).not.toContain("feedbackrate");
      expect(surface.toLowerCase()).not.toContain("securityrate");
      expect(surface.toLowerCase()).not.toContain('"rating"');
    }
  });
});

describe("§7 — the free-tool rate limit degrades, never rejects", () => {
  it("past the soft threshold trust_score still returns 200 with reduced detail and a rateNote", async () => {
    let degraded: any = null;
    for (let i = 0; i < 102; i++) {
      const t = await textOf(await call("trust_score", { address: "0x9999999999999999999999999999999999999999" }));
      if (t.rateNote) {
        degraded = t;
        break;
      }
    }
    expect(degraded).not.toBeNull();
    expect(degraded.score).toBeDefined();
    expect(degraded.evidenceCount).toBeDefined();
    expect(degraded.factors).toBeUndefined();
    expect(degraded.rateNote).toMatch(/soft rate limit/);
  });
});
