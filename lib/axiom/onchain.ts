// Onchain OS reads behind an interface — Axiom reads the subject's WALLET, never
// the marketplace (PLAN §3: Compass reads the storefront, Axiom reads the
// balance sheet). All commands are read-only: portfolio, security, tracker,
// market. Never a wallet operation, never an order.

import { execFile } from "node:child_process";
import type { ObservationKind, OnchainObservation } from "./score.js";

export interface OnchainSource {
  observe(address: string, kind: ObservationKind): Promise<OnchainObservation>;
}

export class OnchainosSource implements OnchainSource {
  private bin: string;

  constructor(bin = process.env.ONCHAINOS_BIN || "/root/.local/bin/onchainos") {
    this.bin = bin;
  }

  private async run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.bin, args, { timeout: 30_000 }, (err, stdout) => {
        if (err) {
          reject(new Error(`onchainos ${args[0]} failed: ${err.message}`));
          return;
        }
        resolve(stdout);
      });
    });
  }

  private parse(json: string): Record<string, unknown> {
    try {
      return JSON.parse(json) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  async observe(address: string, kind: ObservationKind): Promise<OnchainObservation> {
    const observedAt = new Date().toISOString();
    const a = address.toLowerCase();

    switch (kind) {
      case "total_value": {
        const raw = await this.run(["portfolio", "total-value", "--address", a]);
        const d = this.parse(raw);
        const data = (d.data ?? d) as Record<string, unknown>;
        const totalValueUsdt = Number(data.totalValueUsdt ?? data.totalValue ?? data.value ?? 0);
        return { address: a, kind, payload: { totalValueUsdt }, observedAt, ref: String(data.snapshotAt ?? data.block ?? "") || undefined };
      }
      case "token_scan": {
        const raw = await this.run(["security", "token-scan", "--address", a]);
        const d = this.parse(raw);
        const data = (d.data ?? d) as Record<string, unknown>;
        return {
          address: a,
          kind,
          payload: {
            totalValueUsdt: Number(data.totalValueUsdt ?? data.totalValue ?? 0),
            honeypotValueUsdt: Number(data.honeypotValueUsdt ?? data.honeypotUsdt ?? 0),
            highTaxValueUsdt: Number(data.highTaxValueUsdt ?? data.highTaxUsdt ?? 0),
            tokenCount: Number(data.tokenCount ?? data.tokens ?? 0),
          },
          observedAt,
          ref: String(data.snapshotAt ?? "") || undefined,
        };
      }
      case "approvals": {
        const raw = await this.run(["security", "approvals", "--address", a]);
        const d = this.parse(raw);
        const data = (d.data ?? d) as Record<string, unknown>;
        const list = (data.approvals ?? data.list ?? []) as unknown[];
        const unlimitedUnknown = list.filter((x) => {
          const o = x as Record<string, unknown>;
          return Number(o.amount ?? 0) >= 1e30 && !String(o.spender ?? "").toLowerCase().includes("router");
        }).length;
        return { address: a, kind, payload: { checked: true, unlimitedApprovalsToUnknown: unlimitedUnknown }, observedAt, ref: String(data.snapshotAt ?? "") || undefined };
      }
      case "activities": {
        const raw = await this.run(["tracker", "activities", "--address", a, "--page", "1", "--page-size", "5"]);
        const d = this.parse(raw);
        const data = (d.data ?? d) as Record<string, unknown>;
        const list = (data.list ?? data.activities ?? []) as unknown[];
        const last = list[0] as Record<string, unknown> | undefined;
        return {
          address: a,
          kind,
          payload: {
            activityCount: list.length,
            lastActivityAt: String(last?.time ?? last?.timestamp ?? last?.createdAt ?? "") || null,
          },
          observedAt,
          ref: String(data.snapshotAt ?? "") || undefined,
        };
      }
      case "pnl": {
        const raw = await this.run(["market", "wallet", "--address", a, "--pnl"]);
        const d = this.parse(raw);
        const data = (d.data ?? d) as Record<string, unknown>;
        return {
          address: a,
          kind,
          payload: {
            isTradingAgent: true,
            pnlUsdt: Number(data.pnlUsdt ?? data.pnl ?? 0),
            baseUsdt: Number(data.baseUsdt ?? data.base ?? 0),
          },
          observedAt,
          ref: String(data.snapshotAt ?? "") || undefined,
        };
      }
    }
  }
}

export class StubOnchainSource implements OnchainSource {
  constructor(private map: Partial<Record<ObservationKind, OnchainObservation>>) {}

  async observe(address: string, kind: ObservationKind): Promise<OnchainObservation> {
    const stub = this.map[kind];
    if (stub) return { ...stub, address: address.toLowerCase() };
    throw new Error(`no stub for ${kind}`);
  }
}

// ── proof verification against the real world (read-only) ────────────────────

import { recoverMessageAddress } from "viem";
import type { ProofVerifier } from "./proof.js";

export class OnchainosProofVerifier implements ProofVerifier {
  private bin: string;
  private rpc: string;

  constructor(bin = process.env.ONCHAINOS_BIN || "/root/.local/bin/onchainos", rpc = process.env.X402_RPC || "https://rpc.xlayer.tech") {
    this.bin = bin;
    this.rpc = rpc;
  }

  private async run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const { execFile } = require("node:child_process") as typeof import("node:child_process");
      execFile(this.bin, args, { timeout: 30_000 }, (err, stdout) => {
        if (err) reject(new Error(`onchainos ${args[0]} failed: ${err.message}`));
        else resolve(stdout);
      });
    });
  }

  async verifyJob(jobId: string): Promise<{ ok: boolean; terminalState?: string; reason?: string }> {
    try {
      const raw = await this.run(["agent", "job-detail", "--job-id", jobId]);
      const d = JSON.parse(raw) as { data?: { state?: string; status?: string } };
      const state = d.data?.state ?? d.data?.status ?? "";
      if (!state) return { ok: false, reason: "job not found or no state returned" };
      return { ok: true, terminalState: state };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  }

  async verifySettlementTx(txHash: string): Promise<{ ok: boolean; from?: string; to?: string; reason?: string }> {
    try {
      const res = await fetch(this.rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txHash] }),
        signal: AbortSignal.timeout(20_000),
      });
      const d = (await res.json()) as { result?: { from?: string; to?: string; status?: string } | null };
      if (!d.result) return { ok: false, reason: "transaction not found on chain" };
      if (d.result.status !== "0x1") return { ok: false, reason: "transaction did not succeed" };
      return { ok: true, from: d.result.from, to: d.result.to ?? undefined };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  }

  async verifyChallenge(challenge: { endpoint: string; payload: string; signature: string; subject: string }): Promise<{ ok: boolean; reason?: string }> {
    // Pure crypto: the response signature must recover to the subject's address.
    // No fetch — the endpoint URL is evidence of intent, never something to call.
    try {
      const digest = "0x" + require("node:crypto").createHash("sha256").update(challenge.payload, "utf8").digest("hex");
      const recovered = await recoverMessageAddress({
        message: { raw: digest as `0x${string}` },
        signature: challenge.signature as `0x${string}`,
      });
      if (recovered.toLowerCase() !== challenge.subject.toLowerCase()) {
        return { ok: false, reason: "response signature does not recover to the subject's address" };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  }
}
