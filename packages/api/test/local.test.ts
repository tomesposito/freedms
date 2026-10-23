import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localAuth } from '../src/local-auth.js';
import { LocalTokens } from '../src/auth.js';

test('local adapter skips session verification for public shares and intake', () => {
  const tokens = {verify: (): never => { throw new Error('Session verification must not run'); }};
  for (const token of ['', 'garbage']) {
    for (const path of ['/share/abc.def', '/share/abc.def/', '/share/abc.def/respond', '/share/abc.def/documents/']) {
      // Credential selection is independent of the HTTP method.
      assert.deepEqual(localAuth(path, false, token, tokens), {});
    }
    assert.deepEqual(localAuth('/intake/adf', true, token, tokens), {intakeToken: token});
  }
});

test('local adapter preserves session verification for all other paths', () => {
  const tokens = new LocalTokens('local-adapter-test-secret-at-least-32-characters');
  const valid = tokens.issue('dealer', 'tenant');
  for (const path of ['/vehicles', '/deals/example/share', '/share', '/share/', '/share-other/abc.def', '/intake/adf']) {
    for (const token of ['', 'garbage']) {
      assert.throws(() => localAuth(path, false, token, tokens), {status: 401, code: 'UNAUTHORIZED', message: 'Sign in to continue.'});
    }
    assert.deepEqual(localAuth(path, false, valid, tokens), {claims: tokens.verify(valid)});
  }
});
