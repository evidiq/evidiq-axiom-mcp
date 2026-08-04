/**
 * Extract the x402 payment header from a request's headers.
 * Accepts all three carrier names the fleet must interoperate with:
 *   - `payment-signature` (canonical x402 v2 header)
 *   - `X-PAYMENT` (legacy x402 v1 header)
 *   - `Authorization: Payment ...` (bearer-style carrier)
 */
export function parsePaymentHeader(
  headers: Record<string, string | string[] | undefined>
): { headerName: string; value: string } | null {
  for (const [key, value] of Object.entries(headers)) {
    const lk = key.toLowerCase();
    if (lk === "payment-signature" || lk === "x-payment") {
      const v = Array.isArray(value) ? value[0] : value;
      if (typeof v === "string" && v.length > 0) {
        return { headerName: key, value: v };
      }
    }
  }
  const auth = headers["authorization"];
  const authValue = Array.isArray(auth) ? auth[0] : auth;
  if (typeof authValue === "string" && authValue.length > 0) {
    const m = authValue.match(/^Payment\s+(.+)$/i);
    if (m) {
      return { headerName: "authorization", value: m[1].trim() };
    }
  }
  return null;
}

export function extractPaymentHeader(
  headers: Record<string, string | string[] | undefined>
): string | null {
  return parsePaymentHeader(headers)?.value ?? null;
}
