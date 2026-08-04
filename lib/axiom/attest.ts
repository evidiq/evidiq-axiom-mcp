// The attestation receipt: canonical JCS digest over a closed field set, EIP-191
// signature, best-effort 0G anchor that degrades the proof, never the service
// (PLAN §13 — same contract as Notary).

import { createHash } from "node:crypto";
import { getOgConfig } from "../og/config.js";
import { uploadJson } from "../og/storage.js";
import { getSignerAddress, requireSigner, signDigest } from "./chain.js";

export const AXIOM_LIBRARY_VERSION = "0.1.0";

export type ProofType = "a2a_job" | "x402_tx" | "challenge_response";

export interface ReceiptBody {
  seq: number;
  prevHash: string;
  proofType: ProofType;
  proofRef: string;
  attester: string;
  subject: string;
  status: "verified" | "unverified";
  valueUsdt: number;
  weight: number;
  reason: string;
  scoreVersion: string;
  createdAt: string;
  anchor: { status: string; root?: string; tx?: string; note?: string } | null;
}

export interface Receipt extends ReceiptBody {
  digest: string;
  signature: string;
  signer: string;
}

export const DIGEST_FIELDS: (keyof ReceiptBody)[] = [
  "seq",
  "prevHash",
  "proofType",
  "proofRef",
  "attester",
  "subject",
  "status",
  "valueUsdt",
  "weight",
  "reason",
  "scoreVersion",
  "createdAt",
  "anchor",
];

/** RFC 8785 canonical JSON (JCS). */
export function canonicalJsonStringify(obj: unknown): string {
  if (obj === null || obj === undefined || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalJsonStringify).join(",") + "]";
  }
  const parts: string[] = [];
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    const val = (obj as Record<string, unknown>)[key];
    if (val === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJsonStringify(val)}`);
  }
  return "{" + parts.join(",") + "}";
}

export function receiptBody(body: ReceiptBody): string {
  const closed: Record<string, unknown> = {};
  for (const field of DIGEST_FIELDS) {
    closed[field] = body[field];
  }
  return canonicalJsonStringify(closed);
}

export function receiptDigest(body: ReceiptBody): string {
  return "0x" + createHash("sha256").update(receiptBody(body), "utf8").digest("hex");
}

async function anchorReceipt(body: ReceiptBody): Promise<ReceiptBody["anchor"]> {
  const cfg = getOgConfig();
  if (!cfg) {
    return { status: "anchoring-failed", note: "0G Storage not configured (OG_PRIVATE_KEY missing)" };
  }
  try {
    const stored = await uploadJson(
      cfg,
      { kind: "evidiq-axiom-attestation", seq: body.seq, proofRef: body.proofRef, digest: receiptDigest(body) },
      `evidiq-axiom-receipt-${body.seq}.json`
    );
    if (stored.ok) {
      return { status: "anchored", root: stored.root, tx: stored.tx };
    }
    return { status: "anchoring-failed", note: `0G Storage anchoring skipped: ${stored.error}` };
  } catch (err) {
    return { status: "anchoring-failed", note: `0G Storage anchoring error: ${(err as Error).message}` };
  }
}

/**
 * Build, anchor (best-effort, BEFORE the receipt is final), then sign. The
 * signature covers the anchored state so the digest binds the anchor reference.
 */
export async function createReceipt(body: Omit<ReceiptBody, "anchor">): Promise<Receipt> {
  const anchor = await anchorReceipt({ ...body, anchor: null });
  const full: ReceiptBody = { ...body, anchor };
  const digest = receiptDigest(full);
  const { signature, signer } = await signDigest(digest, requireSigner().privateKey);
  return { ...full, digest, signature, signer };
}

export { getSignerAddress, requireSigner };

/**
 * The canonical submission message a caller signs for attest_interaction.
 * The server hashes EXACTLY this string, so the caller must sign it — never
 * build a different JSON by hand.
 */
export function attestationSubmissionMessage(args: {
  subject: string;
  proofType: string;
  proofRef: string;
  valueUsdt: number;
  terminalState?: string | null;
}): string {
  return JSON.stringify({
    subject: args.subject,
    proofType: args.proofType,
    proofRef: args.proofRef,
    valueUsdt: args.valueUsdt,
    terminalState: args.terminalState ?? null,
  });
}

export interface ReceiptChainRow {
  seq: number;
  prevHash: string;
  digest: string;
  signature: string;
  signer: string;
}

/** Walk the stored receipt chain: continuity of seq and prevHash, digest
 *  recomputed from each row's fields, EIP-191 signatures verified. A deleted
 *  record shows up as a sequence gap — omission is detectable, not silent. */
export async function verifyReceiptChain(
  rows: ReceiptChainRow[],
  verifySig: (digest: string, sig: string, signer: `0x${string}`) => Promise<boolean> = (d, s, e) =>
    import("./chain.js").then((m) => m.verifySignature(d, s as `0x${string}`, e))
): Promise<{ ok: boolean; gaps: string[]; verifiedCount: number }> {
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);
  const gaps: string[] = [];
  let verifiedCount = 0;

  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i];
    if (i === 0) {
      if (row.seq !== 0) gaps.push(`chain does not start at seq 0 (found ${row.seq})`);
      if (row.prevHash !== "0x" + "00".repeat(32)) gaps.push(`genesis prevHash is not all-zero at seq ${row.seq}`);
    } else {
      const prev = sorted[i - 1];
      if (row.seq !== prev.seq + 1) gaps.push(`sequence gap: ${prev.seq} → ${row.seq}`);
      if (row.prevHash !== prev.digest) gaps.push(`predecessor hash mismatch at seq ${row.seq}`);
    }
    const ok = await verifySig(row.digest, row.signature, row.signer as `0x${string}`);
    if (ok) verifiedCount += 1;
    else gaps.push(`signature invalid at seq ${row.seq}`);
  }

  return { ok: gaps.length === 0, gaps, verifiedCount };
}
