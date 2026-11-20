/**
 * The product name the server shows people (authenticator apps, OAuth consent
 * screens, webhook test deliveries). A white-label build sets it at build time
 * (tsup.config.ts, brands/README.md); otherwise Claudia.
 */
export const BRAND_NAME: string = process.env.BRAND_NAME || 'Claudia';
