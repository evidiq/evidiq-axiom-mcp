// The decision chain — every decision becomes a record with a sequence number,
// the hash of its predecessor, a JCS digest over a closed field set, and an
// EIP-191 signature. Omission is detectable: drop a record and the chain has a
// hole anyone can see (§5).

import { createHash } from "node:crypto";
import { recoverMessageAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export interface ChainAnchor {
  status: "anchored" | "anchoring-failed" | "pending";
  root?: string;
  tx?: string;
  note?: string;
}

export interface DecisionRecord {
  seq: number;
  prevHash: string;
  decidedAt: string;
  day: string;
  signalId: string | null;
  instrument: string | null;
  action: "enter" | "exit" | "wait" | "halt" | "genesis";
  direction: "long" | "short" | null;
  intendedPrice: number | null;
  stopLevel: number | null;
  sizeUsdt: number | null;
  ruleMatched: string | null;
  mandateVersion: string;
  libraryVersion: string;
  anchor: ChainAnchor | null;
}

export const DIGEST_FIELDS: (keyof Omit<DecisionRecord, "seq" | "prevHash" | "anchor">)[] = [
  "decidedAt",
  "day",
  "signalId",
  "instrument",
  "action",
  "direction",
  "intendedPrice",
  "stopLevel",
  "sizeUsdt",
  "ruleMatched",
  "mandateVersion",
  "libraryVersion",
];

// ── RFC 8785 canonical JSON (JCS) ────────────────────────────────────────────

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

/** The closed digest payload: record fields + predecessor hash + seq + anchor. */
export function recordBody(record: DecisionRecord): string {
  const closed: Record<string, unknown> = { seq: record.seq, prevHash: record.prevHash };
  for (const field of DIGEST_FIELDS) {
    closed[field] = record[field];
  }
  if (record.anchor) {
    closed.anchor = {
      status: record.anchor.status,
      root: record.anchor.root ?? null,
      tx: record.anchor.tx ?? null,
    };
  }
  return canonicalJsonStringify(closed);
}

export function recordDigest(record: DecisionRecord): string {
  return "0x" + createHash("sha256").update(recordBody(record), "utf-8").digest("hex");
}

// ── signer (no fallback key; unset throws) ───────────────────────────────────

export function getSignerKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.AXIOM_SIGNER_PRIVATE_KEY ?? null;
  if (!raw) return null;
  const hex = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (/^0x[0-9a-fA-F]{64}$/.test(hex)) return hex;
  return null;
}

export function requireSigner(env: NodeJS.ProcessEnv = process.env): { privateKey: `0x${string}`; address: `0x${string}` } {
  const pk = getSignerKey(env);
  if (!pk) {
    throw new Error("AXIOM_SIGNER_PRIVATE_KEY missing or invalid — no fallback signing key exists");
  }
  return { privateKey: pk as `0x${string}`, address: privateKeyToAccount(pk as `0x${string}`).address };
}

export function getSignerAddress(env: NodeJS.ProcessEnv = process.env): string | null {
  const pk = getSignerKey(env);
  if (!pk) return null;
  return privateKeyToAccount(pk as `0x${string}`).address;
}

export async function signDigest(
  digest: string,
  privateKey: `0x${string}`
): Promise<{ signature: `0x${string}`; signer: `0x${string}` }> {
  const account = privateKeyToAccount(privateKey);
  const rawDigest = (digest.startsWith("0x") ? digest : `0x${digest}`) as `0x${string}`;
  const signature = await account.signMessage({ message: { raw: rawDigest } });
  return { signature, signer: account.address };
}

export async function verifySignature(
  digest: string,
  signature: `0x${string}`,
  expectedSigner: `0x${string}`
): Promise<boolean> {
  try {
    const rawDigest = (digest.startsWith("0x") ? digest : `0x${digest}`) as `0x${string}`;
    const recovered = await recoverMessageAddress({ message: { raw: rawDigest }, signature });
    return recovered.toLowerCase() === expectedSigner.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Verify a chain of records: each digest recomputed from its body, each signature
 * EIP-191-verified, each prevHash equal to the previous record's digest. Returns
 * the gaps (missing seq numbers or broken links) instead of throwing.
 */
export async function verifyChain(
  records: DecisionRecord[],
  signatures: Record<number, string>,
  expectedSigner: `0x${string}`,
  verifySig: (digest: string, sig: string, signer: `0x${string}`) => Promise<boolean> = (d, s, e) => verifySignature(d, s as `0x${string}`, e)
): Promise<{ ok: boolean; gaps: string[]; verifiedCount: number }> {
  const sorted = [...records].sort((a, b) => a.seq - b.seq);
  const gaps: string[] = [];
  let verifiedCount = 0;

  for (let i = 0; i < sorted.length; i++) {
    const rec = sorted[i];
    if (i === 0) {
      if (rec.seq !== 0) gaps.push(`chain does not start at seq 0 (found ${rec.seq})`);
    } else {
      const prev = sorted[i - 1];
      if (rec.seq !== prev.seq + 1) {
        gaps.push(`sequence gap: ${prev.seq} → ${rec.seq}`);
      }
      if (rec.prevHash !== recordDigest(prev)) {
        gaps.push(`predecessor hash mismatch at seq ${rec.seq}`);
      }
    }
    const sig = signatures[rec.seq];
    if (!sig) {
      gaps.push(`missing signature at seq ${rec.seq}`);
      continue;
    }
    const ok = await verifySig(recordDigest(rec), sig, expectedSigner);
    if (ok) verifiedCount += 1;
    else gaps.push(`signature invalid at seq ${rec.seq}`);
  }

  return { ok: gaps.length === 0, gaps, verifiedCount };
}
