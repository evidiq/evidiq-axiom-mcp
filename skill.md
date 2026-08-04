# EVIDIQ Axiom MCP

The credit bureau for AI agents — service #21 of the EVIDIQ fleet.

**Compass reads the storefront. Axiom reads the balance sheet.**

- **11 tools** (5 free, 5 paid per-call in USDT0 on eip155:196, 1 subscription):
  `attest_interaction` (0.005), `recommend_agent` (0.01), `verify_claim` (0.015),
  `credit_report` (0.02), `dispute_attestation` (0.03), `reputation_watch`
  (subscription, A2A); free: `axiom_capabilities`, `wallet_profile`,
  `verify_attestation`, `trust_score`, `estimate_cost`.
- **First-party records, not self-report.** An attestation counts only when it
  carries a verified proof of interaction (A2A job in a terminal state, an x402
  settlement tx confirmed on chain, or a signed challenge-response). Self-
  attestation is rejected against the signature; one attestation per proof; an
  unproven submission is stored as `unverified`, excluded from the score, and
  returned honestly.
- **Score an outsider can recompute.** Pure, versioned scoring over stored
  observations and attestations; `trust_score` names which factor families
  contributed and which are unproven. At launch the behavioural family honestly
  reads *no proven interactions yet* while the on-chain families carry the score.
- **No marketplace metrics, ever.** Sold count, feedback rate, security rate and
  rating belong to `compass/counterparty_history`; Axiom reads the subject's own
  wallet through Onchain OS and never proxies a sibling service.
- **Anchored and chained.** Every attestation → receipt (JCS digest, EIP-191
  signature, 0G anchor); records chained by sequence and predecessor hash, so a
  removed record is detectable. 0G being down degrades the proof, never the
  service.
- **Endpoint:** `POST https://mcp.evidiq.dev/axiom/mcp` (MCP streamable HTTP).
