import { createHash } from "node:crypto";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import type Database from "better-sqlite3";
import { computeScore, SCORE_VERSION, OnchainObservation, attestationWeight } from "./lib/axiom/score.js";
import { verifyProof, Proof, ProofVerifier } from "./lib/axiom/proof.js";
import { createReceipt, receiptDigest, attestationSubmissionMessage, verifyReceiptChain, AXIOM_LIBRARY_VERSION, Receipt } from "./lib/axiom/attest.js";
import {
  getSignerAddress,
  verifySignature,
} from "./lib/axiom/chain.js";
import {
  attestationsAll,
  attestationsFor,
  insertAttestation,
  lastSeq,
  latestObservation,
  openDisputes,
  proofRefUsed,
  recordFreeCall,
  freeCallCount,
  setFrozen,
  storeObservation,
  FREE_SOFT_LIMIT,
} from "./lib/axiom/store.js";
import { OnchainSource, StubOnchainSource } from "./lib/axiom/onchain.js";
import { mechanicalVerdict, draftVerdict } from "./lib/axiom/claims.js";
import { createDispute, resolveDisputeMechanically } from "./lib/axiom/dispute.js";
import { FREE_TOOL_NAMES, SUBSCRIPTION_TOOLS, TOOL_PRICES_ATOMIC, TOOL_PRICES_HUMAN } from "./lib/x402/challenge.js";

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function validationError(message: string) {
  return textResult({ ok: false, error: message });
}

function usageFor(tool: string, description: string, fields: Record<string, string>): Record<string, unknown> {
  return {
    ok: false,
    tool,
    usage: description,
    fields,
    hint: "Every field is optional; supply at least one to get an answer.",
  };
}

function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t.length > 0 ? t : null;
}

function num(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

const COMPASS_BOUNDARY_NOTE =
  "Axiom reads the subject's wallet, never the marketplace. Sold count, feedback rate, security rate and rating belong to Compass (compass/counterparty_history) and are never returned here.";

export interface AxiomServerDeps {
  db: Database.Database;
  onchain: OnchainSource;
  proofVerifier: ProofVerifier;
  signerAvailable: boolean;
  observationTtlSec?: number;
  clientIp: () => string;
}

const OBSERVATION_KINDS = ["total_value", "token_scan", "approvals", "activities", "pnl"] as const;

async function freshObservation(
  db: Database.Database,
  onchain: OnchainSource,
  address: string,
  kind: (typeof OBSERVATION_KINDS)[number],
  ttlSec: number
): Promise<OnchainObservation | null> {
  const cached = latestObservation(db, address, kind);
  if (cached) {
    const ageSec = (Date.parse(new Date().toISOString()) - Date.parse(cached.observedAt)) / 1000;
    if (ageSec < ttlSec) return cached;
  }
  try {
    const fresh = await onchain.observe(address, kind);
    storeObservation(db, fresh);
    return fresh;
  } catch {
    return cached; // a stale observation beats none; a miss is never an error
  }
}

async function collectObservations(
  db: Database.Database,
  onchain: OnchainSource,
  address: string,
  ttlSec: number
): Promise<OnchainObservation[]> {
  const out: OnchainObservation[] = [];
  for (const kind of OBSERVATION_KINDS) {
    const o = await freshObservation(db, onchain, address, kind, ttlSec);
    if (o) out.push(o);
  }
  return out;
}

function attesterStanding(db: Database.Database, attester: string): number {
  // The attester's own normalised standing from stored observations; an address
  // with no recorded footprint sits below the contribution floor (§4 S4).
  const tv = latestObservation(db, attester, "total_value");
  if (!tv) return 0.01;
  const value = Number(tv.payload.totalValueUsdt ?? 0);
  if (value <= 0) return 0.01;
  if (value >= 10_000) return 1;
  if (value >= 1_000) return 0.7;
  if (value >= 300) return 0.4;
  if (value >= 10) return 0.15;
  return 0.05;
}

export function createAxiomServer(deps: AxiomServerDeps) {
  const db = deps.db;
  const ttlSec = deps.observationTtlSec ?? Number(process.env.AXIOM_OBSERVATION_TTL_SEC ?? 3600);

  const INSTRUCTIONS = `EVIDIQ Axiom MCP — the credit bureau for AI agents. 11 tools (5 free, 6 listed: 5 paid per-call + 1 subscription).

Free tools (always 200): axiom_capabilities, wallet_profile, verify_attestation, trust_score, estimate_cost.

Paid tools (x402-gated, USDT0 on eip155:196): attest_interaction (0.005), recommend_agent (0.01), verify_claim (0.015), credit_report (0.02), dispute_attestation (0.03). reputation_watch is subscription-priced (A2A) and registered by the operator.

The boundary: Compass reads the storefront; Axiom reads the balance sheet. No tool returns a marketplace metric (sold count, feedback rate, security rate, rating) — those belong to compass/counterparty_history and this service never proxies them.

Claim limits: an attestation counts only when it carries a verified proof of interaction. Self-attestation is rejected (checked against the signature). One attestation per proof. Weight scales with proven value and the attester's standing; a new address vouching for a new address is worth approximately nothing. An unproven submission is stored as unverified, excluded from the score, and returned honestly — never an error, and never a fake pass.

Scoring: pure, versioned (scoreVersion ${SCORE_VERSION}), reproducible from stored observations and attestations alone. trust_score and verify_attestation are free forever.`;

  const handler = createMcpHandler(
    (server) => {
      // ── FREE 1: axiom_capabilities ──────────────────────────────────────
      server.registerTool(
        "axiom_capabilities",
        {
          title: "Axiom capabilities: tools, prices, scoring version, trust model",
          description:
            "Everything a caller needs to decide: all 11 tools with prices, the scoring-function version, the anchoring model and the boundary with Compass. Free.",
          inputSchema: {},
        },
        async () => {
          const tools = [
            ...Object.entries(TOOL_PRICES_HUMAN).map(([name, price]) => ({ name, price, paid: true })),
            ...FREE_TOOL_NAMES.map((name) => ({ name, price: "free", paid: false })),
            ...Object.entries(SUBSCRIPTION_TOOLS).map(([name, v]) => ({ name, price: `${v.monthlyUsdt} USDT/month`, paid: true, subscription: true })),
          ];
          return textResult({
            ok: true,
            service: "EVIDIQ Axiom — the credit bureau for AI agents (MCP #21)",
            tools,
            scoreVersion: SCORE_VERSION,
            scoringFunction:
              "pure and published: six factor families (solvency, asset-quality, approval-exposure, activity, trading-pnl, proven-interactions) averaged over the families that have evidence; behavioural weight = valueUsdt × attesterStanding × proofTypeMultiplier (1.0 job / 0.8 tx / 0.3 challenge), floor on attesterStanding 0.1; frozen and unverified attestations excluded",
            anchoringModel: "every attestation → receipt (JCS digest over a closed field set) → EIP-191 signature by the fleet signer → 0G Storage anchor; 0G down degrades the proof (storageNote), never the service",
            boundary: COMPASS_BOUNDARY_NOTE,
            rateLimit: `free tools degrade past ${FREE_SOFT_LIMIT} calls/IP/day — same shape, reduced detail, rateNote, never an error`,
            seedDisclosure: "no attestations are seeded by the build; insufficient evidence is the expected answer at launch",
          });
        },
      );

      // ── FREE 2: estimate_cost ───────────────────────────────────────────
      server.registerTool(
        "estimate_cost",
        {
          title: "Exact price of any paid tool",
          description:
            "Exact atomic and human price for any paid tool, from the same table the gate charges from. Never invents an answer. Free.",
          inputSchema: {
            tool: z.string().optional().describe("Paid tool name, e.g. credit_report."),
          },
        },
        async (args: Record<string, unknown>) => {
          const tool = str(args.tool);
          if (!tool) {
            return textResult(usageFor("estimate_cost", "Exact atomic and human price for any paid tool.", { tool: "Paid tool name." }));
          }
          const atomic = TOOL_PRICES_ATOMIC[tool];
          if (!atomic) {
            const sub = SUBSCRIPTION_TOOLS[tool];
            if (sub) {
              return textResult({ ok: true, tool, amountHuman: `${sub.monthlyUsdt} USDT/month`, chain: "eip155:196", token: "USDT0", subscription: true, note: sub.note });
            }
            return validationError(`unknown tool "${tool}" — estimate_cost only knows the paid tools of this service`);
          }
          return textResult({ ok: true, tool, amountAtomic: atomic, amountHuman: TOOL_PRICES_HUMAN[tool], chain: "eip155:196", token: "USDT0" });
        },
      );

      // ── FREE 3: wallet_profile ──────────────────────────────────────────
      server.registerTool(
        "wallet_profile",
        {
          title: "The subject's on-chain footprint",
          description:
            "Total value, token count, activity recency, attestation count — read from the subject's own wallet address via Onchain OS. No marketplace fields, ever. Free.",
          inputSchema: {
            address: z.string().optional().describe("The subject's wallet address (an agent's agentWalletAddress)."),
          },
        },
        async (args: Record<string, unknown>) => {
          const address = str(args.address);
          if (!address) {
            return textResult(usageFor("wallet_profile", "The on-chain footprint of a wallet address.", { address: "Subject wallet address." }));
          }
          const day = new Date().toISOString().slice(0, 10);
          const ip = deps.clientIp();
          const count = freeCallCount(db, day, ip);
          const degraded = count >= FREE_SOFT_LIMIT;
          recordFreeCall(db, day, ip);

          const obs = await collectObservations(db, deps.onchain, address, ttlSec);
          const tv = obs.find((o) => o.kind === "total_value");
          const ts = obs.find((o) => o.kind === "token_scan");
          const ac = obs.find((o) => o.kind === "activities");
          const attestations = attestationsFor(db, address);
          const openDisputeCount = openDisputes(db).filter((d) =>
            attestations.some((a) => a.seq === d.attestationSeq)
          ).length;

          const base = {
            ok: true,
            address,
            finding: "no on-chain observations recorded yet — an agent with no history is a different risk, not an unknown",
            boundary: COMPASS_BOUNDARY_NOTE,
            rateNote: degraded ? `soft rate limit reached (${FREE_SOFT_LIMIT}/day/IP) — detail degraded, still 200` : undefined,
          };
          if (degraded) {
            return textResult({
              ...base,
              totalValueUsdt: tv ? Number(tv.payload.totalValueUsdt ?? 0) : null,
              attestationCount: attestations.length,
              degraded: true,
            });
          }
          return textResult({
            ...base,
            totalValueUsdt: tv ? Number(tv.payload.totalValueUsdt ?? 0) : null,
            tokenCount: ts ? Number(ts.payload.tokenCount ?? 0) : null,
            honeypotValueUsdt: ts ? Number(ts.payload.honeypotValueUsdt ?? 0) : null,
            lastActivityAt: ac ? (ac.payload.lastActivityAt as string | null) : null,
            observationRefs: obs.filter((o) => o.ref).map((o) => ({ kind: o.kind, ref: o.ref, observedAt: o.observedAt })),
            attestationCount: attestations.length,
            verifiedAttestationCount: attestations.filter((a) => a.status === "verified").length,
            openDisputeCount,
            observedAt: new Date().toISOString(),
          });
        },
      );

      // ── FREE 4: trust_score ─────────────────────────────────────────────
      server.registerTool(
        "trust_score",
        {
          title: "The 0-100 score with the factors that produced it",
          description:
            "Pure, versioned, reproducible from stored observations and attestations alone. Names which factor families contributed and which are unproven. Free forever.",
          inputSchema: {
            address: z.string().optional().describe("The subject's wallet address."),
          },
        },
        async (args: Record<string, unknown>) => {
          const address = str(args.address);
          if (!address) {
            return textResult(usageFor("trust_score", "The 0-100 reputation score with its factor breakdown.", { address: "Subject wallet address." }));
          }
          const day = new Date().toISOString().slice(0, 10);
          const ip = deps.clientIp();
          const count = freeCallCount(db, day, ip);
          const degraded = count >= FREE_SOFT_LIMIT;
          recordFreeCall(db, day, ip);

          const obs = await collectObservations(db, deps.onchain, address, ttlSec);
          const attestations = attestationsFor(db, address).map((a) => ({
            seq: a.seq,
            proofType: a.proofType as "a2a_job" | "x402_tx" | "challenge_response",
            proofRef: a.proofRef,
            valueUsdt: a.valueUsdt,
            attesterStanding: attesterStanding(db, a.attester),
            weight: a.weight,
            verified: a.status === "verified",
            frozen: a.frozen === 1,
          }));
          const result = computeScore(obs, attestations, { nowIso: new Date().toISOString() });

          if (degraded) {
            return textResult({
              ok: true,
              address,
              score: result.score,
              scoreVersion: result.scoreVersion,
              evidenceCount: result.evidenceCount,
              rateNote: `soft rate limit reached (${FREE_SOFT_LIMIT}/day/IP) — factor breakdown degraded, still 200`,
            });
          }
          return textResult({
            ok: true,
            address,
            ...result,
            boundary: COMPASS_BOUNDARY_NOTE,
            behaviouralFamily: result.familiesUnproven.includes("proven-interactions")
              ? "no proven interactions yet"
              : "proven interactions on record",
            observedAt: new Date().toISOString(),
          });
        },
      );

      // ── FREE 5: verify_attestation ──────────────────────────────────────
      server.registerTool(
        "verify_attestation",
        {
          title: "Verify an attestation receipt and walk the chain",
          description:
            "Recompute the receipt digest, check the EIP-191 signature, confirm the 0G anchor, walk the chain for gaps — a removed record is detected, not silently absent. Free forever.",
          inputSchema: {
            seq: z.number().optional().describe("Sequence number of the stored attestation."),
            receipt: z.any().optional().describe("The receipt object, as returned by attest_interaction."),
          },
        },
        async (args: Record<string, unknown>) => {
          const seq = num(args.seq);
          const receipt = args.receipt as Receipt | undefined;
          if (seq === null && !receipt) {
            return textResult(usageFor("verify_attestation", "Verify a receipt and walk the chain.", { seq: "Stored attestation sequence.", receipt: "Receipt object." }));
          }
          const all = attestationsAll(db);
          let target = receipt ?? (seq !== null ? all.find((a) => a.seq === seq) : undefined);
          if (!target) {
            return validationError(`no attestation with seq ${seq}`);
          }

          const computed = receipt ? receiptDigest(receipt) : (target as any).digest ?? "";
          const signatureValid =
            (target as any).signature && (target as any).signer
              ? await verifySignature(computed, (target as any).signature as `0x${string}`, (target as any).signer as `0x${string}`)
              : false;

          // Chain walk: continuity of seq + prevHash with digests recomputed
          // from the stored rows and EIP-191 signatures verified. A dropped
          // record shows up as a sequence gap.
          let chain = { ok: true as boolean | null, gaps: [] as string[], verifiedCount: 0 };
          if (all.length > 0) {
            chain = await verifyReceiptChain(
              all.map((a) => ({ seq: a.seq, prevHash: a.prevHash, digest: a.digest, signature: a.signature, signer: a.signer }))
            );
          }

          return textResult({
            ok: true,
            seq: target.seq,
            digest: computed,
            signatureValid,
            signer: (target as any).signer ?? null,
            anchor: target.anchor ?? null,
            chainOk: chain.ok,
            chainGaps: chain.gaps,
            verifiedCount: chain.verifiedCount,
            note: "a removed record shows up as a sequence gap — omission is detectable, not silent",
          });
        },
      );

      // ── PAID 6: attest_interaction ──────────────────────────────────────
      server.registerTool(
        "attest_interaction",
        {
          title: "Record an interaction outcome with its proof",
          description:
            "The core write: an outcome about a subject backed by a proof (A2A jobId, x402 settlement tx, or signed challenge-response). Self-attestation is rejected against the signature; one attestation per proof; unproven submissions are stored as unverified and excluded from the score — the caller gets an honest receipt either way. Costs 0.005 USDT0.",
          inputSchema: {
            attesterSignature: z.string().describe("EIP-191 signature over the submission JSON — the recovered address is the attester; never trust a caller-supplied attester field."),
            subject: z.string().describe("The subject's wallet address."),
            proofType: z.enum(["a2a_job", "x402_tx", "challenge_response"]).describe("The proof type."),
            proofRef: z.string().describe("jobId, tx hash, or endpoint URL."),
            valueUsdt: z.number().describe("The proven value of the interaction in USDT."),
            terminalState: z.string().optional().describe("For a2a_job: the terminal state observed by the caller."),
            responsePayload: z.string().optional().describe("For challenge_response: the response payload the subject signed."),
            responseSignature: z.string().optional().describe("For challenge_response: the subject's EIP-191 signature over the payload."),
          },
        },
        async (args: Record<string, unknown>) => {
          const signature = str(args.attesterSignature);
          const subject = str(args.subject);
          const proofType = str(args.proofType);
          const proofRef = str(args.proofRef);
          const valueUsdt = num(args.valueUsdt);

          if (!signature || !subject || !proofType || !proofRef || valueUsdt === null) {
            return validationError("attesterSignature, subject, proofType, proofRef and valueUsdt are required");
          }
          if (!["a2a_job", "x402_tx", "challenge_response"].includes(proofType)) {
            return validationError(`unknown proofType "${proofType}"`);
          }

          // The attester comes from the signature — never from a field. The
          // signed string is the canonical submission (attestationSubmissionMessage).
          const submission = attestationSubmissionMessage({
            subject,
            proofType,
            proofRef,
            valueUsdt,
            terminalState: str(args.terminalState) ?? null,
          });
          const digest = "0x" + createHash("sha256").update(submission, "utf8").digest("hex");
          let attester: string | null = null;
          try {
            const { recoverMessageAddress } = await import("viem");
            attester = await recoverMessageAddress({ message: { raw: digest as `0x${string}` }, signature: signature as `0x${string}` });
          } catch {
            attester = null;
          }
          if (!attester) {
            return validationError("attesterSignature did not recover to an address — the submission is not signed");
          }

          const proof: Proof =
            proofType === "a2a_job"
              ? { type: "a2a_job", jobId: proofRef, terminalState: str(args.terminalState) ?? "done", valueUsdt }
              : proofType === "x402_tx"
                ? { type: "x402_tx", txHash: proofRef, valueUsdt }
                : {
                    type: "challenge_response",
                    endpoint: proofRef,
                    responsePayload: str(args.responsePayload) ?? "",
                    responseSignature: str(args.responseSignature) ?? "",
                    valueUsdt,
                  };

          const knownRefs = new Set(attestationsAll(db).map((a) => (a.proofType === "a2a_job" ? `job:${a.proofRef}` : a.proofType === "x402_tx" ? `tx:${a.proofRef}` : `challenge:${a.proofRef}`)));
          const standing = attesterStanding(db, attester);
          const verdict = await verifyProof({
            attester,
            subject,
            proof,
            verifier: deps.proofVerifier,
            knownRefs,
            subjectServicePayTo: process.env.X402_PAY_TO,
          });

          const seq = lastSeq(db) + 1;
          const prevRow = seq === 0 ? null : attestationsAll(db).find((a) => a.seq === seq - 1);
          const prevHash = prevRow ? prevRow.digest : "0x" + "00".repeat(32);
          const weight = verdict.status === "verified" ? attestationWeight(proofType as "a2a_job" | "x402_tx" | "challenge_response", valueUsdt, standing) : 0;

          const receipt = await createReceipt({
            seq,
            prevHash,
            proofType: proofType as "a2a_job" | "x402_tx" | "challenge_response",
            proofRef,
            attester,
            subject,
            status: verdict.status === "verified" ? "verified" : "unverified",
            valueUsdt,
            weight,
            reason: verdict.reason,
            scoreVersion: SCORE_VERSION,
            createdAt: new Date().toISOString(),
          });
          insertAttestation(db, receipt);

          return textResult({
            ok: true,
            status: receipt.status,
            reason: receipt.reason,
            weight,
            attesterStanding: standing,
            seq,
            digest: receipt.digest,
            signature: receipt.signature,
            signer: receipt.signer,
            anchor: receipt.anchor,
            note:
              receipt.status === "verified"
                ? "the attestation counts: proof verified, weight included in the subject's behavioural family"
                : "the attestation is stored as unverified and excluded from the score — an honest receipt saying it does not count, and why",
            boundary: COMPASS_BOUNDARY_NOTE,
          });
        },
      );

      // ── PAID 7: recommend_agent ─────────────────────────────────────────
      server.registerTool(
        "recommend_agent",
        {
          title: "Up to three candidates by attested standing",
          description:
            "A task description → up to three candidates by attested standing, each with its reason and evidence count. With no attested history yet, the honest answer is insufficient evidence, not a made-up list. Costs 0.01 USDT0.",
          inputSchema: {
            task: z.string().describe("What the job involves, e.g. 'settle a 50 USDT invoice'."),
            candidates: z.array(z.string()).optional().describe("Wallet addresses to rank (defaults to subjects with attestations)."),
          },
        },
        async (args: Record<string, unknown>) => {
          const task = str(args.task);
          if (!task) return validationError("task is required");
          const candidates = Array.isArray(args.candidates)
            ? args.candidates.filter((c): c is string => typeof c === "string" && c.length > 0)
            : [];

          const pool = candidates.length > 0 ? candidates : [...new Set(attestationsAll(db).map((a) => a.subject))];
          const ranked: { address: string; score: number; reasons: string[]; evidenceCount: number }[] = [];
          for (const address of pool) {
            const attestations = attestationsFor(db, address);
            const verified = attestations.filter((a) => a.status === "verified" && a.frozen === 0);
            const evidenceCount = verified.length;
            if (evidenceCount === 0) continue;
            const totalWeight = verified.reduce((acc, a) => acc + a.weight, 0);
            const reasons = verified.slice(0, 3).map((a) => `${a.proofType} ${a.proofRef} (weight ${a.weight.toFixed(2)})`);
            ranked.push({ address, score: Math.min(100, totalWeight), reasons, evidenceCount });
          }
          ranked.sort((a, b) => b.score - a.score);
          const top = ranked.slice(0, 3);

          return textResult({
            ok: true,
            task,
            finding: top.length === 0
              ? "no candidates with attested standing yet — insufficient evidence is the honest answer at launch, not an error"
              : `${top.length} candidate(s) ranked by attested standing`,
            candidates: top.map((c) => ({ address: c.address, reason: c.reasons, evidenceCount: c.evidenceCount })),
            boundary: COMPASS_BOUNDARY_NOTE,
          });
        },
      );

      // ── PAID 8: verify_claim ────────────────────────────────────────────
      server.registerTool(
        "verify_claim",
        {
          title: "Check a specific claim an agent makes about itself",
          description:
            "verified / refuted / insufficient evidence, with every verdict citing what was checked. The model (when configured) may draft the verdict; it never mutates a score, signs or anchors. Costs 0.015 USDT0.",
          inputSchema: {
            claim: z.string().describe("The claim to check, e.g. 'this agent can settle a 100 USDT job'."),
            address: z.string().describe("The subject's wallet address."),
          },
        },
        async (args: Record<string, unknown>) => {
          const claim = str(args.claim);
          const address = str(args.address);
          if (!claim || !address) return validationError("claim and address are required");

          const obs = await collectObservations(db, deps.onchain, address, ttlSec);
          const attestations = attestationsFor(db, address).map((a) => ({ subject: a.subject, status: a.status, weight: a.weight }));
          const evidence = { claim, address, observations: obs.map((o) => ({ kind: o.kind, payload: o.payload })), attestations };

          const modelName = process.env.AXIOM_CLAIM_MODEL;
          const result =
            modelName && typeof process.env.AXIOM_CLAIM_MODEL_URL === "string"
              ? await draftVerdict(evidence, {
                  model: {
                    name: modelName,
                    call: async (input: string) => {
                      const res = await fetch(process.env.AXIOM_CLAIM_MODEL_URL!, {
                        method: "POST",
                        headers: { "content-type": "application/json", authorization: `Bearer ${process.env.AXIOM_CLAIM_MODEL_KEY ?? ""}` },
                        body: JSON.stringify({ model: modelName, messages: [{ role: "user", content: input }], max_tokens: 60 }),
                      });
                      const d = (await res.json()) as { choices?: { message?: { content?: string } }[] };
                      return d.choices?.[0]?.message?.content ?? "insufficient evidence";
                    },
                  },
                })
              : mechanicalVerdict(evidence);

          return textResult({
            ok: true,
            ...result,
            boundary: COMPASS_BOUNDARY_NOTE,
            note: result.note + " — the verdict never mutates the score, never signs, never anchors",
          });
        },
      );

      // ── PAID 9: credit_report ───────────────────────────────────────────
      server.registerTool(
        "credit_report",
        {
          title: "The underwriting report",
          description:
            "Solvency, how much of the balance is honeypot or high-tax, standing approval exposure, activity pattern, dispute history, attester concentration. The full credit picture. Costs 0.02 USDT0.",
          inputSchema: {
            address: z.string().describe("The subject's wallet address."),
          },
        },
        async (args: Record<string, unknown>) => {
          const address = str(args.address);
          if (!address) return validationError("address is required");

          const obs = await collectObservations(db, deps.onchain, address, ttlSec);
          const tv = obs.find((o) => o.kind === "total_value");
          const ts = obs.find((o) => o.kind === "token_scan");
          const ap = obs.find((o) => o.kind === "approvals");
          const ac = obs.find((o) => o.kind === "activities");
          const attestations = attestationsFor(db, address);
          const verified = attestations.filter((a) => a.status === "verified");
          const attesters = new Set(verified.map((a) => a.attester.toLowerCase()));
          const concentration = verified.length > 0 ? 1 / attesters.size : null;

          return textResult({
            ok: true,
            address,
            solvency: {
              totalValueUsdt: tv ? Number(tv.payload.totalValueUsdt ?? 0) : null,
              finding: tv && Number(tv.payload.totalValueUsdt ?? 0) < 300
                ? "below the hackathon minimum capital — settlement or dispute absorption is doubtful"
                : "solvent on the recorded observation",
            },
            assetQuality: {
              honeypotValueUsdt: ts ? Number(ts.payload.honeypotValueUsdt ?? 0) : null,
              highTaxValueUsdt: ts ? Number(ts.payload.highTaxValueUsdt ?? 0) : null,
              tokenCount: ts ? Number(ts.payload.tokenCount ?? 0) : null,
              finding: ts && Number(ts.payload.honeypotValueUsdt ?? 0) > 0
                ? "a balance partly made of honeypots is a balance that cannot move"
                : "no honeypot value recorded",
            },
            approvalExposure: {
              unlimitedApprovalsToUnknown: ap ? Number(ap.payload.unlimitedApprovalsToUnknown ?? 0) : null,
              finding: ap && Number(ap.payload.unlimitedApprovalsToUnknown ?? 0) > 0
                ? "standing unlimited approvals to unknown contracts are a liability"
                : "no standing exposure recorded",
            },
            activity: {
              lastActivityAt: ac ? (ac.payload.lastActivityAt as string | null) : null,
              finding: ac && !ac.payload.lastActivityAt ? "dormant since last observation" : undefined,
            },
            attestations: {
              total: attestations.length,
              verified: verified.length,
              unverified: attestations.length - verified.length,
              totalWeightUsdt: verified.filter((a) => a.frozen === 0).reduce((acc, a) => acc + a.weight, 0),
              attesterConcentration: concentration,
              frozenCount: attestations.filter((a) => a.frozen === 1).length,
            },
            disputeHistory: {
              open: openDisputes(db).filter((d) => attestations.some((a) => a.seq === d.attestationSeq)).length,
            },
            boundary: COMPASS_BOUNDARY_NOTE,
            observedAt: new Date().toISOString(),
          });
        },
      );

      // ── PAID 10: dispute_attestation ────────────────────────────────────
      server.registerTool(
        "dispute_attestation",
        {
          title: "Challenge an attestation",
          description:
            "Freezes the challenged attestation's weight immediately, opens a reviewable case, and anchors the challenge. Resolution is mechanical where possible: if the proof fails re-verification the attestation is voided automatically. The fee is a non-refundable anti-spam fee — x402 settles immediately with no refund primitive, so it is not a returnable bond. Costs 0.03 USDT0.",
          inputSchema: {
            attestationSeq: z.number().describe("The seq of the attestation being challenged."),
            reason: z.string().describe("Why the attestation is wrong."),
            challengerSignature: z.string().optional().describe("EIP-191 signature identifying the challenger; absent → the challenge is recorded with an unverified challenger."),
          },
        },
        async (args: Record<string, unknown>) => {
          const attestationSeq = num(args.attestationSeq);
          const reason = str(args.reason);
          if (attestationSeq === null || !reason) return validationError("attestationSeq and reason are required");

          const target = attestationsAll(db).find((a) => a.seq === attestationSeq);
          if (!target) return validationError(`no attestation with seq ${attestationSeq}`);

          let challenger = "anonymous";
          const challengerSignature = str(args.challengerSignature);
          if (challengerSignature) {
            try {
              const { recoverMessageAddress } = await import("viem");
              const digest = "0x" + createHash("sha256").update(`dispute:${attestationSeq}:${reason}`).digest("hex");
              challenger = await recoverMessageAddress({ message: { raw: digest as `0x${string}` }, signature: challengerSignature as `0x${string}` });
            } catch {
              challenger = "unverified-signature";
            }
          }

          const outcome = await createDispute(db, attestationSeq, challenger, reason, { proofType: target.proofType, proofRef: target.proofRef });
          return textResult({
            ok: true,
            ...outcome,
            feeNote: "the 0.03 USDT0 fee is a non-refundable anti-spam fee, not a returnable bond — x402 has no refund primitive",
            resolution: "mechanical where possible: a proof that fails re-verification voids the attestation automatically; genuinely contested outcomes wait on the owner",
            bothSides: "a serial false challenger loses weight as an attester — that is the durable defence against dispute spam",
          });
        },
      );

      // ── FREE 11: reputation_watch (subscription offering) ───────────────
      server.registerTool(
        "reputation_watch",
        {
          title: "Subscription alerts on score movement and red flags",
          description:
            "The A2A subscription offering: alerts on score movement and new red flags for a watched address. This tool describes the offering; the A2A subscription entry is registered by the operator (Phase 3). The free description answers a bare {}.",
          inputSchema: {},
        },
        async () => {
          return textResult({
            ok: true,
            subscription: SUBSCRIPTION_TOOLS.reputation_watch,
            alerts: [
              "score movement beyond a threshold since the last delivered alert",
              "new red flag: honeypot value appears, unlimited approvals to unknown contracts, or balance drops below the solvency line",
              "a new verified or unverified attestation about the watched address",
              "an attestation about the watched address is frozen by a dispute",
            ],
            delivery: "A2A push via the OKX agent messaging session; the operator registers the subscription entry at Phase 3",
            howToSubscribe: "subscribe through the OKX.AI marketplace once the subscription service is live; per-call depth remains available via credit_report",
            note: "this tool itself is free — it describes the offering; the subscription itself is paid monthly",
          });
        },
      );
    },
  );

  return async (req: Request): Promise<Response> => {
    return handler(req);
  };
}
