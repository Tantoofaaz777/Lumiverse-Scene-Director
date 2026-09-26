import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transformSync } from 'esbuild'

const source = readFileSync(new URL('../src/native-save.ts', import.meta.url), 'utf8')
const { code } = transformSync(source, { loader: 'ts', format: 'esm' })
const { observeNativeSave } = await import(`data:text/javascript,${encodeURIComponent(code)}`)
const request = { method: 'POST', body: JSON.stringify({ is_user: true, content: 'Draft', name: 'Persona', extra: { attachments: ['image'] } }) }

test('transport observation passes unrelated calls and original request/response through unchanged', async t => {
  const previousWindow = globalThis.window
  t.after(() => { globalThis.window = previousWindow })
  const requests = []
  const saved = new Response(JSON.stringify({ id: 'm1', chat_id: 'A', is_user: true, content: 'Draft' }))
  const nativePromise = Promise.resolve(saved)
  const nativeFetch = (...args) => { requests.push(args); return nativePromise }
  globalThis.window = { fetch: nativeFetch, location: { href: 'https://host/chat' } }
  const controller = new AbortController()
  const done = observeNativeSave('A', 'Draft', controller.signal, () => {})
  const wrapper = window.fetch
  assert.equal(window.fetch('/api/v1/chats/B/messages', request), nativePromise)
  assert.equal(window.fetch, wrapper)
  const unrelated = { ...request, body: JSON.stringify({ is_user: true, content: 'Different' }) }
  window.fetch('/api/v1/chats/A/messages', unrelated)
  assert.equal(window.fetch, wrapper)
  assert.equal(window.fetch('/api/v1/chats/A/messages', request), nativePromise)
  assert.equal(window.fetch, nativeFetch)
  await done
  assert.equal(requests[2][1], request)
  assert.equal(saved.bodyUsed, false)
  assert.equal((await saved.json()).id, 'm1')
})

test('an unexpected HTTP message identity never confirms a Simple Send', async t => {
  const previousWindow = globalThis.window
  t.after(() => { globalThis.window = previousWindow })
  const nativeFetch = async () => new Response(JSON.stringify({ id: 'm2', chat_id: 'A', is_user: true, content: 'Different' }))
  globalThis.window = { fetch: nativeFetch, location: { href: 'https://host/chat' } }
  const done = observeNativeSave('A', 'Draft', new AbortController().signal, () => {
    void window.fetch('/api/v1/chats/A/messages', request)
  })
  await assert.rejects(done, /Unexpected save response/)
  assert.equal(window.fetch, nativeFetch)
})

test('teardown preserves a newer transport wrapper and leaves captured requests running', async t => {
  const previousWindow = globalThis.window
  t.after(() => { globalThis.window = previousWindow })
  let resolve
  const nativePromise = new Promise(r => { resolve = r })
  const nativeFetch = () => nativePromise
  globalThis.window = { fetch: nativeFetch, location: { href: 'https://host/chat' } }
  const controller = new AbortController()
  const done = observeNativeSave('A', 'Draft', controller.signal, () => {})
  const observer = window.fetch
  const laterWrapper = (...args) => observer(...args)
  window.fetch = laterWrapper
  assert.equal(window.fetch('/api/v1/chats/A/messages', request), nativePromise)
  controller.abort()
  await done
  assert.equal(window.fetch, laterWrapper)
  resolve(new Response(JSON.stringify({ id: 'm1', chat_id: 'A', is_user: true, content: 'Draft' })))
  assert.equal((await (await nativePromise).json()).content, 'Draft')
})
