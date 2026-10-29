import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {releaseConfiguration} from './configuration.mjs';
const hosted = {VITE_API_URL: '/api', VITE_COGNITO_DOMAIN: 'https://pilot.auth.us-east-1.amazoncognito.com', VITE_COGNITO_CLIENT_ID: 'client'};
const inapp = {...hosted, VITE_COGNITO_USER_POOL_ID: 'us-east-1_example', VITE_AUTH_FLOW: 'inapp'};
test('legacy hosted configuration retains its release identity', () => {
  assert.deepEqual(releaseConfiguration(hosted), {apiUrl: '/api', cognitoDomain: hosted.VITE_COGNITO_DOMAIN, clientId: 'client'});
});
test('pool identity and login flow are bound to separate release approvals', () => {
  const hash = env => createHash('sha256').update(JSON.stringify(releaseConfiguration(env))).digest('hex');
  const variants = [hosted, inapp, {...inapp, VITE_COGNITO_USER_POOL_ID: 'us-east-1_other'}, {...inapp, VITE_AUTH_FLOW: 'redirect'}];
  assert.equal(new Set(variants.map(hash)).size, variants.length);
  assert.equal(releaseConfiguration({...inapp, VITE_AUTH_FLOW: ''}).authFlow, 'inapp');
});
test('production configuration rejects missing pools, offline endpoints, and invalid settings', () => {
  for (const env of [
    {...hosted, VITE_AUTH_FLOW: 'inapp'}, {...inapp, VITE_AUTH_FLOW: 'typo'},
    {...inapp, VITE_COGNITO_USER_POOL_ID: 'us-west-2_example'},
    {...inapp, VITE_COGNITO_REGION: 'us-west-2'},
    {...inapp, VITE_COGNITO_ENDPOINT: 'http://127.0.0.1:9229'},
    {...inapp, VITE_API_URL: 'https://example.test'},
  ]) assert.throws(() => releaseConfiguration(env));
});
