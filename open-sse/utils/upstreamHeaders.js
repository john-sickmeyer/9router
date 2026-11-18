import { LITHOS_RATE_LIMIT_HEADERS } from "../config/lithosai.js";

const FORWARDED = new Set(["retry-after", "x-should-retry"]);
const FORWARDED_PREFIX = "anthropic-ratelimit-";

export function upstreamResponseHeaders(headers, provider) {
  const out = {};
  if (typeof headers?.forEach !== "function") return out;
  const exposed = [];
  headers.forEach((value, name) => {
    const key = name.toLowerCase();
    if (provider === "lithosai" && LITHOS_RATE_LIMIT_HEADERS.has(key)) {
      out[key] = value;
      exposed.push(key);
    } else if (FORWARDED.has(key) || key.startsWith(FORWARDED_PREFIX)) {
      out[key] = value;
    }
  });
  if (exposed.length) {
    out["Access-Control-Allow-Origin"] = "*";
    out["access-control-expose-headers"] = exposed.join(", ");
  }
  return out;
}
