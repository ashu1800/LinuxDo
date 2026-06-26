const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'linuxdo-helper', 'background.js'),
  'utf8'
);

function getFunctionBody(name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} should exist`);
  const open = source.indexOf('{', start);
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
  assert.match(body, /state\.lastQueue\s*=\s*operationQueue\.slice\(\)/);
});
