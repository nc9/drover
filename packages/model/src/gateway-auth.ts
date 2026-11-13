import type { Api, Model } from "@earendil-works/pi-ai/compat";

/** The Cloudflare AI Gateway provider id. */
export const CLOUDFLARE_GATEWAY = "cloudflare-ai-gateway";

/**
 * Headers for a `cloudflare-ai-gateway` call. pi-ai 1.x adapters no longer derive the gateway
 * token from `apiKey` (only its `Models` auth layer does), and compat `streamSimple` sends an
 * explicit `apiKey` as `Authorization: Bearer` (openai-*) or `x-api-key` (anthropic), which would
 * hand the gateway token to the upstream as its key. So the token goes in `cf-aig-authorization`
 * (overwriting any such header, as 0.x did), and the default bearers are suppressed with null
 * headers unless an `Authorization` header was given explicitly.
 */
export function gatewayHeaders(
  headers: Readonly<Record<string, string | null>> | undefined,
  apiKey: string,
): Record<string, string | null> {
  const out: Record<string, string | null> = { ...headers };
  const explicit = Object.keys(out).find((k) => k.toLowerCase() === "authorization");
  for (const k of Object.keys(out))
    if (/^(authorization|x-api-key|cf-aig-authorization)$/i.test(k) && k !== explicit)
      delete out[k];
  out["cf-aig-authorization"] = `Bearer ${apiKey}`;
  if (explicit === undefined) out.Authorization = null;
  out["x-api-key"] = null;
  return out;
}

/** `model` with gateway auth headers when it is a gateway model; any other model unchanged. */
export function withGatewayAuth<M extends Model<Api>>(model: M, apiKey: string | undefined): M {
  if (model.provider !== CLOUDFLARE_GATEWAY || !apiKey) return model;
  return {
    ...model,
    // null values (suppressed default headers) are legal at runtime; pi-ai's Model type is narrower.
    headers: gatewayHeaders(
      model.headers as Record<string, string | null> | undefined,
      apiKey,
    ) as Record<string, string>,
  };
}
