import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'

import {
  artifactFingerprint,
  costOf,
  HASH_FULL_LIMIT,
  createScanner,
  createSessionReader,
  createSessionState,
  decodeWorkspaceName,
  foldEvent,
  isPeakTime,
  loadPricing,
  nextSwitchAt,
  normalizePricing,
  priceFor,
  restoreSessionState,
  scanZstdFrames,
  serializeSessionState,
} from '../index.js'

/** One independently decodable frame carrying the given JSONL records. */
function frame(records) {
  const body = records.map((record) => `${JSON.stringify(record)}\n`).join('')
  return zstdCompressSync(Buffer.from(body, 'utf8'))
}

/** Session header record. */
function sessionRecord(overrides = {}) {
  return {
    type: 'session',
    version: 4,
    id: 'session-test-0001',
    createdAt: 1793600000000,
    cwd: 'D:\\Work\\demo',
    agentPreset: 'standard',
    ...overrides,
  }
}

/** One assistant settlement with optional durable usage. */
function assistantMessage(turn, step, usage, extra = {}) {
  return {
    type: 'assistant/message',
    time: 1793600005000,
    data: {
      turn,
      step,
      message: { role: 'assistant', source: { provider: 'demo-provider', model: 'demo-model' } },
      ...(usage === undefined ? {} : { usage }),
      ...extra,
    },
  }
}

/** A streaming attempt whose last usage chunk carries the same numbers. */
function assistantAttempt(turn, step, usage) {
  return {
    type: 'assistant/attempt',
    time: 1793600004000,
    data: {
      turn,
      step,
      stream: [
        { type: 'chunk', chunk: { type: 'text-delta', text: 'hi' } },
        { type: 'chunk', chunk: { type: 'usage', usage } },
      ],
    },
  }
}

/** Build a temporary `<home>/sessions/<workspace>/<session>/session.v4.jsonl.zstd`. */
function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-token-usage-'))
  const sessionsRoot = join(root, 'sessions')
  const workspaceDir = join(sessionsRoot, '--D-Work-demo--')
  const sessionDir = join(workspaceDir, 'session-test-0001')
  mkdirSync(sessionDir, { recursive: true })
  const file = join(sessionDir, 'session.v4.jsonl.zstd')
  return { root, sessionsRoot, sessionDir, file }
}

test('scanZstdFrames walks complete frames and reports a torn tail', () => {
  const first = frame([{ type: 'session' }])
  const second = frame([{ type: 'session/title' }])
  const joined = Buffer.concat([first, second])
  const complete = scanZstdFrames(joined)
  assert.equal(complete.frames.length, 2)
  assert.equal(complete.tornStart, undefined)
  assert.equal(complete.frames[0].end, first.length)

  const torn = scanZstdFrames(Buffer.concat([first, second.subarray(0, second.length - 2)]))
  assert.equal(torn.frames.length, 1)
  assert.equal(torn.tornStart, first.length)
})

test('scanZstdFrames rejects a corrupted frame header', () => {
  const corrupt = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05])
  assert.throws(() => scanZstdFrames(corrupt), /invalid Zstandard frame magic/)
})

test('foldEvent replaces a streaming sample with the final settlement', () => {
  const state = createSessionState()
  foldEvent(state, sessionRecord())
  foldEvent(state, { type: 'turn/start', data: { turn: 1 } })
  foldEvent(state, assistantAttempt(1, 1, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 0 }))
  assert.equal(state.totals.input, 100)
  assert.equal(state.totals.cacheRead, 900)

  foldEvent(state, assistantMessage(1, 1, { inputTokens: 120, outputTokens: 12, cacheReadTokens: 900, cacheWriteTokens: 0 }))
  assert.equal(state.totals.input, 120)
  assert.equal(state.totals.output, 12)
  assert.equal(state.totals.cacheRead, 900)

  const day = state.days.get('2026-11-02')
  assert.ok(day !== undefined, 'one local day bucket exists')
  assert.equal(day.input, 120)
})

test('foldEvent bills a retried attempt separately', () => {
  const state = createSessionState()
  foldEvent(state, sessionRecord())
  foldEvent(state, assistantMessage(1, 1, { inputTokens: 50, outputTokens: 5 }))
  foldEvent(state, { type: 'llm/retry-started', data: { turn: 1, step: 1 } })
  foldEvent(state, assistantMessage(1, 1, { inputTokens: 30, outputTokens: 3 }))
  assert.equal(state.totals.input, 80)
  assert.equal(state.totals.output, 8)
})

test('foldEvent tracks title, model, turns, and steps', () => {
  const state = createSessionState()
  foldEvent(state, sessionRecord())
  foldEvent(state, { type: 'session/title', data: { title: 'Demo session' } })
  foldEvent(state, { type: 'turn/start', data: { turn: 1 } })
  foldEvent(state, { type: 'step/start', data: { turn: 1, step: 1 } })
  foldEvent(state, {
    type: 'request/header',
    data: { header: { config: { provider: 'demo-provider', model: 'demo-model' } } },
  })
  assert.equal(state.title, 'Demo session')
  assert.equal(state.model, 'demo-model')
  assert.equal(state.provider, 'demo-provider')
  assert.equal(state.turns, 1)
  assert.equal(state.steps, 1)
})

test('createSessionReader folds appended frames incrementally', async () => {
  const { file } = makeWorkspace()
  writeFileSync(file, frame([sessionRecord(), { type: 'turn/start', data: { turn: 1 } }]))

  const reader = createSessionReader(file)
  await reader.poll()
  assert.equal(reader.state.turns, 1)
  assert.equal(reader.state.totals.input, 0)
  const firstOffset = reader.offset

  writeFileSync(file, Buffer.concat([
    readFileSync(file),
    frame([assistantMessage(1, 1, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 200, cacheWriteTokens: 0 })]),
  ]))
  await reader.poll()
  assert.equal(reader.offset > firstOffset, true)
  assert.equal(reader.state.totals.input, 100)
  assert.equal(reader.state.totals.cacheRead, 200)

  writeFileSync(file, Buffer.concat([
    readFileSync(file),
    frame([assistantMessage(1, 1, { inputTokens: 140, outputTokens: 14, cacheReadTokens: 200, cacheWriteTokens: 0 })]),
  ]))
  await reader.poll()
  assert.equal(reader.state.totals.input, 140, 'the final settlement replaces the earlier sample')
  assert.equal(reader.state.totals.output, 14)
})

test('createSessionReader waits for a torn frame instead of dropping it', async () => {
  const { file } = makeWorkspace()
  const header = frame([sessionRecord()])
  const tail = frame([assistantMessage(1, 1, { inputTokens: 7, outputTokens: 3 })])
  writeFileSync(file, Buffer.concat([header, tail.subarray(0, Math.floor(tail.length / 2))]))

  const reader = createSessionReader(file)
  await reader.poll()
  assert.equal(reader.state.totals.input, 0)
  assert.equal(reader.error, null)

  writeFileSync(file, Buffer.concat([readFileSync(file), tail.subarray(Math.floor(tail.length / 2))]))
  await reader.poll()
  assert.equal(reader.state.totals.input, 7)
  assert.equal(reader.state.totals.output, 3)
})

test('createSessionReader resets when an artifact shrinks', async () => {
  const { file } = makeWorkspace()
  writeFileSync(file, frame([sessionRecord(), assistantMessage(1, 1, { inputTokens: 40, outputTokens: 4 })]))
  const reader = createSessionReader(file)
  await reader.poll()
  assert.equal(reader.state.totals.input, 40)

  writeFileSync(file, frame([sessionRecord(), assistantMessage(1, 1, { inputTokens: 5, outputTokens: 1 })]))
  await reader.poll()
  assert.equal(reader.state.totals.input, 5)
})

test('createScanner aggregates sessions, days, and totals', async () => {
  const { sessionsRoot, file } = makeWorkspace()
  writeFileSync(file, frame([
    sessionRecord(),
    { type: 'session/title', data: { title: 'First day' } },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    assistantMessage(1, 1, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 300, cacheWriteTokens: 0 }),
  ]))
  const otherDir = join(sessionsRoot, '--D-Work-demo--', 'session-test-0002')
  mkdirSync(otherDir, { recursive: true })
  writeFileSync(join(otherDir, 'session.v4.jsonl.zstd'), frame([
    sessionRecord({ id: 'session-test-0002', cwd: 'D:\\Work\\other' }),
    assistantMessage(2, 1, { inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 25 }),
  ]))

  const scanner = createScanner(sessionsRoot)
  await scanner.refresh(true)
  const payload = scanner.snapshot()
  assert.equal(payload.ok, true)
  assert.equal(payload.sessions.length, 2)
  assert.equal(payload.totals.sessions, 2)
  assert.equal(payload.totals.input, 150)
  assert.equal(payload.totals.output, 15)
  assert.equal(payload.totals.cacheRead, 300)
  assert.equal(payload.totals.cacheWrite, 25)
  assert.equal(payload.totals.total, 490)
  assert.equal(payload.days.length, 1)
  assert.equal(payload.days[0].total, 490)

  const first = payload.sessions.find((session) => session.sessionId === 'session-test-0001')
  assert.equal(first.title, 'First day')
  assert.equal(first.workspace.name, 'demo')
  assert.equal(first.workspace.path, 'D:\\Work\\demo')
  assert.equal(first.model, 'demo-model')
  assert.equal(first.turns, 1)
  assert.equal(first.steps, 1)
  assert.equal(first.cacheHitRate, 0.75)

  // A second pass without appends is cheap and must not duplicate totals.
  await scanner.refresh(true)
  assert.equal(scanner.snapshot().totals.total, 490)
})

test('createScanner tolerates a missing sessions root', async () => {
  const scanner = createScanner(join(tmpdir(), 'dsh-token-usage-does-not-exist', 'sessions'))
  await scanner.refresh(true)
  const payload = scanner.snapshot()
  assert.equal(payload.sessions.length, 0)
  assert.equal(payload.totals.total, 0)
  assert.equal(payload.error, null)
})

test('decodeWorkspaceName restores escaped characters', () => {
  assert.equal(decodeWorkspaceName('--D-Deepseek~0020work-workplace--'), 'D-Deepseek work-workplace')
  assert.equal(decodeWorkspaceName('--D-~5DE5~4F5C~533A--'), 'D-工作区')
})

test('priceFor selects Pro for Pro names and Flash otherwise', () => {
  const flash = priceFor('opencode-go/deepseek-v4.1-flash')
  assert.equal(flash.cacheHit, 0.02)
  assert.equal(flash.cacheMiss, 1)
  assert.equal(flash.output, 4)

  const pro = priceFor('deepseek-v4-pro')
  assert.equal(pro.cacheHit, 0.15)
  assert.equal(pro.cacheMiss, 4.5)
  assert.equal(pro.output, 13.5)

  assert.equal(priceFor(undefined).output, 4)
})

test('isPeakTime applies Beijing weekday windows and holidays', () => {
  // 2026-11-13 is a Friday; 2026-11-14 a Saturday.
  assert.equal(isPeakTime(Date.parse('2026-11-13T02:00:00Z')), true, 'Friday 10:00 Beijing')
  assert.equal(isPeakTime(Date.parse('2026-11-13T04:30:00Z')), false, 'Friday 12:30 Beijing')
  assert.equal(isPeakTime(Date.parse('2026-11-13T06:30:00Z')), true, 'Friday 14:30 Beijing')
  assert.equal(isPeakTime(Date.parse('2026-11-13T10:30:00Z')), false, 'Friday 18:30 Beijing')
  assert.equal(isPeakTime(Date.parse('2026-11-14T02:00:00Z')), false, 'Saturday 10:00 Beijing')
  assert.equal(isPeakTime(Date.parse('2026-10-01T02:00:00Z')), false, 'National Day 10:00 Beijing')
})

test('costOf prices cache traffic, misses, and output at the peak multiplier', () => {
  const price = priceFor('deepseek-flash')
  const sample = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 }
  assert.equal(costOf(sample, price, false), 1 + 4 + 0.02)
  assert.equal(costOf(sample, price, true), 2 + 8 + 0.04)
  assert.equal(costOf({ input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 }, price, false), 1)
})

test('normalizePricing merges overrides and prefers the longest model match', () => {
  const pricing = normalizePricing({
    currency: 'USD',
    symbol: '$',
    peakMultiplier: 1.5,
    fallback: { cacheHit: 0.1, cacheMiss: 2, output: 6 },
    models: [
      { match: 'mini', cacheHit: 0.5, cacheMiss: 3, output: 9 },
      { match: 'minimax-m3.1', cacheHit: 0.7, cacheMiss: 4, output: 12 },
    ],
    holidays: ['2026-12-25'],
  })
  assert.equal(pricing.currency, 'USD')
  assert.equal(pricing.symbol, '$')
  assert.equal(pricing.source, 'override')
  assert.equal(priceFor('opencode-go/minimax-m3.1-flash', pricing).cacheHit, 0.7)
  assert.equal(priceFor('some-mini-model', pricing).cacheHit, 0.5)
  assert.equal(priceFor('deepseek-v4-pro', pricing).output, 13.5, 'built-in Pro survives an override')
  assert.deepEqual(pricing.holidays, ['2026-12-25'])
})

test('loadPricing falls back to the built-in table when the file is absent', () => {
  const pricing = loadPricing(join(tmpdir(), 'dsh-token-usage-missing-prices.json'))
  assert.equal(pricing.source, 'builtin')
  assert.equal(pricing.currency, 'CNY')
})

test('foldEvent accumulates an estimated cost per session and day', () => {
  const state = createSessionState()
  foldEvent(state, sessionRecord())
  // 2026-11-03T18:00Z = 2026-11-04 02:00 Beijing: off-peak, Flash rates.
  const time = Date.parse('2026-11-03T18:00:00Z')
  foldEvent(state, {
    type: 'assistant/message',
    time,
    data: {
      turn: 1,
      step: 1,
      message: { role: 'assistant', source: { provider: 'demo', model: 'deepseek-flash' } },
      usage: { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 },
    },
  })
  // 1M input × 1 + 1M cache read × 0.02 + 0.1M output × 4 = 1.42 CNY.
  assert.equal(Math.round(state.totals.cost * 1e6) / 1e6, 1.42)
  const day = state.days.get('2026-11-04')
  assert.equal(Math.round(day.cost * 1e6) / 1e6, 1.42)
})

test('foldEvent replaces the cost of a superseded sample', () => {
  const state = createSessionState()
  foldEvent(state, sessionRecord())
  const time = Date.parse('2026-11-03T18:00:00Z')
  const message = (usage) => ({
    type: 'assistant/message',
    time,
    data: { turn: 1, step: 1, message: { role: 'assistant', source: { model: 'deepseek-flash' } }, usage },
  })
  foldEvent(state, message({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 }))
  assert.equal(state.totals.cost, 1)
  foldEvent(state, message({ inputTokens: 2_000_000, outputTokens: 0, cacheReadTokens: 0 }))
  assert.equal(state.totals.cost, 2)
  assert.equal(state.days.get('2026-11-04').cost, 2)
})

test('createScanner reports cost in the payload', async () => {
  const { sessionsRoot, file } = makeWorkspace()
  writeFileSync(file, frame([
    sessionRecord(),
    { type: 'assistant/message', time: Date.parse('2026-11-03T18:00:00Z'), data: {
      turn: 1,
      step: 1,
      message: { role: 'assistant', source: { provider: 'demo', model: 'deepseek-flash' } },
      usage: { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 },
    } },
  ]))
  const scanner = createScanner(sessionsRoot)
  await scanner.refresh(true)
  const payload = scanner.snapshot()
  assert.equal(payload.totals.cost, 1.42)
  assert.equal(payload.pricing.currency, 'CNY')
  assert.equal(payload.pricing.symbol, '¥')
  assert.equal(payload.sessions[0].cost, 1.42)
  assert.equal(payload.days[0].cost, 1.42)
  assert.equal(payload.totals.todayCost, 0, 'the sample is not from today')
})

test('serializeSessionState round-trips through restoreSessionState', () => {
  const state = createSessionState()
  foldEvent(state, sessionRecord())
  foldEvent(state, { type: 'session/title', data: { title: 'Round trip' } })
  foldEvent(state, assistantMessage(1, 1, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900 }))
  const restored = restoreSessionState(JSON.parse(JSON.stringify(serializeSessionState(state))))
  assert.equal(restored.title, 'Round trip')
  assert.deepEqual(restored.totals, state.totals)
  assert.deepEqual([...restored.days.entries()], [...state.days.entries()])
  assert.deepEqual(restored.last, state.last)
  assert.equal(restored.turns, state.turns)
  assert.equal(restoreSessionState({ totals: null }), undefined)
})

test('createScanner reuses a warm cache and sees appends after invalidation', async () => {
  const { root, sessionsRoot, file } = makeWorkspace()
  const cacheFile = join(root, 'cache.json')
  writeFileSync(file, frame([sessionRecord(), assistantMessage(1, 1, { inputTokens: 10, outputTokens: 2 })]))
  const cold = createScanner(sessionsRoot, undefined, { cacheFile })
  await cold.refresh(true)
  const coldTotal = cold.snapshot().totals.total
  await cold.flush()

  const warm = createScanner(sessionsRoot, undefined, { cacheFile })
  await warm.refresh(true)
  assert.equal(warm.snapshot().totals.total, coldTotal)

  writeFileSync(file, Buffer.concat([
    readFileSync(file),
    frame([assistantMessage(1, 2, { inputTokens: 5, outputTokens: 1 })]),
  ]))
  const after = createScanner(sessionsRoot, undefined, { cacheFile })
  await after.refresh(true)
  assert.equal(after.snapshot().totals.input, 15)
})

test('createScanner ignores a corrupt cache file', async () => {
  const { root, sessionsRoot, file } = makeWorkspace()
  const cacheFile = join(root, 'cache.json')
  writeFileSync(cacheFile, '{not json')
  writeFileSync(file, frame([sessionRecord(), assistantMessage(1, 1, { inputTokens: 3, outputTokens: 1 })]))
  const scanner = createScanner(sessionsRoot, undefined, { cacheFile })
  await scanner.refresh(true)
  assert.equal(scanner.snapshot().totals.input, 3)
  assert.equal(scanner.snapshot().totals.output, 1)
})

test('foldEvent splits spend into peak and valley windows', () => {
  const state = createSessionState()
  foldEvent(state, sessionRecord())
  const message = (turn, time) => ({
    type: 'assistant/message',
    time,
    data: {
      turn,
      step: 1,
      message: { role: 'assistant', source: { provider: 'demo', model: 'deepseek-flash' } },
      usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
  })
  // Friday 10:00 Beijing is peak (miss rate 2); Saturday 10:00 is off-peak (1).
  foldEvent(state, message(1, Date.parse('2026-11-13T02:00:00Z')))
  foldEvent(state, message(2, Date.parse('2026-11-14T02:00:00Z')))
  assert.equal(Math.round(state.totals.costPeak * 1e6) / 1e6, 2)
  assert.equal(Math.round(state.totals.costValley * 1e6) / 1e6, 1)
  assert.equal(Math.round(state.totals.cost * 1e6) / 1e6, 3)
  assert.equal(Math.round(state.days.get('2026-11-13').costPeak * 1e6) / 1e6, 2)
  assert.equal(Math.round(state.days.get('2026-11-14').costValley * 1e6) / 1e6, 1)
})

test('client palette ships paired light and dark data colors', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const names = ['blue', 'green', 'amber', 'red', 'purple', 'cyan', 'pink', 'gray']
  const paletteOf = (selector) => {
    const start = source.indexOf(`${selector}{--dshc-`)
    assert.notEqual(start, -1, `${selector} palette is present`)
    const block = source.slice(start, source.indexOf('}', start))
    const colors = {}
    for (const match of block.matchAll(/--dshc-([a-z]+):(#[0-9A-Fa-f]{6})/g)) colors[match[1]] = match[2].toUpperCase()
    return colors
  }
  const light = paletteOf(':root')
  const dark = paletteOf('body[data-ds-dark-theme]')
  assert.deepEqual(Object.keys(light).sort(), [...names].sort())
  assert.deepEqual(Object.keys(dark).sort(), [...names].sort())
  assert.equal(new Set(Object.values(light)).size, names.length, 'light colors are pairwise distinct')
  assert.equal(new Set(Object.values(dark)).size, names.length, 'dark colors are pairwise distinct')
  for (const name of names) assert.notEqual(light[name], dark[name], `${name} differs between themes`)

  const stripped = source.replace(/--dshc-[a-z]+:#[0-9A-Fa-f]{6}/g, '')
  assert.equal(/(?:^|[^&\w])#[0-9A-Fa-f]{3,8}\b/.test(stripped), false, 'no hex color outside the palette')
})

test('client paints data colors through CSS variables, never hex', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /--dshc-blue/)
  assert.equal(/#4C8DFF|#D29922|#0969DA|#9A6700/.test(source.replace(/--dshc-[a-z]+:#[0-9A-Fa-f]{6}/g, '')), false)
})

test('client registers the self-test section on the plugin detail slot', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /const SELFTEST_ID = 'dsh-token-usage\.selftest'/)
  assert.match(source, /name: 'plugins\.detail\.section'/)
  assert.match(source, /order: 90/)
  for (const key of ['selftest.title', 'selftest.run', 'selftest.check.route', 'selftest.check.etag', 'selftest.check.chart', 'selftest.check.pricing']) {
    assert.equal(source.includes(`'${key}'`), true, `${key} must exist`)
  }
})

test('bar columns can shrink so long windows never clip a day', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /\.tu-bar-col\{[^}]*min-width:0/)
  assert.match(source, /\.tu-bar-track\{[^}]*max-width:72px/)
})

test('client no longer carries the removed standalone-window symbols', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  for (const symbol of ['dsh-surface', 'open-mode', 'window.open', 'openUsageWindow', 'panelInfo']) {
    assert.equal(source.includes(symbol), false, `${symbol} must be gone`)
  }
})

test('nextSwitchAt finds the next Beijing pricing boundary', () => {
  // Friday 10:30 Beijing: peak ends at 12:00.
  const peakEnd = Date.parse('2026-11-13T02:30:00Z')
  assert.equal(nextSwitchAt(peakEnd), Date.parse('2026-11-13T04:00:00Z'))
  // Friday 18:30 Beijing: the next peak starts Monday 09:00.
  const weekendEve = Date.parse('2026-11-13T10:30:00Z')
  assert.equal(nextSwitchAt(weekendEve), Date.parse('2026-11-16T01:00:00Z'))
})

test('scanner reports the current pricing window', async () => {
  const { sessionsRoot, file } = makeWorkspace()
  writeFileSync(file, frame([sessionRecord(), assistantMessage(1, 1, { inputTokens: 10, outputTokens: 2 })]))
  const scanner = createScanner(sessionsRoot)
  await scanner.refresh(true)
  const payload = scanner.snapshot()
  assert.equal(typeof payload.pricing.peakNow, 'boolean')
  assert.equal(payload.totals.costPeak + payload.totals.costValley, payload.totals.cost)
})

test('scanner etag stays stable until an artifact changes', async () => {
  const { sessionsRoot, file } = makeWorkspace()
  writeFileSync(file, frame([sessionRecord(), assistantMessage(1, 1, { inputTokens: 10, outputTokens: 2 })]))
  const scanner = createScanner(sessionsRoot)
  await scanner.refresh(true)
  const first = scanner.etag()
  assert.match(first, /^W\/"/)
  await scanner.refresh(true)
  assert.equal(scanner.etag(), first, 'an unchanged scan keeps the validator')

  writeFileSync(file, Buffer.concat([
    readFileSync(file),
    frame([assistantMessage(1, 2, { inputTokens: 5, outputTokens: 1 })]),
  ]))
  await scanner.refresh(true)
  assert.notEqual(scanner.etag(), first, 'appended bytes change the validator')
})

test('etag moves when a log is rewritten to the same size and mtime', async () => {
  const { sessionsRoot, file } = makeWorkspace()
  const first = frame([sessionRecord(), assistantMessage(1, 1, { inputTokens: 10, outputTokens: 2 })])
  const second = frame([sessionRecord({ id: 'session-test-0002' }), assistantMessage(1, 1, { inputTokens: 99, outputTokens: 7 })])
  const length = Math.max(first.length, second.length)
  const before = Buffer.alloc(length)
  const after = Buffer.alloc(length)
  first.copy(before)
  second.copy(after)
  writeFileSync(file, before)
  const when = statSync(file).mtime
  const scanner = createScanner(sessionsRoot)
  await scanner.refresh(true)
  const etagBefore = scanner.etag()
  const totalBefore = scanner.snapshot().totals.total

  writeFileSync(file, after)
  utimesSync(file, when, when)
  assert.equal(statSync(file).size, length, 'the rewrite keeps the byte length')
  await scanner.refresh(true)
  assert.notEqual(scanner.etag(), etagBefore, 'content, not size+mtime, decides the validator')
  assert.notEqual(scanner.snapshot().totals.total, totalBefore, 'the fold re-reads the rewritten log')
})

test('large artifacts sample the first and last 4 KiB', () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-usage-big-'))
  try {
    const file = join(dir, 'big.bin')
    const size = HASH_FULL_LIMIT + 1024
    writeFileSync(file, randomBytes(size))
    const first = artifactFingerprint(file)
    assert.match(first.hash, /^[0-9a-f]{40}$/)
    assert.equal(first.size, size)

    // A middle-only edit is outside the sampled window by design.
    const handle = openSync(file, 'r+')
    try {
      writeSync(handle, Buffer.from([0x01, 0x02, 0x03]), 0, 3, Math.floor(size / 2))
    } finally {
      closeSync(handle)
    }
    assert.equal(artifactFingerprint(file).hash, first.hash, 'the middle is not sampled')

    // The tail is sampled, so a last-byte edit must move the digest.
    const bytes = readFileSync(file)
    bytes[bytes.length - 1] ^= 0xff
    writeFileSync(file, bytes)
    assert.notEqual(artifactFingerprint(file).hash, first.hash, 'the tail is sampled')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
