import { describe, expect, it } from "vitest";
import { buildKimiProfile, extendKimiProfile } from "../../scripts/studio-kimi-config.mjs";
import { LITHOS_KIMI_ROUTE } from "../../open-sse/config/lithosai.js";

describe("Kimi CLI's Studio profile", () => {
  it("offers the routed Lithos model while retrieving credentials only from the Studio gateway", () => {
    const text = buildKimiProfile();
    expect(text).toContain(`default_model = "${LITHOS_KIMI_ROUTE}"`);
    expect(text).toContain(`[models."${LITHOS_KIMI_ROUTE}"]`);
    expect(text).toContain('base_url = "http://127.0.0.1:20128/v1"');
    expect(text).toContain('api_key_env = "ANTHROPIC_AUTH_TOKEN"');
    expect(text).not.toMatch(/api\.lithosai|api\.moonshot|LITHOSAI_API_KEY/);
  });

  it("adds the model once and preserves the user's existing default and other sections", () => {
    const original = 'default_model = "mine"\n[providers.studio-router]\nbase_url = "http://127.0.0.1:20128/v1"\napi_key_env = "ANTHROPIC_AUTH_TOKEN"\n[extra]\nvalue = "keep"\n';
    const changed = extendKimiProfile(original);
    expect(changed.startsWith(original)).toBe(true);
    expect(extendKimiProfile(changed)).toBe(changed);
    expect(() => extendKimiProfile(original.replace("127.0.0.1", "elsewhere.test"))).toThrow();
    expect(() => extendKimiProfile(changed.replace(`model = "${LITHOS_KIMI_ROUTE}"`, 'model = "other"'))).toThrow();
  });
});
