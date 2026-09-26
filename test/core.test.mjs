import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS, PendingGuides, inject, renderTemplate } from '../dist/core.js'

test('template substitution preserves plain text, all occurrences, and static templates', () => {
  assert.equal(renderTemplate('Before {{input}} after', 'hello'), 'Before hello after')
  assert.equal(renderTemplate('{{input}} / {{input}}', '<rain>\n'), '<rain>\n / <rain>\n')
  assert.equal(renderTemplate('static', 'hello'), 'static')
  assert.throws(() => renderTemplate('  ', 'hello'), /cannot be empty/)
})
test('pending guides isolate user, chat, browser, generation type, preview and expire', () => {
  const p = new PendingGuides()
  const item = { userId: 'u', chatId: 'A', sessionId: 's', token: 't', input: 'hello', settings: DEFAULT_SETTINGS, expiresAt: 200 }
  p.arm(item, 100)
  assert.equal(p.consume('u', 'B', 's', 'normal', false, 101), undefined)
  assert.equal(p.consume('other', 'A', 's', 'normal', false, 101), undefined)
  assert.equal(p.consume('u', 'A', 'other', 'normal', false, 101), undefined)
  assert.equal(p.consume('u', 'A', 's', 'swipe', false, 101), undefined)
  assert.equal(p.consume('u', 'A', 's', 'normal', true, 101), undefined)
  assert.equal(p.consume('u', 'A', 's', 'normal', false, 101), item)
  assert.equal(p.consume('u', 'A', 's', 'normal', false, 102), undefined)
  p.arm(item, 100); p.cancel('u', 'A', 'wrong'); assert.equal(p.consume('u', 'A', 's', 'normal', false, 101), item)
  p.arm(item, 100); p.cancel('u', 'A', 't'); assert.equal(p.consume('u', 'A', 's', 'normal', false, 101), undefined)
  p.arm(item, 100); assert.equal(p.consume('u', 'A', 's', 'normal', false, 201), undefined)
})
test('injection role, content and breakdown', () => {
  const old = [{ role: 'assistant', content: 'Prior message' }]
  const output = inject(old, { input: 'rain', settings: { ...DEFAULT_SETTINGS, role: 'user', template: 'Guide: {{input}}' } })
  assert.deepEqual(output.messages, [{ role: 'user', content: 'Guide: rain' }, ...old])
  assert.deepEqual(output.breakdown, [{ messageIndex: 0, name: 'Scene Direction' }])
})
