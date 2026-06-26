const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'linuxdo-helper', 'background.js'),
  'utf8'
);
const storageSource = fs.readFileSync(
  path.join(__dirname, '..', 'linuxdo-helper', 'lib', 'storage.js'),
  'utf8'
);
const topicFilterSource = fs.readFileSync(
  path.join(__dirname, '..', 'linuxdo-helper', 'lib', 'topic-filter.js'),
  'utf8'
);
const contentSource = fs.readFileSync(
  path.join(__dirname, '..', 'linuxdo-helper', 'content', 'content.js'),
  'utf8'
);

function getFunctionBody(name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} should exist`);
  const signatureEnd = source.indexOf(')', start);
  const open = source.indexOf('{', signatureEnd);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') depth--;
    if (depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`Could not parse ${name}`);
}

function getSwitchCaseBody(caseName) {
  const start = source.indexOf(`case '${caseName}':`);
  assert.notEqual(start, -1, `${caseName} case should exist`);
  const nextCase = source.indexOf('\n      case ', start + 1);
  const end = nextCase === -1 ? source.indexOf('\n      default:', start + 1) : nextCase;
  return source.slice(start, end === -1 ? source.length : end);
}

test('operation persistence does not overwrite the full state object', () => {
  const setOperation = getFunctionBody('setOperation');
  const clearOperation = getFunctionBody('clearOperation');

  assert.doesNotMatch(setOperation, /chrome\.storage\.local\.get\(\['state'\]\)/);
  assert.doesNotMatch(clearOperation, /chrome\.storage\.local\.get\(\['state'\]\)/);
  assert.doesNotMatch(setOperation, /chrome\.storage\.local\.set\(\{\s*state\s*\}\)/);
  assert.doesNotMatch(clearOperation, /chrome\.storage\.local\.set\(\{\s*state\s*\}\)/);
  assert.doesNotMatch(setOperation, /setState\(\{\s*persistedOp:/);
  assert.doesNotMatch(clearOperation, /setState\(\{\s*persistedOp:/);
  assert.match(source, /chrome\.storage\.local\.set\(\{\s*persistedOp:/);
});

test('manual run does not set a running operation before preflight checks pass', () => {
  const runNow = getSwitchCaseBody('runNow');

  assert.doesNotMatch(runNow, /setOperation\(/);
  assert.match(runNow, /handleNewTopicsCheck\(\)/);
});

test('topic reply interval waits only after a successful post', () => {
  const body = getFunctionBody('handleNewTopicsCheck');

  assert.match(body, /let\s+replyPosted\s*=\s*false/);
  assert.match(body, /replyPosted\s*=\s*true/);
  assert.match(body, /if\s*\(\s*replyPosted\s*\)/);
});

test('rate-limit exits persist queue history and avoid a stuck processing item', () => {
  const body = getFunctionBody('handleNewTopicsCheck');

  assert.match(body, /operationQueue\[qi\]\.status\s*=\s*'pending'/);
  assert.match(body, /s\.lastQueue\s*=\s*operationQueue\.slice\(\)/);
});

test('navigation tasks use a persisted task lock and manual run reports contention', () => {
  assert.match(source, /async function acquireTaskLock\(/);
  assert.match(source, /async function releaseTaskLock\(/);
  assert.match(source, /TASK_LOCK_TTL_MS/);
  assert.match(source, /taskLocked:/);

  const runNow = getSwitchCaseBody('runNow');
  assert.match(runNow, /handleNewTopicsCheck\(\)/);
  assert.match(runNow, /return await handleNewTopicsCheck\(\)/);
  assert.match(source, /已有任务运行中/);
});

test('reply interval is persisted and alarm-driven instead of long service-worker sleep', () => {
  const topicBody = getFunctionBody('handleNewTopicsCheck');
  const notificationBody = getFunctionBody('handleNotificationCheck');
  const shouldProceed = getFunctionBody('shouldProceed');

  assert.doesNotMatch(topicBody, /await sleep\(settings\.minReplyInterval \* 60000\)/);
  assert.doesNotMatch(notificationBody, /await sleep\(settings\.minReplyInterval \* 60000\)/);
  assert.match(source, /nextReplyAllowedAt/);
  assert.match(source, /wakeAfterReplyInterval/);
  assert.match(source, /scheduleReplyWakeAlarm\(/);
  assert.match(shouldProceed, /nextReplyAllowedAt/);
});

test('navigateAndAct cleans up tab listeners and retry timers on every exit path', () => {
  const navigateBody = getFunctionBody('navigateAndAct');
  const cleanupBody = getFunctionBody('cleanupRequest');

  assert.match(navigateBody, /pendingRequests\[requestId\]\s*=\s*\{[^}]*onUpdated:\s*null/s);
  assert.match(navigateBody, /pendingRequests\[requestId\]\.onUpdated\s*=\s*onUpdated/);
  assert.match(navigateBody, /\.retryTimer\s*=\s*setTimeout/);
  assert.match(navigateBody, /chrome\.tabs\.update\(tabId,\s*\{\s*url\s*\},\s*\(\)\s*=>/);
  assert.match(cleanupBody, /chrome\.tabs\.onUpdated\.removeListener\(entry\.onUpdated\)/);
  assert.match(cleanupBody, /clearTimeout\(entry\.retryTimer\)/);
});

test('state updates have a serialized updateState helper', () => {
  assert.match(storageSource, /let stateUpdateQueue\s*=\s*Promise\.resolve\(\)/);
  assert.match(storageSource, /async function updateState\(mutator\)/);
  assert.match(storageSource, /stateUpdateQueue\s*=\s*stateUpdateQueue\.then/);
  assert.match(source, /updateState\(async state =>|updateState\(state =>/);
});

test('notifications are marked terminal for skipped discarded and failed cases', () => {
  const body = getFunctionBody('handleNotificationCheck');

  assert.match(body, /MAX_NOTIFICATION_ATTEMPTS/);
  assert.match(body, /try\s*\{/);
  assert.match(body, /status:\s*'skipped'/);
  assert.match(body, /status:\s*'discarded'/);
  assert.match(body, /status:\s*attempts\s*>=\s*MAX_NOTIFICATION_ATTEMPTS\s*\?\s*'failed'/);
  assert.match(body, /attempts/);
});

test('new topics use worth-replying gate before generation', () => {
  assert.match(topicFilterSource, /function buildWorthReplyingPrompt/);
  assert.match(topicFilterSource, /async function evaluateAndReply/);
  assert.match(topicFilterSource, /score[^<]+<\s*6|score[^>]+>=\s*6/);
  assert.match(source, /evaluateAndReply\(topicData,\s*settings\.apiKey,\s*chat\)/);
  assert.doesNotMatch(source, /generateReplyWithSafetyCheck\(topicData,\s*settings\.apiKey,\s*chat\)/);
});

test('content script separates safe topic and post reply button selection', () => {
  assert.match(contentSource, /function findTopicReplyButton\(/);
  assert.match(contentSource, /function findPostReplyButton\(postNumber\)/);
  assert.match(contentSource, /function isUsableButton\(/);
  assert.match(contentSource, /function findComposerSubmitButton\(/);
  assert.doesNotMatch(contentSource, /function findReplyButton\(/);
});
