export function isMerchantIdentityResolutionEnabled(): boolean {
  return process.env.MERCHANT_IDENTITY_RESOLUTION_ENABLED === "true";
}
