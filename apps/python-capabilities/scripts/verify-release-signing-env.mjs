import { createPrivateKey, createPublicKey } from 'node:crypto';

const privateBase64 = process.env.YUANPU_ARTIFACT_SIGNING_KEY_BASE64;
const publicBase64 = process.env.YUANPU_ARTIFACT_TRUST_ROOT_PUBLIC_KEY_BASE64;
const keyId = process.env.YUANPU_ARTIFACT_SIGNING_KEY_ID;
const baseUrl = process.env.YUANPU_ARTIFACT_BASE_URL;
if (!privateBase64 || !publicBase64 || !keyId || !baseUrl) {
  throw new Error('Production capability private key, public trust root, key id, and base URL are required.');
}
const derived = createPublicKey(createPrivateKey(Buffer.from(privateBase64, 'base64').toString('utf8')))
  .export({ format: 'der', type: 'spki' });
const configured = createPublicKey(Buffer.from(publicBase64, 'base64').toString('utf8'))
  .export({ format: 'der', type: 'spki' });
if (!derived.equals(configured)) throw new Error('Capability private key and desktop trust root do not match.');
new URL(baseUrl);
console.log(`Validated production capability signing configuration for ${keyId}.`);
