// dispute_attestation — a queue that must actually drain (PLAN §10).
// A dispute immediately freezes the challenged attestation's weight; the dispute
// itself is signed and anchored; resolution is mechanical wherever possible
// (proof fails re-verification → attestation voided); the fee is a non-refundable
// anti-spam fee, stated in the tool description, never a bond.

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { requireSigner, signDigest } from "./chain.js";
import { disputeById, insertDispute, openDisputes, setDisputeState, setFrozen, setStatus, StoredDispute } from "./store.js";
import { ProofVerifier } from "./proof.js";

export function disputeId(attestationSeq: number, challenger: string, createdAt: string): string {
  return "d-" + createHash("sha256").update(`${attestationSeq}:${challenger}:${createdAt}`).digest("hex").slice(0, 16);
}

export async function createDispute(
  db: Database.Database,
  attestationSeq: number,
  challenger: string,
  reason: string,
  attestation: { proofType: string; proofRef: string }
): Promise<{ dispute: StoredDispute; effect: string; receiptDigest: string; signature: string; signer: string }> {
  const createdAt = new Date().toISOString();
  const id = disputeId(attestationSeq, challenger, createdAt);
  const body = JSON.stringify({ id, attestationSeq, challenger, reason, createdAt, proofRef: attestation.proofRef });
  const receiptDigest = "0x" + createHash("sha256").update(body, "utf8").digest("hex");
  const { signature, signer } = await signDigest(receiptDigest, requireSigner().privateKey);

  // Immediate, automatic effect: freeze the challenged attestation's weight.
  setFrozen(db, attestationSeq, true);

  const dispute: StoredDispute = {
    id,
    attestationSeq,
    challenger,
    reason,
    state: "open",
    createdAt,
    receiptDigest,
    signature,
    signer,
  };
  insertDispute(db, dispute);

  return {
    dispute,
    effect: `attestation seq ${attestationSeq} frozen — its weight no longer counts in any score until the dispute resolves`,
    receiptDigest,
    signature,
    signer,
  };
}

/**
 * Mechanical resolution: if the challenged proof fails re-verification, the
 * attestation is voided automatically. Only genuinely contested outcomes wait
 * on the owner (§10). Returns the outcome.
 */
export async function resolveDisputeMechanically(
  db: Database.Database,
  disputeIdValue: string,
  verifier: ProofVerifier
): Promise<{ state: string; detail: string }> {
  const dispute = disputeById(db, disputeIdValue);
  if (!dispute || dispute.state !== "open") {
    return { state: dispute?.state ?? "unknown", detail: "no open dispute with that id" };
  }
  const att = db.prepare(`SELECT * FROM attestations WHERE seq = ?`).get(dispute.attestationSeq) as
    | { proof_type: string; proof_ref: string }
    | undefined;
  if (!att) {
    setDisputeState(db, disputeIdValue, "voided");
    setFrozen(db, dispute.attestationSeq, false);
    return { state: "voided", detail: "the challenged attestation no longer exists — dispute voided" };
  }

  let proofOk = false;
  try {
    if (att.proof_type === "a2a_job") {
      proofOk = (await verifier.verifyJob(att.proof_ref)).ok;
    } else if (att.proof_type === "x402_tx") {
      proofOk = (await verifier.verifySettlementTx(att.proof_ref)).ok;
    } else {
      // challenge_response cannot be mechanically re-verified without the stored
      // response payload — treat as genuinely contested, waiting on the owner.
      proofOk = true;
    }
  } catch {
    proofOk = false;
  }

  if (!proofOk) {
    // Mechanical voiding: the proof no longer verifies.
    setDisputeState(db, disputeIdValue, "voided");
    setStatus(db, dispute.attestationSeq, "unverified");
    setFrozen(db, dispute.attestationSeq, false);
    return { state: "voided", detail: `proof ${att.proof_type} ${att.proof_ref} failed re-verification — attestation voided automatically` };
  }

  // Proof still verifies: genuinely contested — waits on the owner (§19.2).
  return { state: "open", detail: "proof still verifies — the outcome is genuinely contested and waits on the owner" };
}

export function listOpenDisputes(db: Database.Database) {
  return openDisputes(db);
}
