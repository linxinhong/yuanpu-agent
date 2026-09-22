import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildRequest,
  callJev,
  evaluate,
  exactChecks,
  sanitizeForOutbound,
  serviceFailureReport,
  validateDataset,
} from '../jev-evidence-review.mjs';

const fixtureUrl = new URL('../fixtures/jev-evidence-cases.json', import.meta.url);
const loadFixture = async () => validateDataset(JSON.parse(await readFile(fixtureUrl, 'utf8')));

test('validates the 24-case tuning/holdout corpus and all required labels', async () => {
  const dataset = await loadFixture();
  assert.equal(dataset.cases.length, 24);
  assert.deepEqual(new Set(dataset.cases.map((item) => item.split)), new Set(['tuning', 'holdout']));
  assert.deepEqual(new Set(dataset.cases.map((item) => item.label)), new Set(['supported', 'contradicted', 'insufficient']));
  const text = JSON.stringify(dataset).toLowerCase();
  for (const phrase of ['build', 'revision', 'platform', 'fixture', 'submitted', 'delivery unknown', 'session', 'duplicate', 'ignore previous']) assert.match(text.toLowerCase(), new RegExp(phrase));
});

test('rejects extra fields, secrets, local paths, long text, and unknown events', async () => {
  const base = await loadFixture();
  const variants = [
    (item) => { item.rawLog = 'hidden'; },
    (item) => { item.summary = 'authorization: Bearer abcdefghijklmnop'; },
    (item) => { item.summary = 'Evidence stored in /Users/alice/private.log'; },
    (item) => { item.summary = 'Evidence stored in /workspace/private/run.log'; },
    (item) => { item.summary = 'Evidence stored at file:///workspace/private/original.log'; },
    (item) => { item.summary = 'Evidence stored at `/workspace/private/original.log`'; },
    (item) => { item.summary = 'path=/workspace/private/original.log'; },
    (item) => { item.summary = '/secret'; },
    (item) => { item.summary = 'Evidence stored at C:\\workspace\\private.log'; },
    (item) => { item.summary = 'Evidence stored at \\\\server\\share\\private.log'; },
    (item) => { item.summary = 'Evidence stored at .\\private\\secret.log'; },
    (item) => { item.summary = 'x'.repeat(1_001); },
    (item) => { item.events = ['shell.execute']; },
  ];
  for (const mutate of variants) {
    const dataset = structuredClone(base);
    mutate(dataset.cases[0]);
    assert.throws(() => validateDataset(dataset));
  }
});

test('rejects duplicate acceptance and evidence identifiers', async () => {
  for (const field of ['acceptance', 'evidence']) {
    const dataset = structuredClone(await loadFixture());
    dataset.cases[1][field].id = dataset.cases[0][field].id;
    assert.throws(() => validateDataset(dataset), /must be unique/);
  }
});

test('keeps local evidence mapping out of the outbound request', async () => {
  const dataset = await loadFixture();
  const item = dataset.cases[0];
  const outbound = sanitizeForOutbound(item);
  assert.deepEqual(Object.keys(outbound), ['case_id', 'acceptance', 'evidence_summary', 'event_types']);
  const serialized = JSON.stringify(buildRequest([item]));
  assert.doesNotMatch(serialized, new RegExp(item.evidence.revision));
  assert.doesNotMatch(serialized, /expectedRevision|requiredPlatforms|exitCode/);
});

test('runs exact checks before semantic review', async () => {
  const dataset = await loadFixture();
  assert.deepEqual(exactChecks(dataset.cases.find((item) => item.id === 'holdout-stale-revision')).failures, ['revision_mismatch']);
  assert.deepEqual(exactChecks(dataset.cases.find((item) => item.id === 'holdout-missing-platform')).failures, ['platform_missing']);
  assert.deepEqual(exactChecks(dataset.cases.find((item) => item.id === 'holdout-fixture-as-real')).failures, ['mode_mismatch']);
});

test('turns malformed API output into an error without exposing the API key', async () => {
  const dataset = await loadFixture();
  const fetchImpl = async (_url, request) => {
    assert.equal(request.headers.authorization, 'Bearer test-secret-value');
    assert.doesNotMatch(request.body, /test-secret-value/);
    return { ok: true, json: async () => ({ model: 'jev-test', answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }) };
  };
  await assert.rejects(callJev([dataset.cases[0]], { apiKey: 'test-secret-value', fetchImpl }), /missing Choice answer/);
});

test('does not retry rate limits and reports only the status', async () => {
  const dataset = await loadFixture();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: false, status: 429 }; };
  await assert.rejects(callJev([dataset.cases[0]], { apiKey: 'test-secret-value', fetchImpl }), /HTTP 429/);
  assert.equal(calls, 1);
});

test('fails closed without a key and on timeout', async () => {
  const dataset = await loadFixture();
  const previousJev = process.env.JEV_API_KEY;
  const previousTypesafe = process.env.TYPESAFE_API_KEY;
  delete process.env.JEV_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    await assert.rejects(callJev([dataset.cases[0]]), /is required/);
  } finally {
    if (previousJev === undefined) delete process.env.JEV_API_KEY; else process.env.JEV_API_KEY = previousJev;
    if (previousTypesafe === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = previousTypesafe;
  }
  const fetchImpl = async (_url, request) => new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => reject(new Error('timeout test did not abort')), 1_000);
    request.signal.addEventListener('abort', () => {
      clearTimeout(keepAlive);
      reject(request.signal.reason);
    }, { once: true });
  });
  await assert.rejects(callJev([dataset.cases[0]], { apiKey: 'test-secret-value', timeoutMs: 5, fetchImpl }), /abort|timeout/i);
});

test('converts service failures into human-review tasks', async () => {
  const dataset = await loadFixture();
  for (const [message, category] of [
    ['JEV_API_KEY or TYPESAFE_API_KEY is required for --live', 'missing_api_key'],
    ['TypeSafe request failed with HTTP 429', 'rate_limited'],
    ['The operation was aborted due to timeout', 'timeout'],
    ['missing Choice answer for case', 'invalid_response'],
  ]) {
    const report = serviceFailureReport(dataset, new Error(message));
    assert.equal(report.status, 'human_review_required');
    assert.equal(report.errorCategory, category);
    assert.equal(report.humanReviewTasks.length, 24);
    assert.equal(report.recommendation, 'do_not_adopt');
  }
});

test('keeps low confidence and exact failures in human review', async () => {
  const dataset = await loadFixture();
  const predictions = dataset.cases.map((item) => ({ id: item.id, prediction: item.fixturePrediction, confidence: item.id === 'tuning-supported-real' ? 0.3 : item.fixtureConfidence, probabilities: null }));
  const report = evaluate(dataset, predictions, { mode: 'fixture' });
  assert.equal(report.recommendation, 'do_not_adopt');
  assert(report.recommendationReasons.includes('no_live_api_evidence'));
  assert(report.recommendationReasons.includes('human_timing_or_miss_baseline_unverified'));
  assert.equal(report.predictions.find((item) => item.id === 'tuning-supported-real').needsHumanReview, true);
  assert.equal(report.predictions.find((item) => item.id === 'holdout-stale-revision').needsHumanReview, true);
});

test('does not accept impossible human comparison metrics', async () => {
  const dataset = await loadFixture();
  const predictions = dataset.cases.map((item) => ({ id: item.id, prediction: item.fixturePrediction, confidence: item.fixtureConfidence, probabilities: null }));
  for (const metrics of [
    { humanBaselineMs: 100, assistedReviewMs: -1, humanFalseSupported: 0 },
    { humanBaselineMs: 100, assistedReviewMs: 50, humanFalseSupported: 999 },
  ]) {
    const report = evaluate(dataset, predictions, { mode: 'live', ...metrics });
    assert.equal(report.humanComparison.complete, false);
    assert.equal(report.recommendation, 'do_not_adopt');
  }
});
