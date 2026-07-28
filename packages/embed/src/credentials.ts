import type { CredentialProvider, ProviderCreds } from "@osr/core";

/** BYOK credential provider that reads provider secrets from environment variables. */
export class EnvCredentialProvider implements CredentialProvider {
  async credentialsFor(_tenant: string, provider: string): Promise<ProviderCreds> {
    const prefix = `OSR_${provider.toUpperCase()}_`;
    const creds: ProviderCreds = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v && k.startsWith(prefix)) creds[k.slice(prefix.length).toLowerCase()] = v;
    }
    return creds;
  }
}
