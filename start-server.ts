import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAxiomServer } from "./server.js";
import { openStore } from "./lib/axiom/store.js";
import { getSignerAddress } from "./lib/axiom/chain.js";
import { OnchainosSource } from "./lib/axiom/onchain.js";
import { OnchainosProofVerifier } from "./lib/axiom/onchain.js";
import { handleX402Gate } from "./lib/x402/gate.js";
import { getX402DiscoveryCatalog } from "./lib/x402/challenge.js";
import { isX402Bypassed } from "./lib/x402/config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || "3022", 10);
const HOST = process.env.HOSTNAME || "0.0.0.0";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "https://mcp.evidiq.dev/axiom").replace(/\/$/, "");
const SLUG = "axiom";

const bypassed = isX402Bypassed();
if (bypassed) {
  console.warn("[axiom] X402 GATE BYPASSED — Phase 1 test build. Paid tools answer without payment.");
}

const db = openStore(process.env.AXIOM_DB_PATH || "/data/axiom.db");

const handler = createAxiomServer({
  db,
  onchain: new OnchainosSource(process.env.ONCHAINOS_BIN || "/host-bin/onchainos"),
  proofVerifier: new OnchainosProofVerifier(),
  signerAvailable: getSignerAddress() !== null,
  clientIp: () => "local",
});
const gatedHandler = (req: Request) => handleX402Gate(req, handler);

async function nodeFetchAdapter(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  handlerFn: (request: Request) => Promise<Response>
) {
  const protocol = (req.headers["x-forwarded-proto"] as string) || "http";
  const host = req.headers["host"] || `localhost:${PORT}`;
  const fullUrl = `${protocol}://${host}${req.url}`;

  const headers = new Headers();
  for (const [key, val] of Object.entries(req.headers)) {
    if (val === undefined) continue;
    if (Array.isArray(val)) {
      for (const item of val) headers.append(key, item);
    } else {
      headers.set(key, val);
    }
  }

  let body: Buffer | null = null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    body = Buffer.concat(chunks);
  }

  const webReq = new Request(fullUrl, {
    method: req.method,
    headers,
    body: body as unknown as BodyInit | undefined,
    // @ts-ignore
    duplex: body ? "half" : undefined,
  });

  const webRes = await handlerFn(webReq);

  res.statusCode = webRes.status;
  webRes.headers.forEach((val, key) => {
    res.setHeader(key, val);
  });

  if (webRes.body) {
    const reader = webRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) res.write(value);
    }
  }
  res.end();
}

function isMcpPath(urlPath: string): boolean {
  return urlPath === "/mcp" || urlPath === "/mcp/" || urlPath === `/${SLUG}/mcp` || urlPath === `/${SLUG}/mcp/`;
}

const httpServer = http.createServer(async (req, res) => {
  const urlPath = (req.url || "/").split("?")[0];

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, payment-signature, PAYMENT-SIGNATURE, X-PAYMENT, x-payment, Accept"
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    "payment-required, x-payment-required, PAYMENT-RESPONSE, payment-response"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  // ── /health ──────────────────────────────────────────────────────────────
  if (urlPath === "/health" || urlPath === "/" || urlPath === `/${SLUG}/health`) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        ok: true,
        service: "evidiq-axiom-mcp",
        version: "0.1.0",
        paymentGate: bypassed ? "bypassed" : "enforced",
        signerAvailable: getSignerAddress() !== null,
        toolsCount: 11,
        publicBaseUrl: PUBLIC_BASE_URL,
        timestamp: new Date().toISOString(),
      })
    );
    return;
  }

  // ── /x402 ────────────────────────────────────────────────────────────────
  if (urlPath === "/x402" || urlPath === `/${SLUG}/x402`) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(getX402DiscoveryCatalog(), null, 2));
    return;
  }

  // ── /skill.md ────────────────────────────────────────────────────────────
  if (urlPath === "/skill.md" || urlPath === `/${SLUG}/skill.md`) {
    const skillPath = path.join(__dirname, "../skill.md");
    if (fs.existsSync(skillPath)) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.end(fs.readFileSync(skillPath, "utf-8"));
    } else {
      res.statusCode = 404;
      res.end("skill.md not found");
    }
    return;
  }

  // ── /mcp ─────────────────────────────────────────────────────────────────
  if (isMcpPath(urlPath)) {
    if (req.method === "HEAD") {
      const status = bypassed ? 200 : 402;
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        Allow: "POST, OPTIONS, HEAD",
      });
      res.end();
      return;
    }

    try {
      await nodeFetchAdapter(req, res, gatedHandler);
    } catch (err: any) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: err.message || "Internal server error" }));
      }
    }
    return;
  }

  res.statusCode = 404;
  res.end("Not Found");
});

httpServer.listen(PORT, HOST, () => {
  console.log(`[evidiq-axiom-mcp] listening at http://${HOST}:${PORT}`);
  console.log(`[evidiq-axiom-mcp] Payment Gate: ${bypassed ? "BYPASSED (TEST BUILD)" : "ENFORCED"}`);
  console.log(`[evidiq-axiom-mcp] Endpoints: /health, /x402, /skill.md, /mcp`);
});

process.on("unhandledRejection", (reason) => {
  console.error("[evidiq-axiom-mcp] unhandled rejection — staying up:", reason);
});
process.on("uncaughtException", (error) => {
  console.error("[evidiq-axiom-mcp] uncaught exception — staying up:", error);
});
