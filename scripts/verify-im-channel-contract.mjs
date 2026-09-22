import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const contractPath = resolve(root, process.argv[2] ?? 'docs/im-channel-contract.json');
const contract = JSON.parse(await readFile(contractPath, 'utf8'));

assert.equal(contract.contractVersion, 2);
assert.equal(contract.decision.status, 'selected');
assert.equal(contract.decision.selectedCandidateId, 'wecom-intelligent-bot-ws');
assert.ok(contract.candidateIds.includes(contract.decision.selectedCandidateId));
assert.match(contract.decision.userDecisionRef, /^decision:/);
assert.ok([
  'awaiting-account-permission-credentials-and-test-conversations',
  'ready-for-e2e',
].includes(contract.decision.environmentStatus));
assert.ok(contract.providerLimits && typeof contract.providerLimits === 'object');
assert.ok(contract.providerLimits.officialSourceUrls.length >= 3);
for (const url of contract.providerLimits.officialSourceUrls) {
  assert.match(url, /^https:\/\//);
}

if (contract.decision.environmentStatus === 'ready-for-e2e') {
  assert.match(contract.decision.accountPermissionRef, /^evidence:/);
  assert.match(contract.decision.credentialBindingRef, /^secret-store:/);
  assert.ok(contract.decision.testConversationRefs.length >= 2);
  assert.equal(contract.verificationEnvironment.status, 'ready');
} else {
  assert.equal(contract.decision.accountPermissionRef, null);
  assert.equal(contract.decision.credentialBindingRef, null);
  assert.deepEqual(contract.decision.testConversationRefs, []);
  assert.equal(contract.decision.e2eStatus, 'unverified');
  assert.equal(contract.verificationEnvironment.status, 'unavailable');
  assert.ok(contract.verificationEnvironment.missing.length >= 4);
}

assert.equal(contract.selectedIntegration.provider, 'wecom');
assert.equal(contract.selectedIntegration.mode, 'api-websocket-long-connection');
assert.equal(contract.selectedIntegration.officialPackage.name, '@wecom/aibot-node-sdk');
assert.equal(contract.selectedIntegration.officialPackage.license, 'MIT');
assert.equal(contract.selectedIntegration.officialPackage.node24Compatibility, 'unverified');
assert.equal(contract.selectedIntegration.adapterStrategy, 'yuanpu-owned-wrapper-around-official-sdk');

assert.equal(contract.connection.lifecycleOwner, 'desktop-app-runtime');
assert.equal(contract.connection.transport, 'websocket');
assert.equal(contract.connection.officialEndpoint, 'wss://openws.work.weixin.qq.com');
assert.equal(contract.connection.backgroundAfterAppExit, false);
assert.equal(contract.connection.disconnectOnAppExit, true);
assert.equal(contract.connection.publicInboundEndpoint, false);
assert.equal(contract.verificationEnvironment.publicInboundPortRequired, false);

assert.deepEqual(contract.credentials.secretRefs, [
  'keychain:yuanpu/im/<connectionId>/bot-secret',
]);
assert.equal(contract.credentials.secretValuesAllowedInConfig, false);
assert.equal(contract.credentials.secretValuesAllowedInLogs, false);

assert.equal(contract.inbound.providerCommand, 'aibot_msg_callback');
assert.equal(contract.inbound.providerAckMode, 'no-separate-inbound-ack-in-official-sdk');
assert.equal(contract.inbound.persistBeforeAgentDispatch, true);
assert.deepEqual(contract.inbound.dedupeKeyFields, [
  'provider',
  'connectionId',
  'providerMessageId',
]);
assert.equal(contract.inbound.fieldMapping.providerRequestId, 'headers.req_id');
assert.equal(contract.inbound.fieldMapping.providerMessageId, 'body.msgid');
assert.equal(contract.inbound.fieldMapping.trustedSenderId, 'body.from.userid');
assert.equal(contract.inbound.providerBotIdMustMatchConnection, true);
assert.equal(contract.inbound.offlineRecovery, 'unverified');

assert.equal(contract.identity.trustMessageBodyIdentity, false);
assert.equal(contract.identity.directMessagePolicy, 'paired-only');
assert.equal(
  contract.identity.groupPolicy,
  'allowlist-paired-sender-and-provider-at-mention',
);
assert.equal(contract.identity.groupRequiresPairedSender, true);
assert.equal(contract.identity.groupRequiresAllowlistedConversation, true);
assert.equal(
  contract.identity.groupTriggerSemantics,
  'provider-emits-group-callback-only-when-bot-is-mentioned',
);
assert.equal(contract.identity.groupEnabledBeforeRealTriggerTest, false);
assert.deepEqual(contract.session.keyFields, [
  'provider',
  'providerAccountRef',
  'connectionId',
  'conversationType',
  'peerId',
]);
assert.equal(contract.session.threadSupport, 'not-present-in-official-protocol');
assert.equal(contract.session.crossAccountReuse, false);
assert.equal(contract.session.crossConnectionReuse, false);
assert.equal(contract.session.crossPeerReuse, false);

assert.equal(contract.replyRoute.providerCommand, 'aibot_respond_msg');
assert.equal(contract.replyRoute.providerRequestIdSource, 'original-callback-headers.req_id');
assert.equal(contract.replyRoute.immutableAfterInbound, true);
assert.equal(contract.replyRoute.modelMayOverride, false);
assert.equal(contract.replyRoute.fallbackToDifferentConversation, false);

assert.deepEqual(contract.outbound.states, ['pending', 'accepted', 'failed', 'unknown']);
assert.equal(contract.outbound.successSignal, 'ack-frame-errcode-equals-zero');
assert.equal(contract.outbound.providerMessageIdRequiredForSuccess, false);
assert.equal(contract.outbound.activeSendRequiresChatType, true);
assert.equal(contract.outbound.sdkTimeoutIsProviderSla, false);
assert.equal(contract.outbound.timeoutAfterPossibleWrite, 'unknown');
assert.equal(contract.outbound.disconnectAfterPossibleWrite, 'unknown');
assert.equal(contract.outbound.blindRetryUnknown, false);
assert.equal(contract.outbound.rerunAgentOnDeliveryFailure, false);

assert.deepEqual(contract.attachments.initiallyAcceptedTypes, ['text']);
assert.equal(contract.attachments.autoFetchRemoteResources, false);
assert.equal(contract.logging.officialDefaultLoggerAllowed, false);
assert.equal(contract.logging.requiredLogger, 'yuanpu-redacting-logger');
assert.equal(contract.logging.debugRawFramesAllowed, false);
for (const field of [
  'secret',
  'userid',
  'chatid',
  'message-content',
  'attachment-url',
  'aeskey',
  'response_url',
  'raw-frame',
]) {
  assert.ok(contract.logging.forbiddenFields.includes(field), `missing forbidden log field: ${field}`);
}
assert.equal(contract.configurationFields.provider, 'wecom');
assert.equal(contract.configurationFields.directMessagePolicy, 'paired-only');
assert.equal(
  contract.configurationFields.groupPolicy,
  'allowlist-paired-sender-and-provider-at-mention',
);
assert.deepEqual(contract.configurationFields.acceptedMessageTypes, ['text']);
assert.equal(contract.configurationFields.sdkOptionsPassthrough, false);
assert.equal(contract.configurationFields.customWsUrlAllowed, false);
assert.equal(contract.providerLimits.replyAndActiveSendPerConversationPerMinute, 30);
assert.equal(contract.providerLimits.replyAndActiveSendPerConversationPerHour, 1000);
assert.equal(contract.providerLimits.normalReplyWindowHours, 24);
assert.equal(contract.providerLimits.heartbeatRecommendedSeconds, 30);
assert.equal(contract.providerLimits.inboundMediaUrlLifetimeMinutes, 5);

const fixturePath = resolve(root, contract.fixtureScope.scenarioFile);
const fixtures = JSON.parse(await readFile(fixturePath, 'utf8'));
assert.equal(fixtures.fixtureVersion, 2);
assert.equal(fixtures.provider, 'wecom');
assert.equal(fixtures.payloadKind, 'normalized-only');

const requiredScenarios = new Set([
  'wecom-single-allowed-text',
  'wecom-group-policy-after-e2e-enable',
  'wecom-unauthorized-sender',
  'wecom-duplicate-msgid',
  'wecom-same-msgid-different-connection',
  'wecom-same-user-different-bot-account',
  'wecom-reply-route',
  'wecom-ack-errcode-failure',
  'wecom-ack-timeout-after-write',
  'wecom-restart-with-persisted-msgid',
  'wecom-unsupported-attachment',
  'wecom-redacting-logger',
  'wecom-offline-gap-unverified',
  'wecom-app-exit',
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
  `IM contract verification passed: provider=${contract.selectedIntegration.provider}, environment=${contract.decision.environmentStatus}, scenarios=${fixtures.scenarios.length}`,
);
