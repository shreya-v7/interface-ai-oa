import { OidcClient } from './oidc.js';

/** Authentication mode is explicit. Invalid OIDC configuration cannot enable key login. */
export async function configuredOperatorAuth(): Promise<{ oidc?: OidcClient }> {
  const mode = process.env.OPERATOR_AUTH ?? 'key';
  if (mode === 'key') return {};
  if (mode !== 'oidc' || !process.env.OIDC_ISSUER || !process.env.OIDC_CLIENT_ID)
    throw new Error('OPERATOR_AUTH_CONFIGURATION_INVALID');
  return {
    oidc: await OidcClient.create({
      issuer: process.env.OIDC_ISSUER,
      clientId: process.env.OIDC_CLIENT_ID,
      allowInsecureLoopback: process.env.OIDC_ALLOW_INSECURE_LOOPBACK === 'true',
    }),
  };
}
