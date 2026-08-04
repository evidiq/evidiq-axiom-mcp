// Proof verification and the four Sybil rules from PLAN §4. Pure functions over
// fixtures; the live verifier (onchainos / RPC reads) implements the same rules
// behind an interface. Self-attestation is checked against the SIGNATURE, never
// against a caller-supplied field.

export type Proof =
  | { type: "a2a_job"; jobId: string; terminalState: string; valueUsdt: number }
  | { type: "x402_tx"; txHash: string; valueUsdt: number }
  | { type: "challenge_response"; endpoint: string; responsePayload: string; responseSignature: string; valueUsdt: number };

export interface ProofVerifier {
  verifyJob(jobId: string): Promise<{ ok: boolean; terminalState?: string; reason?: string }>;
  verifySettlementTx(txHash: string): Promise<{ ok: boolean; from?: string; to?: string; reason?: string }>;
  /** Challenge-response is verified as CRYPTO, never by fetching the endpoint:
   *  the response signature must recover to the subject's address (§4 proof 3,
   *  and fetching arbitrary URLs would make Axiom an SSRF proxy). */
  verifyChallenge(challenge: { endpoint: string; payload: string; signature: string; subject: string }): Promise<{ ok: boolean; reason?: string }>;
}

export interface ProofContext {
  attester: string; // derived from the signature on the submission — never from a field
  subject: string;
  proof: Proof;
  verifier: ProofVerifier;
  knownRefs: Set<string>; // proofRefs already stored (dedupe)
  subjectServicePayTo?: string; // for x402_tx: the subject's listed payTo
}

export type ProofVerdict =
  | { status: "verified"; weight: number; reason: string }
  | { status: "unverified"; reason: string };

/** One attestation per proof: the dedupe key is the jobId or the tx hash. */
export function dedupeKey(proof: Proof): string {
  switch (proof.type) {
    case "a2a_job":
      return `job:${proof.jobId}`;
    case "x402_tx":
      return `tx:${proof.txHash}`;
    case "challenge_response":
      return `challenge:${proof.endpoint}`;
  }
}

export async function verifyProof(ctx: ProofContext): Promise<ProofVerdict> {
  // Sybil rule 1 — self-attestation is rejected, checked against the signature.
  if (ctx.attester.toLowerCase() === ctx.subject.toLowerCase()) {
    return { status: "unverified", reason: "self-attestation rejected: attester and subject are the same address" };
  }

  // Sybil rule 2 — one attestation per proof.
  const key = dedupeKey(ctx.proof);
  if (ctx.knownRefs.has(key)) {
    return { status: "unverified", reason: `proof already used: ${key} — one attestation per proof` };
  }

  switch (ctx.proof.type) {
    case "a2a_job": {
      const job = await ctx.verifier.verifyJob(ctx.proof.jobId);
      if (!job.ok) {
        return { status: "unverified", reason: `job ${ctx.proof.jobId} not verified: ${job.reason ?? "unknown"}` };
      }
      const terminal = (job.terminalState ?? ctx.proof.terminalState).toLowerCase();
      if (!["done", "completed", "finished", "settled", "cancelled", "cancelled_by_buyer"].includes(terminal)) {
        return { status: "unverified", reason: `job ${ctx.proof.jobId} has not reached a terminal state (${terminal})` };
      }
      return { status: "verified", weight: ctx.proof.valueUsdt, reason: `a2a job ${ctx.proof.jobId} reached terminal state ${terminal}` };
    }
    case "x402_tx": {
      const tx = await ctx.verifier.verifySettlementTx(ctx.proof.txHash);
      if (!tx.ok) {
        return { status: "unverified", reason: `settlement tx ${ctx.proof.txHash} not confirmed: ${tx.reason ?? "unknown"}` };
      }
      if (tx.from && tx.from.toLowerCase() !== ctx.attester.toLowerCase()) {
        return { status: "unverified", reason: `settlement tx ${ctx.proof.txHash} from ${tx.from} does not match the attester` };
      }
      if (tx.to && ctx.subjectServicePayTo && tx.to.toLowerCase() !== ctx.subjectServicePayTo.toLowerCase()) {
        return { status: "unverified", reason: `settlement tx ${ctx.proof.txHash} paid ${tx.to}, not the subject's payTo` };
      }
      return { status: "verified", weight: ctx.proof.valueUsdt * 0.8, reason: `x402 settlement ${ctx.proof.txHash} confirmed on chain` };
    }
    case "challenge_response": {
      const ch = await ctx.verifier.verifyChallenge({
        endpoint: ctx.proof.endpoint,
        payload: ctx.proof.responsePayload,
        signature: ctx.proof.responseSignature,
        subject: ctx.subject,
      });
      if (!ch.ok) {
        return { status: "unverified", reason: `challenge-response failed for ${ctx.proof.endpoint}: ${ch.reason ?? "unknown"}` };
      }
      return {
        status: "verified",
        weight: ctx.proof.valueUsdt * 0.3,
        reason: `signed challenge-response from ${ctx.proof.endpoint} — availability only, never outcome`,
      };
    }
  }
}
