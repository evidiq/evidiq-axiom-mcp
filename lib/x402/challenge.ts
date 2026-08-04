import { X402Challenge, X402AcceptRequirement } from "./types.js";
import { getX402Config } from "./config.js";

export const TOOL_PRICES_ATOMIC: Record<string, string> = {
  attest_interaction: "5000",        // 0.005 USDT0 — cheapest paid call on purpose (§6)
  recommend_agent: "10000",          // 0.01 USDT0
  verify_claim: "15000",             // 0.015 USDT0
  credit_report: "20000",            // 0.02 USDT0
  dispute_attestation: "30000",      // 0.03 USDT0 — top of the ladder (§6)
};

export const TOOL_PRICES_HUMAN: Record<string, string> = {
  attest_interaction: "0.005 USDT0",
  recommend_agent: "0.01 USDT0",
  verify_claim: "0.015 USDT0",
  credit_report: "0.02 USDT0",
  dispute_attestation: "0.03 USDT0",
};

export const FREE_TOOL_NAMES: string[] = [
  "axiom_capabilities",
  "wallet_profile",
  "verify_attestation",
  "trust_score",
  "estimate_cost",
];

// reputation_watch is the sixth paid tool but subscription-priced (A2A, §9);
// it has no atomic x402 price and is registered at Phase 3 by the operator.
export const SUBSCRIPTION_TOOLS: Record<string, { monthlyUsdt: string; note: string }> = {
  reputation_watch: {
    monthlyUsdt: "0.5",
    note: "A2A subscription (not per-call x402): alerts on score movement and new red flags. Operator registers it at Phase 3.",
  },
};

export function createChallenge(toolName: string): X402Challenge {
  const cfg = getX402Config();
  const atomicAmount = TOOL_PRICES_ATOMIC[toolName] || "5000";
  const humanAmount = TOOL_PRICES_HUMAN[toolName] || "0.005 USDT0";

  const acceptReq: X402AcceptRequirement = {
    scheme: "exact",
    network: cfg.chain,
    asset: cfg.asset,
    amount: atomicAmount,
    payTo: cfg.payTo,
    maxTimeoutSeconds: 300,
    extra: {
      name: cfg.domainName,
      version: cfg.domainVersion,
    },
  };

  return {
    x402Version: 2,
    resource: {
      url: `${cfg.publicBaseUrl}/mcp`,
      description: "EVIDIQ Axiom — the credit bureau for AI agents: first-party records of interactions that actually happened between agents, each backed by a verifiable proof, signed, anchored to 0G, and scored by a published function an outsider can recompute. Compass reads the storefront; Axiom reads the balance sheet.",
      mimeType: "application/json",
    },
    accepts: [acceptReq],
    error: `Payment Required for tool '${toolName}'. Costs ${humanAmount}.`,
  };
}

export function encodeChallengeToBase64(challenge: X402Challenge): string {
  const { error, ...headerChallenge } = challenge;
  return Buffer.from(JSON.stringify(headerChallenge)).toString("base64");
}

export function getX402DiscoveryCatalog() {
  const cfg = getX402Config();
  return {
    x402Version: 2,
    resource: {
      url: `${cfg.publicBaseUrl}/mcp`,
      description: "EVIDIQ Axiom — the credit bureau for AI agents. Free tools (axiom_capabilities, wallet_profile, verify_attestation, trust_score, estimate_cost) remain free.",
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: cfg.chain,
        asset: cfg.asset,
        amount: "5000",
        payTo: cfg.payTo,
        maxTimeoutSeconds: 300,
        extra: {
          name: cfg.domainName,
          version: cfg.domainVersion,
        },
      },
    ],
    pricing: [
      { tool: "attest_interaction", amount: "5000", usd: 0.005 },
      { tool: "recommend_agent", amount: "10000", usd: 0.01 },
      { tool: "verify_claim", amount: "15000", usd: 0.015 },
      { tool: "credit_report", amount: "20000", usd: 0.02 },
      { tool: "dispute_attestation", amount: "30000", usd: 0.03 },
      { tool: "axiom_capabilities", amount: "0", usd: 0, free: true },
      { tool: "wallet_profile", amount: "0", usd: 0, free: true },
      { tool: "verify_attestation", amount: "0", usd: 0, free: true },
      { tool: "trust_score", amount: "0", usd: 0, free: true },
      { tool: "estimate_cost", amount: "0", usd: 0, free: true },
      { tool: "reputation_watch", amount: "0", usd: 0, free: false, subscription: true, monthlyUsdt: "0.5" },
    ],
    guidance: "trust_score and verify_attestation are free forever — the claims can always be checked by whoever doubts them. Free tools degrade past the soft rate limit rather than erroring (rateNote).",
  };
}
