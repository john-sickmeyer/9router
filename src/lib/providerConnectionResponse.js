import { AI_PROVIDERS } from "@/shared/constants/providers";

export function usesAwsCredentialForm(provider) {
  return AI_PROVIDERS[provider]?.credentialForm === "aws";
}

export function toProviderConnectionResponse(connection) {
  const { apiKey, accessToken, refreshToken, idToken, studioOpenaiAdmin, ...safe } = connection;
  // The OpenAI billing admin key never leaves the server; expose only whether one is set.
  if (studioOpenaiAdmin?.key) safe.studioOpenaiAdmin = { configured: true, keyHint: studioOpenaiAdmin.keyHint || null };

  if (!usesAwsCredentialForm(connection.provider) || !connection.providerSpecificData) {
    return safe;
  }

  const { sessionToken, ...providerSpecificData } = connection.providerSpecificData;
  return { ...safe, providerSpecificData };
}
