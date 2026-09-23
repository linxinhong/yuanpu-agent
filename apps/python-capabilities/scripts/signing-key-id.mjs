export function resolveArtifactSigningKeyId(configuredKeyId, hasProductionTrustRoot) {
  const keyId = configuredKeyId?.trim();
  if (keyId) return keyId;
  if (hasProductionTrustRoot) {
    throw new Error('YUANPU_ARTIFACT_SIGNING_KEY_ID is required with a production trust root.');
  }
  return 'yuanpu-development-ephemeral';
}
