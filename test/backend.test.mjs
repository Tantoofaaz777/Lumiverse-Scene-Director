import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS } from '../dist/core.js'
import { backendHarness, arm, tick } from './backend-harness.mjs'

test('late storage completion cannot resurrect a cancelled arm or remove its replacement', async () => {
  const h = backendHarness()
  let release
  h.api.userStorage.getJson = () => new Promise(resolve => { release = resolve })
  const first = h.receive(arm)
  await tick()
  await h.receive({ type: 'guide:cancel', chatId: 'A', token: 't' })
  h.api.userStorage.getJson = async () => DEFAULT_SETTINGS
  await h.receive({ ...arm, token: 'new', input: 'New instruction' })
  release(DEFAULT_SETTINGS)
  await first
  h.event('GENERATION_STARTED')
  const result = await h.intercept()
  assert.equal(result.messages[0].content.includes('New instruction'), true)
  assert.equal(h.replies.filter(r => r.payload.type === 'guide:armed').length, 1)
  h.event('GENERATION_ENDED')
  assert.equal(h.timers.size, 0)
})

test('slow assembly retains the guide, isolates previews and sessions, and injects once', async () => {
  const h = backendHarness()
  await h.receive(arm)
  h.event('GENERATION_STARTED', {}, 'another-user')
  h.event('GENERATION_STARTED', { frontendSessionId: 'other-document' })
  assert.equal(h.replies.some(r => r.payload.type === 'guide:started'), false)
  h.event('GENERATION_STARTED')
  h.advance(120000)
  for (const ctx of [{ dryRun: true }, { frontendSessionId: 'other' }, { userId: 'other' }, { chatId: 'B' }, { generationType: 'regenerate' }]) {
    assert.equal((await h.intercept(ctx)).breakdown, undefined)
  }
  const result = await h.intercept()
  assert.equal(result.messages[0].content, DEFAULT_SETTINGS.template.replace('{{input}}', () => arm.input))
  assert.equal(result.breakdown[0].name, 'Scene Direction')
  assert.equal((await h.intercept()).breakdown, undefined)
  h.event('GENERATION_ENDED', { generationId: 'unrelated' })
  assert.equal(h.replies.at(-1).payload.type, 'guide:consumed')
  h.event('GENERATION_ENDED')
  assert.equal(h.replies.at(-1).payload.type, 'guide:finished')
  assert.equal(h.replies.at(-1).userId, 'u')
  assert.equal(h.replies.at(-1).options.frontendSessionId, 's')
})

test('unaccepted native clicks expire with an explicit failure and no leftover guide', async () => {
  const h = backendHarness()
  await h.receive(arm)
  h.advance(15001)
  assert.equal(h.replies.at(-1).payload.type, 'guide:failed')
  assert.match(h.replies.at(-1).payload.message, /did not start/)
  assert.equal((await h.intercept()).breakdown, undefined)
  assert.equal(h.timers.size, 0)
})

test('stop and assembly error release the reservation, including before injection', async () => {
  for (const type of ['GENERATION_STOPPED', 'GENERATION_ENDED']) {
    const h = backendHarness()
    await h.receive(arm)
    h.event('GENERATION_STARTED')
    h.event(type, { errorMessage: 'Assembly failed' })
    assert.equal(h.replies.at(-1).payload.type, 'guide:failed')
    assert.equal((await h.intercept()).breakdown, undefined)
    await h.receive({ ...arm, token: 'retry' })
    assert.equal(h.replies.at(-1).payload.type, 'guide:armed')
  }
})

test('missing permissions fail before arming; missing start event fails closed', async () => {
  const h = backendHarness()
  h.api.permissions.getGranted = async () => ['interceptor']
  await h.receive(arm)
  assert.match(h.replies.at(-1).payload.message, /permissions/)
  assert.equal(h.timers.size, 0)
  h.api.permissions.getGranted = async () => ['interceptor', 'generation']
  await h.receive(arm)
  await assert.rejects(h.intercept(), /did not observe/)
})

test('cancel from a different document cannot disarm a guide; started guides survive teardown cancellation', async () => {
  const h = backendHarness()
  await h.receive(arm)
  await h.receive({ type: 'guide:cancel', chatId: 'A', token: 't' }, 'u', 'other')
  h.event('GENERATION_STARTED')
  await h.receive({ type: 'guide:cancel', chatId: 'A', token: 't' })
  assert.ok((await h.intercept()).breakdown)
})

test('overlapping guides for different users keep lifecycle subscriptions and terminal cleanup', async () => {
  const h = backendHarness()
  await h.receive(arm)
  h.event('GENERATION_STARTED')
  await h.receive({ ...arm, token: 'other' }, 'other-user', 'other-session')
  h.event('GENERATION_STARTED', { frontendSessionId: 'other-session', generationId: 'other-generation' }, 'other-user')
  assert.ok((await h.intercept()).breakdown)
  h.event('GENERATION_ENDED')
  assert.ok((await h.intercept({ userId: 'other-user', frontendSessionId: 'other-session' })).breakdown)
  h.event('GENERATION_ENDED', { generationId: 'other-generation' }, 'other-user')
  assert.equal(h.replies.filter(r => r.payload.type === 'guide:finished').length, 2)
})

test('real backend path migrates legacy role and inserts after history, before trailing preset blocks', async () => {
  const h = backendHarness()
  h.api.userStorage.getJson = async () => ({ template: '[Guide: {{input}}]', role: 'system', clearInput: true })
  await h.receive(arm)
  h.event('GENERATION_STARTED')
  const messages = [
    { role: 'system', content: 'Preset' },
    { role: 'assistant', content: 'Last chat turn', __isChatHistory: true },
    { role: 'system', content: 'After history' },
  ]
  const result = await h.intercept({}, messages)
  assert.equal(result.messages[0], messages[0])
  assert.equal(result.messages[1], messages[1])
  assert.equal(result.messages[2].role, 'user')
  assert.equal(result.messages[2].content, '[Guide: A literal $& direction]')
  assert.equal(result.messages[3], messages[2])
  assert.equal(result.breakdown[0].messageIndex, 2)
})
