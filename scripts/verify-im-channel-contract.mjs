import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const contractPath = resolve(root, process.argv[2] ?? 'docs/im-channel-contract.json');
const contract = JSON.parse(await readFile(contractPath, 'utf8'));

assert.equal(contract.contractVersion, 1);
assert.ok(Array.isArray(contract.candidateIds) && contract.candidateIds.length >= 3);
assert.ok(['awaiting-user-selection', 'selected'].includes(contract.decision.status));

if (contract.decision.status === 'awaiting-user-selection') {
  assert.equal(contract.decision.selectedCandidateId, null);
  assert.equal(contract.decision.userDecisionRef, null);
  assert.equal(contract.providerLimits, null);
} else {
  assert.ok(contract.candidateIds.includes(contract.decision.selectedCandidateId));
  assert.match(contract.decision.userDecisionRef, /^decision:/);
  assert.match(contract.decision.accountPermissionRef, /^evidence:/);
  assert.ok(contract.decision.testConversationRefs.length >= 2);
  assert.ok(contract.providerLimits && typeof contract.providerLimits === 'object');
  assert.match(contract.providerLimits.officialSourceUrl, /^https:\/\//);
  const needsInboundGateway = contract.architectureChangeCandidateIds.includes(
    contract.decision.selectedCandidateId,
  );
  assert.equal(contract.connection.publicInboundEndpoint, needsInboundGateway);
}

assert.equal(contract.connection.lifecycleOwner, 'desktop-app-runtime');
assert.equal(contract.connection.backgroundAfterAppExit, false);
assert.equal(contract.connection.publicInboundEndpoint, false);
assert.equal(contract.inbound.persistBeforeAck, true);
assert.equal(contract.inbound.executeAsynchronouslyAfterAck, true);
assert.deepEqual(contract.inbound.dedupeKeyFields, [
  'provider',
  'connectionId',
  'providerDeliveryId',
]);
assert.equal(contract.identity.trustMessageBodyIdentity, false);
assert.equal(contract.identity.groupRequiresPairedSender, true);
assert.equal(contract.identity.groupRequiresAllowlistedConversation, true);
assert.equal(contract.identity.groupRequiresBotMention, true);
assert.equal(contract.replyRoute.immutableAfterInbound, true);
assert.equal(contract.replyRoute.modelMayOverride, false);
assert.equal(contract.replyRoute.fallbackToDifferentConversation, false);
assert.deepEqual(contract.outbound.states, ['pending', 'delivered', 'failed', 'unknown']);
assert.equal(contract.outbound.timeoutAfterPossibleWrite, 'unknown');
assert.equal(contract.outbound.blindRetryUnknown, false);
assert.equal(contract.outbound.rerunAgentOnDeliveryFailure, false);
assert.deepEqual(contract.attachments.initiallyAcceptedTypes, ['text']);
assert.equal(contract.attachments.autoFetchRemoteResources, false);
assert.equal(contract.configurationFields.directMessagePolicy, 'paired-only');
assert.equal(contract.configurationFields.groupPolicy, 'allowlist-and-mention');
assert.equal(contract.configurationFields.secretValuesAllowed, false);
assert.equal(contract.configurationFields.sdkOptionsPassthrough, false);

for (const candidateId of contract.candidateIds) {
  const refs = contract.candidateCredentialRefs[candidateId];
  assert.ok(Array.isArray(refs) && refs.length >= 2, `missing credential refs for ${candidateId}`);
  for (const ref of refs) {
    assert.match(ref, /^(env|keychain):/);
  }
}

const fixturePath = resolve(root, contract.fixtureScope.scenarioFile);
const fixtures = JSON.parse(await readFile(fixturePath, 'utf8'));
assert.equal(fixtures.fixtureVersion, 1);
assert.equal(fixtures.payloadKind, 'normalized-only');

const requiredScenarios = new Set([
  'dm-allowed-text',
  'group-allowed-mention',
  'unauthorized-sender',
  'duplicate-provider-delivery',
  'same-message-different-connection',
  'thread-reply-route',
  'send-timeout-after-write',
  'restart-with-persisted-dedupe',
  'unsupported-attachment',
  'offline-gap-unverified',
]);
const actualScenarios = new Set(fixtures.scenarios.map(({ id }) => id));
assert.equal(actualScenarios.size, fixtures.scenarios.length, 'fixture scenario IDs must be unique');
for (const id of requiredScenarios) {
  assert.ok(actualScenarios.has(id), `missing required fixture scenario: ${id}`);
}
for (const scenario of fixtures.scenarios) {
  assert.ok(Array.isArray(scenario.expect) && scenario.expect.length > 0, `${scenario.id} has no expectations`);
}

console.log(
  `IM contract verification passed: decision=${contract.decision.status}, scenarios=${fixtures.scenarios.length}`,
);
