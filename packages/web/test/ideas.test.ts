import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Idea } from '@freedms/shared';
import { ideasHtml, ideasQueueHtml } from '../src/ideas.js';
import { sidebarNavigation } from '../src/sidebar.js';
const idea: Idea = {id: 'id', tenantId: 'a', submitter: {id: 'one', name: '<script>user</script>', email: 'one@example.test'}, title: '<img src=x>', description: '<script>description</script>', surface: '/ideas', productVersion: '0.1.0', status: 'Declined', declineReason: '<b>Reason</b>', shippedNote: null, version: 1, createdAt: '2026-11-01T12:00:00Z', updatedAt: '2026-11-01T12:00:00Z'};
test('Ideas UI starts empty, separates dealership submissions and escapes all user content', () => {
  assert.match(ideasHtml([]), /No ideas yet/); assert.doesNotMatch(ideasHtml([]), /Your dealership’s ideas/);
  const html = ideasHtml([idea], [idea]);
  assert.match(html, /Your dealership’s ideas/); assert.match(html, /&lt;b&gt;Reason/); assert.doesNotMatch(html, /<script>|<img/);
  assert.match(ideasHtml([{...idea, status: 'Shipped', shippedNote: 'Release 0.2'}]), /Release 0.2/);
  const queue = ideasQueueHtml([{...idea, tenantName: '<b>Dealer</b>'}]);
  assert.match(queue, /&lt;b&gt;Dealer/); assert.match(queue, /Product version/); assert.match(queue, /Decline reason/);
  assert.doesNotMatch(queue, /<script>|<img/);
});
test('Ideas navigation is available to members and review is restricted to the pilot operator', () => {
  assert.match(sidebarNavigation(false), /href="#\/ideas"/);
  assert.doesNotMatch(sidebarNavigation(true), /ideas-review/);
  assert.doesNotMatch(sidebarNavigation(false, true), /ideas-review/);
  assert.match(sidebarNavigation(true, true), /ideas-review/);
});
