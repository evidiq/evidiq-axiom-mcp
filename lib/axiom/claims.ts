// verify_claim — where an LLM is allowed, and what binds it (PLAN §8).
// The model may read evidence and draft a verdict. It may never mutate a score,
// sign, anchor or influence payment. Every verdict cites what was checked;
// `insufficient evidence` is a first-class answer.

export interface EvidenceItem {
  kind: "onchain_observation" | "attestation" | "endpoint_response" | "marketplace_field";
  ref: string;
  summary: string;
}

export type ClaimVerdict = "verified" | "refuted" | "insufficient evidence";

export interface ClaimResult {
  claim: string;
  verdict: ClaimVerdict;
  citations: EvidenceItem[];
  model: string | null;
  draftedBy: "model" | "mechanical";
  note: string;
}

export interface ClaimEvidence {
  claim: string;
  address: string;
  observations: { kind: string; payload: Record<string, unknown> }[];
  attestations: { subject: string; status: string; weight: number }[];
}

/** Mechanical verdict: no model involved. Only returns verified/refuted when
 *  the evidence actually settles the claim; otherwise insufficient evidence. */
export function mechanicalVerdict(evidence: ClaimEvidence): ClaimResult {
  const citations: EvidenceItem[] = [];
  const claim = evidence.claim.toLowerCase();

  for (const o of evidence.observations) {
    const payload = JSON.stringify(o.payload);
    citations.push({
      kind: "onchain_observation",
      ref: o.kind,
      summary: payload.slice(0, 120),
    });
  }
  for (const a of evidence.attestations) {
    citations.push({
      kind: "attestation",
      ref: String(a.subject),
      summary: `${a.status}, weight ${a.weight}`,
    });
  }

  // Mechanical rules — only settle claims the evidence actually addresses.
  if (evidence.observations.some((o) => o.kind === "total_value" && Number(o.payload.totalValueUsdt) > 0)) {
    if (claim.includes("can pay") || claim.includes("solvent") || claim.includes("has funds")) {
      return { claim: evidence.claim, verdict: "verified", citations, model: null, draftedBy: "mechanical", note: "settled from a stored on-chain total-value observation" };
    }
    if (claim.includes("cannot pay") || claim.includes("insolvent") || claim.includes("no funds")) {
      return { claim: evidence.claim, verdict: "refuted", citations, model: null, draftedBy: "mechanical", note: "the on-chain total-value observation contradicts the claim" };
    }
  }
  if (evidence.attestations.some((a) => a.status === "verified" && a.weight > 0)) {
    if (claim.includes("delivered") || claim.includes("delivers")) {
      return { claim: evidence.claim, verdict: "verified", citations, model: null, draftedBy: "mechanical", note: "settled from verified attestations with weight" };
    }
  }

  return {
    claim: evidence.claim,
    verdict: "insufficient evidence",
    citations,
    model: null,
    draftedBy: "mechanical",
    note: "the evidence available does not settle this claim — insufficient evidence is a first-class answer, not a failure",
  };
}

/** Model-drafted verdict: the model may phrase the verdict and add reasoning,
 *  never touch scores/signatures/payment. When no model is configured, falls
 *  back to the mechanical verdict. */
export async function draftVerdict(
  evidence: ClaimEvidence,
  opts: { model?: { name: string; call(input: string): Promise<string> } } = {}
): Promise<ClaimResult> {
  if (!opts.model) return mechanicalVerdict(evidence);
  const mechanical = mechanicalVerdict(evidence);
  const prompt = [
    "You are an evidence reviewer for a reputation service. Read the evidence and answer with ONE of: verified | refuted | insufficient evidence.",
    "Claim:", evidence.claim,
    "Evidence:", JSON.stringify({ observations: evidence.observations, attestations: evidence.attestations }),
    "Rules: never invent evidence; every sentence you rely on must exist in the evidence; if the evidence does not settle the claim, answer 'insufficient evidence'.",
  ].join("\n");
  const modelAnswer = (await opts.model.call(prompt)).trim();
  const verdict: ClaimVerdict =
    modelAnswer.toLowerCase().startsWith("verified") ? "verified"
    : modelAnswer.toLowerCase().startsWith("refuted") ? "refuted"
    : "insufficient evidence";
  return {
    claim: evidence.claim,
    verdict,
    citations: mechanical.citations,
    model: opts.model.name,
    draftedBy: "model",
    note: `verdict drafted by ${opts.model.name} from the cited evidence; the model never mutates the score, signs or anchors`,
  };
}
