import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveArtifactSigningKeyId } from './signing-key-id.mjs';

test('empty CI key id selects only the development signing identity', () => {
  assert.equal(resolveArtifactSigningKeyId('', false), 'yuanpu-development-ephemeral');
  assert.equal(resolveArtifactSigningKeyId('  ', false), 'yuanpu-development-ephemeral');
  assert.equal(resolveArtifactSigningKeyId('production-key', true), 'production-key');
  assert.throws(
    () => resolveArtifactSigningKeyId('', true),
    /YUANPU_ARTIFACT_SIGNING_KEY_ID is required with a production trust root/,
  );
  assert.throws(
    () => resolveArtifactSigningKeyId(undefined, true),
    /YUANPU_ARTIFACT_SIGNING_KEY_ID is required with a production trust root/,
  );
});
