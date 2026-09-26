import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS, PendingGuides, inject, renderTemplate, normalizeSettings } from '../dist/core.js'

test('template substitution preserves plain text, all occurrences, and static templates', () => {
  assert.equal(renderTemplate('Before {{input}} after', 'hello'), 'Before hello after')
  assert.equal(renderTemplate('{{input}} / {{input}}', '<rain>\n'), '<rain>\n / <rain>\n')
  assert.equal(renderTemplate('static', 'hello'), 'static')
  assert.throws(() => renderTemplate('  ', 'hello'), /cannot be empty/)
  for (const input of ['$&', '$$', '$`', "$'", '$& and $$\n{{input}}']) {
    assert.equal(renderTemplate('Before {{input}} / {{input}} after', input), `Before ${input} / ${input} after`)
  }
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
  p.start('u', 'A', 's', 'normal', 'generation', 101)
  assert.equal(p.consume('u', 'A', 's', 'normal', false, 1000), item)
  assert.equal(p.consume('u', 'A', 's', 'normal', false, 102), undefined)
  p.cancel('u', 'A', 'wrong'); assert.equal(p.get('u', 'A'), item)
  p.cancel('u', 'A', 't', 'wrong-session'); assert.equal(p.get('u', 'A'), item)
  p.cancel('u', 'A', 't', 's'); assert.equal(p.get('u', 'A'), undefined)
  const expired = { ...item, generationId: undefined, consumed: false }
  p.arm(expired, 100)
  assert.equal(p.start('u', 'A', 's', 'normal', 'late-generation', 201), undefined)
  assert.throws(() => p.activate(expired, DEFAULT_SETTINGS, 201), /cancelled or timed out/)
})

test('cancelled preparation cannot activate or replace a newer guide', () => {
  const p = new PendingGuides()
  const first = { userId: 'u', chatId: 'A', sessionId: 's', token: 'old', input: 'old', expiresAt: 200 }
  p.arm(first, 100)
  assert.throws(() => p.arm({ ...first, token: 'duplicate' }, 100), /already pending/)
  p.cancel('u', 'A', 'old', 's')
  const next = { ...first, token: 'new', input: 'new' }
  p.arm(next, 100)
  assert.throws(() => p.activate(first, DEFAULT_SETTINGS, 101), /cancelled/)
  p.activate(next, DEFAULT_SETTINGS, 101)
  p.start('u', 'A', 's', 'normal', 'g', 101)
  assert.equal(p.consume('u', 'A', 's', 'normal', false, 1000).input, 'new')
})
test('injection follows the last stored turn and keeps post-history instructions and prefill after it', () => {
  const old = Object.freeze([
    { role: 'system', content: 'Preset instructions' },
    { role: 'user', content: 'Example dialogue outside history' },
    { role: 'user', content: 'Old user turn', __isChatHistory: true, sourceMessageId: 'u', sourceIndexInChat: 0 },
    { role: 'system', content: 'World info inside history', __isWorldInfoEntry: true },
    { role: 'assistant', content: [{ type: 'text', text: 'Last reply' }], __isChatHistory: true, sourceMessageId: 'a', sourceIndexInChat: 1 },
    { role: 'user', content: 'Post-history instructions using user role' },
    { role: 'assistant', content: 'Prefill', partial: true },
  ].map(Object.freeze))
  const output = inject(old, { input: 'rain', settings: { ...DEFAULT_SETTINGS, role: 'user', template: 'Guide: {{input}}' } })
  assert.deepEqual(output.messages, [...old.slice(0, 5), { role: 'user', content: 'Guide: rain' }, ...old.slice(5)])
  assert.deepEqual(output.breakdown, [{ messageIndex: 5, name: 'Scene Direction' }])
  assert.equal(output.messages[4], old[4])
  assert.equal(output.messages[6], old[5])
  assert.equal(output.messages[5].__isChatHistory, undefined)
})

test('appends after a final user turn and always uses user even with a stale system setting', () => {
  const messages = [{ role: 'user', content: 'Latest turn', __isChatHistory: true }]
  for (const role of ['user', 'system']) {
    const result = inject(messages, { input: 'Direction', settings: { ...DEFAULT_SETTINGS, role } })
    assert.equal(result.messages[1].role, 'user')
    assert.equal(result.messages[0], messages[0])
    assert.equal(result.breakdown[0].messageIndex, 1)
  }
})

test('rejects an ambiguous missing history boundary instead of using example or preset message roles', () => {
  const guide = { input: 'rain', settings: DEFAULT_SETTINGS }
  assert.throws(() => inject([{ role: 'system', content: 'Preset' }, { role: 'user', content: 'Example' }], guide), /could not locate chat history/)
  const empty = inject([], guide)
  assert.equal(empty.messages[0].role, 'user')
  assert.equal(empty.breakdown[0].messageIndex, 0)
})

test('legacy settings migrate to user without losing template or draft preference', () => {
  assert.equal(DEFAULT_SETTINGS.role, 'user')
  assert.equal(normalizeSettings(undefined).role, 'user')
  assert.deepEqual(normalizeSettings({ template: 'Custom {{input}}', role: 'system', clearInput: false }), {
    version: 2, template: 'Custom {{input}}', role: 'user', clearInput: false,
  })
  assert.equal(normalizeSettings({ ...DEFAULT_SETTINGS, role: 'system' }).role, 'user')
})
