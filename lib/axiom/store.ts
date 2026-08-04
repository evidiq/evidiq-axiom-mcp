import Database from "better-sqlite3";
import type { Receipt, ReceiptBody } from "./attest.js";
import type { OnchainObservation } from "./score.js";

export interface StoredAttestation extends Omit<Receipt, "proofType" | "status"> {
  proofType: Receipt["proofType"];
  proofRef: string;
  status: "verified" | "unverified";
  weight: number;
  frozen: number;
}

export interface StoredDispute {
  id: string;
  attestationSeq: number;
  challenger: string;
  reason: string;
  state: "open" | "voided" | "dismissed";
  createdAt: string;
  receiptDigest: string;
  signature: string;
  signer: string;
}

export function openStore(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS attestations (
      seq INTEGER PRIMARY KEY,
      prev_hash TEXT NOT NULL,
      proof_type TEXT NOT NULL,
      proof_ref TEXT NOT NULL,
      attester TEXT NOT NULL,
      subject TEXT NOT NULL,
      status TEXT NOT NULL,
      value_usdt REAL NOT NULL,
      weight REAL NOT NULL,
      reason TEXT NOT NULL,
      score_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      anchor_status TEXT,
      anchor_root TEXT,
      anchor_tx TEXT,
      anchor_note TEXT,
      digest TEXT NOT NULL,
      signature TEXT NOT NULL,
      signer TEXT NOT NULL,
      frozen INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_proof_ref ON attestations (proof_type, proof_ref);
    CREATE INDEX IF NOT EXISTS idx_subject ON attestations (subject);
    CREATE TABLE IF NOT EXISTS observations (
      address TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      ref TEXT,
      PRIMARY KEY (address, kind, observed_at)
    );
    CREATE INDEX IF NOT EXISTS idx_obs_addr_kind ON observations (address, kind, observed_at DESC);
    CREATE TABLE IF NOT EXISTS disputes (
      id TEXT PRIMARY KEY,
      attestation_seq INTEGER NOT NULL,
      challenger TEXT NOT NULL,
      reason TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      receipt_digest TEXT NOT NULL,
      signature TEXT NOT NULL,
      signer TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS free_calls (
      day TEXT NOT NULL,
      ip TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, ip)
    );
    CREATE TABLE IF NOT EXISTS subscriptions (
      subscriber TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (subscriber)
    );
  `);
  return db;
}

// ── attestations ─────────────────────────────────────────────────────────────

export function lastSeq(db: Database.Database): number {
  const row = db.prepare(`SELECT MAX(seq) AS m FROM attestations`).get() as { m: number | null };
  return row.m ?? -1;
}

export function proofRefUsed(db: Database.Database, proofType: string, proofRef: string): boolean {
  const row = db.prepare(`SELECT 1 FROM attestations WHERE proof_type = ? AND proof_ref = ?`).get(proofType, proofRef);
  return !!row;
}

export function insertAttestation(db: Database.Database, r: Receipt): void {
  db.prepare(
    `INSERT OR REPLACE INTO attestations
     (seq, prev_hash, proof_type, proof_ref, attester, subject, status, value_usdt, weight,
      reason, score_version, created_at, anchor_status, anchor_root, anchor_tx, anchor_note,
      digest, signature, signer, frozen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).run(
    r.seq,
    r.prevHash,
    r.proofType,
    r.proofRef,
    r.attester,
    r.subject,
    r.status,
    r.valueUsdt,
    r.weight,
    r.reason,
    r.scoreVersion,
    r.createdAt,
    r.anchor?.status ?? null,
    r.anchor?.root ?? null,
    r.anchor?.tx ?? null,
    r.anchor?.note ?? null,
    r.digest,
    r.signature,
    r.signer
  );
}

export function attestationsAll(db: Database.Database): StoredAttestation[] {
  const rows = db.prepare(`SELECT * FROM attestations ORDER BY seq ASC`).all() as Record<string, unknown>[];
  return rows.map((r) => ({
    seq: r.seq as number,
    prevHash: r.prev_hash as string,
    proofType: r.proof_type as Receipt["proofType"],
    proofRef: r.proof_ref as string,
    attester: r.attester as string,
    subject: r.subject as string,
    status: r.status as "verified" | "unverified",
    valueUsdt: r.value_usdt as number,
    weight: r.weight as number,
    reason: r.reason as string,
    scoreVersion: r.score_version as string,
    createdAt: r.created_at as string,
    anchor:
      r.anchor_status === null
        ? null
        : { status: r.anchor_status as string, root: (r.anchor_root as string) ?? undefined, tx: (r.anchor_tx as string) ?? undefined, note: (r.anchor_note as string) ?? undefined },
    digest: r.digest as string,
    signature: r.signature as string,
    signer: r.signer as string,
    frozen: r.frozen as number,
  }));
}

export function attestationsFor(db: Database.Database, subject: string): StoredAttestation[] {
  return attestationsAll(db).filter((a) => a.subject.toLowerCase() === subject.toLowerCase());
}

export function setFrozen(db: Database.Database, seq: number, frozen: boolean): void {
  db.prepare(`UPDATE attestations SET frozen = ? WHERE seq = ?`).run(frozen ? 1 : 0, seq);
}

export function setStatus(db: Database.Database, seq: number, status: "verified" | "unverified"): void {
  db.prepare(`UPDATE attestations SET status = ? WHERE seq = ?`).run(status, seq);
}

// ── observations ─────────────────────────────────────────────────────────────

export function storeObservation(db: Database.Database, o: OnchainObservation): void {
  db.prepare(
    `INSERT OR REPLACE INTO observations (address, kind, payload, observed_at, ref)
     VALUES (?, ?, ?, ?, ?)`
  ).run(o.address.toLowerCase(), o.kind, JSON.stringify(o.payload), o.observedAt, o.ref ?? null);
}

export function latestObservation(db: Database.Database, address: string, kind: string): OnchainObservation | null {
  const row = db.prepare(
    `SELECT * FROM observations WHERE address = ? AND kind = ? ORDER BY observed_at DESC LIMIT 1`
  ).get(address.toLowerCase(), kind) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    address: row.address as string,
    kind: row.kind as OnchainObservation["kind"],
    payload: JSON.parse(row.payload as string) as Record<string, unknown>,
    observedAt: row.observed_at as string,
    ref: (row.ref as string) ?? undefined,
  };
}

// ── disputes ─────────────────────────────────────────────────────────────────

export function insertDispute(db: Database.Database, d: StoredDispute): void {
  db.prepare(
    `INSERT OR REPLACE INTO disputes
     (id, attestation_seq, challenger, reason, state, created_at, receipt_digest, signature, signer)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(d.id, d.attestationSeq, d.challenger, d.reason, d.state, d.createdAt, d.receiptDigest, d.signature, d.signer);
}

export function disputeById(db: Database.Database, id: string): StoredDispute | null {
  const row = db.prepare(`SELECT * FROM disputes WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as string,
    attestationSeq: row.attestation_seq as number,
    challenger: row.challenger as string,
    reason: row.reason as string,
    state: row.state as StoredDispute["state"],
    createdAt: row.created_at as string,
    receiptDigest: row.receipt_digest as string,
    signature: row.signature as string,
    signer: row.signer as string,
  };
}

export function openDisputes(db: Database.Database): StoredDispute[] {
  const rows = db.prepare(`SELECT * FROM disputes WHERE state = 'open' ORDER BY created_at ASC`).all() as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string,
    attestationSeq: r.attestation_seq as number,
    challenger: r.challenger as string,
    reason: r.reason as string,
    state: r.state as StoredDispute["state"],
    createdAt: r.created_at as string,
    receiptDigest: r.receipt_digest as string,
    signature: r.signature as string,
    signer: r.signer as string,
  }));
}

export function setDisputeState(db: Database.Database, id: string, state: StoredDispute["state"]): void {
  db.prepare(`UPDATE disputes SET state = ? WHERE id = ?`).run(state, id);
}

// ── free-call soft rate limit (§7: degrade, never reject) ────────────────────

export const FREE_SOFT_LIMIT = 100;

export function freeCallCount(db: Database.Database, day: string, ip: string): number {
  const row = db.prepare(`SELECT count FROM free_calls WHERE day = ? AND ip = ?`).get(day, ip) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function recordFreeCall(db: Database.Database, day: string, ip: string): void {
  db.prepare(
    `INSERT INTO free_calls (day, ip, count) VALUES (?, ?, 1)
     ON CONFLICT(day, ip) DO UPDATE SET count = count + 1`
  ).run(day, ip);
}
