/**
 * dsh-token-usage — Host half.
 *
 * Aggregates the provider-reported token usage of every durable Session in the
 * DSH home, live and historical, and serves it to the browser half through one
 * same-origin JSON route.
 *
 * Sessions are read straight from their `.jsonl.zstd` artifacts: the container
 * is a concatenation of independently decodable Zstandard frames, so an
 * append-only reader can decode only the frames written since the previous
 * poll and fold their events. Usage is folded exactly like the shipped
 * `tokenUsage` projection — a final Assistant settlement replaces the streaming
 * sample of the same attempt, and `llm/retry-started` closes that replacement
 * scope, so a retried attempt is billed twice.
 *
 * The module adds no model-visible surface: no tool, no prompt, no schema.
 *
 * @module dsh-token-usage
 */
import { readFileSync } from 'node:fs'
import { mkdir, open, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** Cordis plugin name. */
export const name = 'dsh-token-usage'

/** Required Host services; the browser route additionally waits for `webServer`. */
export const inject = []

/** Same-origin route the browser half talks to. */
const ROUTE = '/token-usage'

/** Little-endian value of the Zstandard frame magic `28 B5 2F FD`. */
const ZSTD_MAGIC = 0xfd2fb528

/** Longest single JSONL line accepted before the reader assumes corruption. */
const MAX_LINE_BYTES = 4 * 1024 * 1024

/** How long a served snapshot may lag behind the files before it is refreshed. */
const STALE_AFTER_MS = 700

/** A Session is reported live while its artifact changed within this window. */
const LIVE_WINDOW_MS = 2 * 60 * 1000

/** Days kept per Session for the history strip. */
const MAX_DAYS_PER_SESSION = 370

/** Sessions returned in one payload. */
const MAX_SESSIONS = 2000

/** File names a Session artifact may use, newest format first. */
const SESSION_FILES = ['session.v4.jsonl.zstd', 'session.jsonl.zstd', 'session.v4.jsonl', 'session.jsonl']

/** Cache file in the DSH home that makes a restart skip already-decoded logs. */
const CACHE_FILE = 'token-usage-cache.json'

/** Cache file format version. */
const CACHE_VERSION = 1

/** Coalesce cache writes; a two-second poll must not rewrite the file. */
const CACHE_WRITE_DELAY_MS = 8000

/** Events that rewrite bookkeeping but are not Session activity. */
const BOOKKEEPING_EVENTS = new Set(['session/end-seed', 'session/checkpoint', 'session/migrated', 'session/format'])

/**
 * Built-in price table — DeepSeek's official CNY list price per million tokens.
 *
 * The pair structure of the official table (cache hit / mainstream / output) is
 * expressed as the off-peak value here; the peak window doubles every rate.
 * Peak is Beijing time, Monday–Friday 09:00–12:00 and 14:00–18:00, excluding the
 * official holidays listed below; weekends and holidays are off-peak.
 *
 * Sources: DeepSeek API pricing (Flash: 0.02 / 1 / 4, Pro: 0.15 / 4.5 / 13.5).
 * The table is a default, not a billing record: `token-usage-prices.json` in the
 * DSH home overrides any entry.
 */
const DEFAULT_PRICING = Object.freeze({
  currency: 'CNY',
  symbol: '¥',
  peakMultiplier: 2,
  models: Object.freeze([
    { match: 'deepseek-v4-pro', cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
    { match: 'deepseek-pro', cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
  ]),
  fallback: Object.freeze({ cacheHit: 0.02, cacheMiss: 1, output: 4 }),
  // Days the whole day bills at the off-peak rate (2026 statutory holidays).
  holidays: Object.freeze([
    '2026-01-01', '2026-01-02', '2026-01-03',
    '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
    '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
    '2026-04-04', '2026-04-05', '2026-04-06',
    '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
    '2026-06-19', '2026-06-20', '2026-06-21',
    '2026-09-25', '2026-09-26', '2026-09-27',
    '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
    '2026-10-06', '2026-10-07',
  ]),
  source: 'builtin',
})

/** Name of the optional override file in the DSH home. */
const PRICE_FILE = 'token-usage-prices.json'

/** Finite non-negative number, or the fallback. */
function numberOr(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

/**
 * Merge an override document over the built-in table.
 * Unknown fields are ignored; malformed entries are dropped.
 * @param raw - parsed `token-usage-prices.json`, or undefined.
 * @returns the effective immutable price table.
 */
export function normalizePricing(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const builtinFallback = DEFAULT_PRICING.fallback
  const fallbackInput = source.fallback !== null && typeof source.fallback === 'object' ? source.fallback : {}
  const fallback = {
    cacheHit: numberOr(fallbackInput.cacheHit, builtinFallback.cacheHit),
    cacheMiss: numberOr(fallbackInput.cacheMiss, builtinFallback.cacheMiss),
    output: numberOr(fallbackInput.output, builtinFallback.output),
  }
  const models = []
  const list = Array.isArray(source.models) ? source.models : []
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue
    const match = typeof entry.match === 'string' ? entry.match.trim().toLowerCase() : ''
    if (match.length === 0) continue
    models.push({
      match,
      cacheHit: numberOr(entry.cacheHit, fallback.cacheHit),
      cacheMiss: numberOr(entry.cacheMiss, fallback.cacheMiss),
      output: numberOr(entry.output, fallback.output),
    })
  }
  // Longest match wins, so a specific name always beats a generic prefix.
  models.sort((left, right) => right.match.length - left.match.length)
  const holidays = Array.isArray(source.holidays)
    ? source.holidays.filter((day) => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day))
    : [...DEFAULT_PRICING.holidays]
  const merged = [...DEFAULT_PRICING.models.map((entry) => ({ ...entry })), ...models]
  return Object.freeze({
    currency: typeof source.currency === 'string' && source.currency.trim().length > 0 ? source.currency.trim() : DEFAULT_PRICING.currency,
    symbol: typeof source.symbol === 'string' && source.symbol.length > 0 ? source.symbol : DEFAULT_PRICING.symbol,
    peakMultiplier: numberOr(source.peakMultiplier, DEFAULT_PRICING.peakMultiplier),
    models: Object.freeze(merged.sort((left, right) => right.match.length - left.match.length)),
    fallback: Object.freeze(fallback),
    holidays: Object.freeze(holidays),
    source: list.length > 0 || source.fallback !== undefined || source.holidays !== undefined ? 'override' : 'builtin',
  })
}

/** The price entry one model string bills at. */
export function priceFor(model, pricing = DEFAULT_PRICING) {  const text = String(model ?? '').toLowerCase()
  for (const entry of pricing.models) {
    if (entry.match.length > 0 && text.includes(entry.match)) return entry
  }
  return pricing.fallback
}

/** Beijing calendar parts of one epoch millisecond value. */
function beijingParts(time) {
  const shifted = new Date(time + 8 * 60 * 60 * 1000)
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  return {
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    key: `${shifted.getUTCFullYear()}-${month}-${day}`,
  }
}

/**
 * Whether one instant bills at the peak rate.
 * Peak is Monday–Friday 09:00–12:00 and 14:00–18:00 Beijing time; weekends and
 * the listed statutory holidays bill at the off-peak rate all day.
 */
export function isPeakTime(time, pricing = DEFAULT_PRICING) {
  if (!Number.isFinite(time)) return false
  const parts = beijingParts(time)
  if (parts.weekday === 0 || parts.weekday === 6) return false
  if (pricing.holidays.includes(parts.key)) return false
  return (parts.hour >= 9 && parts.hour < 12) || (parts.hour >= 14 && parts.hour < 18)
}

/**
 * Estimated price of one usage sample, in the table's currency.
 * Prompt tokens billed as cache misses (writes included) use the miss rate; the
 * peak window multiplies every rate.
 */
export function costOf(sample, price, peak, pricing = DEFAULT_PRICING) {
  const multiplier = peak ? pricing.peakMultiplier : 1
  const amount = sample.cacheRead * price.cacheHit
    + (sample.input + sample.cacheWrite) * price.cacheMiss
    + sample.output * price.output
  return (amount * multiplier) / 1_000_000
}

/** One warning sink that reports each distinct failure once. */
function createLogger() {  const seen = new Set()
  return (message, error) => {
    const key = error === undefined ? message : `${message}: ${error?.code ?? error?.message ?? String(error)}`
    if (seen.has(key)) return
    seen.add(key)
    if (error !== undefined) console.warn(`[token-usage] ${message}`, error)
    else console.warn(`[token-usage] ${message}`)
  }
}

/** Defer to the macro-task queue so a long scan stays responsive. */
function yieldNow() {
  return new Promise((resolve) => {
    setImmediate(resolve)
  })
}

/** Local calendar day of one millisecond timestamp. */
function dayKeyOf(time) {
  const date = new Date(time)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** All-zero usage buckets. */
function zeroBuckets() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
}

/** Add one usage sample into a bucket set in place. */
function addBuckets(target, sample, sign = 1) {
  target.input += sign * sample.input
  target.output += sign * sample.output
  target.cacheRead += sign * sample.cacheRead
  target.cacheWrite += sign * sample.cacheWrite
}

/** True when two bucket sets carry the same counts. */
function bucketsEqual(left, right) {
  return left.input === right.input
    && left.output === right.output
    && left.cacheRead === right.cacheRead
    && left.cacheWrite === right.cacheWrite
}

/** Total billed tokens of one sample: prompt plus completion. */
function totalOf(buckets) {
  return buckets.input + buckets.output + buckets.cacheRead + buckets.cacheWrite
}

/** Trim floating-point noise from an accumulated money amount. */
function roundCost(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.round(number * 1e6) / 1e6
}

/**
 * A fresh per-Session fold state.
 * @returns the mutable reader state of one Session artifact.
 */
export function createSessionState() {
  return {
    sessionId: null,
    title: null,
    cwd: null,
    createdAt: null,
    preset: null,
    origin: null,
    parentSession: null,
    provider: null,
    model: null,
    contextWindow: null,
    totals: zeroBuckets(),
    days: new Map(),
    last: null,
    turns: 0,
    steps: 0,
    lastEventAt: null,
    activityAt: null,
    turnOpen: false,
    lastType: null,
  }
}

/**
 * Locate complete Zstandard frames without decompressing their blocks.
 * Mirrors the Session persistence reader: the frame header and block headers
 * are walked structurally, so a magic byte inside a compressed block cannot
 * split a frame.
 * @param buffer - available bytes, starting at a frame boundary.
 * @returns complete frame ranges plus the start of a torn final frame.
 */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      const error = new Error(`invalid Zstandard frame magic at byte ${offset}`)
      error.code = 'ERR_ZSTD_MAGIC'
      throw error
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) {
      const error = new Error(`reserved Zstandard frame-header bit at byte ${offset - 1}`)
      error.code = 'ERR_ZSTD_HEADER'
      throw error
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) {
        const error = new Error(`reserved Zstandard block type at byte ${offset - 3}`)
        error.code = 'ERR_ZSTD_BLOCK'
        throw error
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/** Read the union of provider usage fields carried by one settlement. */
function usageSampleOf(event) {
  if (event.type === 'assistant/message' && event.data !== null && typeof event.data === 'object' && event.data.usage !== undefined) {
    return event.data.usage
  }
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  const stream = event.data?.stream
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage
  }
  return undefined
}

/** Normalize one provider usage record into the four billed buckets. */
function sampleOf(usage) {
  return {
    input: Math.max(0, Math.trunc(Number(usage?.inputTokens) || 0)),
    output: Math.max(0, Math.trunc(Number(usage?.outputTokens) || 0)),
    cacheRead: Math.max(0, Math.trunc(Number(usage?.cacheReadTokens) || 0)),
    cacheWrite: Math.max(0, Math.trunc(Number(usage?.cacheWriteTokens) || 0)),
  }
}

/** Remember one day bucket, pruning the oldest keys past the retention cap. */
function touchDay(state, key) {
  let bucket = state.days.get(key)
  if (bucket === undefined) {
    bucket = zeroBuckets()
    state.days.set(key, bucket)
    if (state.days.size > MAX_DAYS_PER_SESSION) {
      const oldest = state.days.keys().next().value
      state.days.delete(oldest)
    }
  }
  return bucket
}

/**
 * Fold one durable Session event into a per-Session usage state.
 * @param state - mutable reader state.
 * @param event - one decoded JSONL record.
 * @returns nothing; the state is updated in place.
 */
export function foldEvent(state, event, pricing = DEFAULT_PRICING) {
  if (event === null || typeof event !== 'object' || typeof event.type !== 'string') return
  const time = Number.isFinite(event.time) ? event.time : null
  if (time !== null) state.lastEventAt = time
  if (time !== null && !BOOKKEEPING_EVENTS.has(event.type)) state.activityAt = time
  state.lastType = event.type

  switch (event.type) {
    case 'session': {
      if (typeof event.id === 'string' && event.id.length > 0) state.sessionId = event.id
      if (typeof event.cwd === 'string' && event.cwd.length > 0) state.cwd = event.cwd
      if (Number.isFinite(event.createdAt)) state.createdAt = event.createdAt
      if (typeof event.agentPreset === 'string') state.preset = event.agentPreset
      if (typeof event.origin === 'string') state.origin = event.origin
      if (typeof event.parentSession === 'string') state.parentSession = event.parentSession
      if (time !== null) state.activityAt = event.createdAt ?? time
      return
    }
    case 'session/title': {
      const title = event.data?.title
      if (typeof title === 'string' && title.length > 0) state.title = title
      return
    }
    case 'turn/start': {
      state.turns += 1
      state.turnOpen = true
      return
    }
    case 'turn/end': {
      state.turnOpen = false
      return
    }
    case 'step/start': {
      state.steps += 1
      return
    }
    case 'request/header': {
      const config = event.data?.header?.config
      if (typeof config?.provider === 'string') state.provider = config.provider
      if (typeof config?.model === 'string') state.model = config.model
      return
    }
    case 'request/context': {
      if (typeof event.data?.provider === 'string') state.provider = event.data.provider
      if (typeof event.data?.model === 'string') state.model = event.data.model
      if (Number.isFinite(event.data?.contextWindow)) state.contextWindow = event.data.contextWindow
      return
    }
    case 'llm/retry-started': {
      const turn = event.data?.turn
      const step = event.data?.step
      if (state.last !== null && state.last.turn === turn && state.last.step === step) state.last = null
      return
    }
    case 'assistant/message':
    case 'assistant/attempt': {
      const source = event.data?.message?.source
      if (typeof source?.provider === 'string') state.provider = source.provider
      if (typeof source?.model === 'string') state.model = source.model
      const usage = usageSampleOf(event)
      if (usage === undefined || usage === null) return
      const sample = sampleOf(usage)
      const turn = Number.isFinite(event.data?.turn) ? event.data.turn : null
      const step = Number.isFinite(event.data?.step) ? event.data.step : null
      const at = time ?? state.createdAt ?? Date.now()
      const key = dayKeyOf(at)
      const price = priceFor(state.model, pricing)
      const cost = costOf(sample, price, isPeakTime(at, pricing), pricing)
      const previous = state.last !== null && state.last.turn === turn && state.last.step === step ? state.last : null
      if (previous !== null
        && bucketsEqual(previous.buckets, sample)
        && previous.day === key
        && Math.abs((previous.cost ?? 0) - cost) < 1e-9) return
      if (previous !== null) {
        addBuckets(state.totals, previous.buckets, -1)
        state.totals.cost -= previous.cost ?? 0
        const bucket = state.days.get(previous.day)
        if (bucket !== undefined) {
          addBuckets(bucket, previous.buckets, -1)
          bucket.cost -= previous.cost ?? 0
        }
      }
      addBuckets(state.totals, sample, 1)
      state.totals.cost += cost
      const dayBucket = touchDay(state, key)
      addBuckets(dayBucket, sample, 1)
      dayBucket.cost += cost
      state.last = { turn, step, buckets: sample, day: key, cost }
      return
    }
    default:
      return
  }
}

/**
 * Incremental append-only reader for one Session artifact.
 *
 * The reader keeps the byte offset of the first undecoded frame plus any torn
 * tail, so a poll only reads and decompresses what the Host appended since the
 * previous poll. Totals and day buckets fold in place and stay small.
 */
export function createSessionReader(file, pricing = DEFAULT_PRICING) {
  return {
    file,
    pricing,
    offset: 0,
    pendingBytes: Buffer.alloc(0),
    pendingText: '',
    state: createSessionState(),
    size: 0,
    mtimeMs: 0,
    missing: false,
    error: null,
    dirty: false,

    /** Forget all decoded bytes; used when an artifact is truncated or replaced. */
    reset() {
      this.offset = 0
      this.pendingBytes = Buffer.alloc(0)
      this.pendingText = ''
      this.state = createSessionState()
      this.error = null
    },

    /** Decode complete frames out of the accumulated byte tail. */
    ingest(chunk) {
      const buffer = this.pendingBytes.length === 0 ? chunk : Buffer.concat([this.pendingBytes, chunk])
      let consumed = 0
      for (;;) {
        const view = buffer.subarray(consumed)
        if (view.length === 0) {
          this.pendingBytes = Buffer.alloc(0)
          return
        }
        // Frame ranges and `tornStart` are relative to `view`; keep the base
        // position so a torn tail is retained at its absolute byte offset.
        const base = consumed
        let scan
        try {
          scan = scanZstdFrames(view)
        } catch (error) {
          this.error = `${error.code ?? 'ERR_ZSTD'}: ${error.message}`
          this.pendingBytes = Buffer.alloc(0)
          return
        }
        for (const frame of scan.frames) {
          let text
          try {
            text = zstdDecompressSync(view.subarray(frame.start, frame.end)).toString('utf8')
          } catch (error) {
            this.error = `ERR_ZSTD_DECODE: ${error?.message ?? String(error)}`
            continue
          }
          this.feedText(text)
          this.dirty = true
        }
        if (scan.tornStart !== undefined) {
          this.pendingBytes = Buffer.from(buffer.subarray(base + scan.tornStart))
          return
        }
        if (scan.frames.length === 0) {
          this.pendingBytes = Buffer.from(view)
          return
        }
        consumed = base + scan.frames[scan.frames.length - 1].end
      }
    },

    /** Split decoded plaintext into lines and fold every complete one. */
    feedText(text) {
      this.pendingText += text
      if (this.pendingText.length > MAX_LINE_BYTES) {
        const cut = this.pendingText.lastIndexOf('\n')
        this.pendingText = cut >= 0 ? this.pendingText.slice(cut + 1) : ''
        this.error = 'ERR_LINE_TOO_LONG'
      }
      let index = this.pendingText.indexOf('\n')
      while (index >= 0) {        const line = this.pendingText.slice(0, index)
        this.pendingText = this.pendingText.slice(index + 1)
        if (line.length > 0) {
          try {
            foldEvent(this.state, JSON.parse(line), this.pricing)
          } catch {
            /* One malformed JSONL line must not stop the rest of the log. */
          }
        }
        index = this.pendingText.indexOf('\n')
      }
    },

    /** Read and fold everything appended since the previous poll. */
    async poll() {
      let info
      try {
        info = await stat(this.file)
      } catch (error) {
        this.missing = true
        this.error = error?.code === 'ENOENT' ? null : `ERR_STAT: ${error?.message ?? String(error)}`
        return
      }
      this.missing = false
      this.mtimeMs = info.mtimeMs
      if (info.size < this.offset) this.reset()
      if (info.size === this.offset) return
      const length = info.size - this.offset
      const buffer = Buffer.allocUnsafe(length)
      const handle = await open(this.file, 'r')
      let read = 0
      try {
        while (read < length) {
          const { bytesRead } = await handle.read(buffer, read, length - read, this.offset + read)
          if (bytesRead <= 0) break
          read += bytesRead
        }
      } finally {
        await handle.close()
      }
      this.offset += read
      this.size = this.offset
      if (read > 0) this.ingest(read === length ? buffer : buffer.subarray(0, read))
    },

    /** Attribution facts that do not depend on usage. */
    identity() {
      const state = this.state
      return {
        sessionId: state.sessionId ?? basename(dirname(this.file)),
        title: state.title,
        cwd: state.cwd,
        createdAt: state.createdAt,
        preset: state.preset,
        origin: state.origin,
        parentSession: state.parentSession,
        provider: state.provider,
        model: state.model,
        contextWindow: state.contextWindow,
      }
    },
  }
}

/** Skip entries the scanner must ignore, such as legacy format directories. */
function isSessionArtifact(name) {
  return SESSION_FILES.includes(name)
}

/**
 * Discover every Session artifact under one DSH home.
 * @param sessionsRoot - `<dsh home>/sessions`.
 * @returns absolute artifact paths.
 */
export async function discoverArtifacts(sessionsRoot) {
  let workspaces
  try {
    workspaces = await readdir(sessionsRoot, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const found = []
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    const workspaceDir = join(sessionsRoot, workspace.name)
    let sessions
    try {
      sessions = await readdir(workspaceDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      for (const name of SESSION_FILES) {
        const candidate = join(workspaceDir, session.name, name)
        try {
          const info = await stat(candidate)
          if (info.isFile()) {
            found.push(candidate)
            break
          }
        } catch {
          /* Try the next artifact name. */
        }
      }
    }
  }
  return found
}

/**
 * Decode a workspace directory name into a readable path.
 * The Host replaces the drive colon and both separators with `-` and escapes
 * every other special character as `~XXXX`.
 * @param name - encoded workspace directory name.
 * @returns a best-effort human path.
 */
export function decodeWorkspaceName(name) {
  const trimmed = name.replace(/^--/, '').replace(/--$/, '')
  const decoded = trimmed.replace(/~(?:0020|[0-9A-Fa-f]{4})/g, (match) => {
    if (match === '~0020') return ' '
    const code = Number.parseInt(match.slice(1), 16)
    return Number.isFinite(code) ? String.fromCharCode(code) : match
  })
  return decoded
}

/** Human label for one Session's workspace. */
function workspaceOf(state, file) {
  if (typeof state.cwd === 'string' && state.cwd.length > 0) {
    const label = basename(state.cwd.replace(/[\\/]+$/, '')) || state.cwd
    return { name: label, path: state.cwd }
  }
  const encoded = basename(dirname(file))
  const decoded = decodeWorkspaceName(encoded)
  return { name: decoded || encoded, path: decoded }
}

/** Public summary of one Session for the browser half. */
function summarize(reader, now) {
  const state = reader.state
  const totals = state.totals
  const total = totalOf(totals)
  const prompt = totals.input + totals.cacheRead + totals.cacheWrite
  const workspace = workspaceOf(state, reader.file)
  const days = []
  for (const [day, buckets] of state.days) {
    const dayTotal = totalOf(buckets)
    if (dayTotal === 0) continue
    days.push({
      day,
      input: buckets.input,
      output: buckets.output,
      cacheRead: buckets.cacheRead,
      cacheWrite: buckets.cacheWrite,
      total: dayTotal,
      cost: roundCost(buckets.cost),
    })
  }
  days.sort((left, right) => left.day.localeCompare(right.day))
  const lastActivityAt = state.activityAt ?? state.createdAt ?? null
  return {
    sessionId: reader.identity().sessionId,
    title: state.title,
    workspace,
    model: state.model,
    provider: state.provider,
    preset: state.preset,
    origin: state.origin,
    parentSession: state.parentSession,
    contextWindow: state.contextWindow,
    createdAt: state.createdAt,
    lastActivityAt,
    active: state.turnOpen,
    live: state.turnOpen && lastActivityAt !== null && now - lastActivityAt < LIVE_WINDOW_MS,
    turns: state.turns,
    steps: state.steps,
    input: totals.input,
    output: totals.output,
    cacheRead: totals.cacheRead,
    cacheWrite: totals.cacheWrite,
    total,
    prompt,
    cost: roundCost(totals.cost),
    cacheHitRate: prompt > 0 ? totals.cacheRead / prompt : 0,
    error: reader.error,
    days,
  }
}

/** Serialize one fold state for the cache file. */
export function serializeSessionState(state) {
  const days = {}
  for (const [day, buckets] of state.days) days[day] = { ...buckets }
  return {
    sessionId: state.sessionId,
    title: state.title,
    cwd: state.cwd,
    createdAt: state.createdAt,
    preset: state.preset,
    origin: state.origin,
    parentSession: state.parentSession,
    provider: state.provider,
    model: state.model,
    contextWindow: state.contextWindow,
    totals: { ...state.totals },
    days,
    last: state.last,
    turns: state.turns,
    steps: state.steps,
    lastEventAt: state.lastEventAt,
    activityAt: state.activityAt,
    turnOpen: state.turnOpen,
    lastType: state.lastType,
  }
}

/**
 * Rebuild a fold state from a cached entry.
 * @returns the restored state, or undefined when the entry is malformed.
 */
export function restoreSessionState(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  if (raw.totals === null || typeof raw.totals !== 'object') return undefined
  const text = (value) => (typeof value === 'string' ? value : null)
  const count = (value) => (Number.isFinite(value) ? value : 0)
  const state = createSessionState()
  state.sessionId = text(raw.sessionId)
  state.title = text(raw.title)
  state.cwd = text(raw.cwd)
  state.createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : null
  state.preset = text(raw.preset)
  state.origin = text(raw.origin)
  state.parentSession = text(raw.parentSession)
  state.provider = text(raw.provider)
  state.model = text(raw.model)
  state.contextWindow = Number.isFinite(raw.contextWindow) ? raw.contextWindow : null
  state.totals = {
    input: count(raw.totals.input),
    output: count(raw.totals.output),
    cacheRead: count(raw.totals.cacheRead),
    cacheWrite: count(raw.totals.cacheWrite),
    cost: count(raw.totals.cost),
  }
  if (raw.days !== null && typeof raw.days === 'object') {
    for (const [day, buckets] of Object.entries(raw.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || buckets === null || typeof buckets !== 'object') continue
      state.days.set(day, {
        input: count(buckets.input),
        output: count(buckets.output),
        cacheRead: count(buckets.cacheRead),
        cacheWrite: count(buckets.cacheWrite),
        cost: count(buckets.cost),
      })
    }
  }
  if (raw.last !== null && typeof raw.last === 'object' && raw.last.buckets !== null && typeof raw.last.buckets === 'object') {
    state.last = {
      turn: Number.isFinite(raw.last.turn) ? raw.last.turn : null,
      step: Number.isFinite(raw.last.step) ? raw.last.step : null,
      buckets: {
        input: count(raw.last.buckets.input),
        output: count(raw.last.buckets.output),
        cacheRead: count(raw.last.buckets.cacheRead),
        cacheWrite: count(raw.last.buckets.cacheWrite),
      },
      day: text(raw.last.day),
      cost: count(raw.last.cost),
    }
  }
  state.turns = count(raw.turns)
  state.steps = count(raw.steps)
  state.lastEventAt = Number.isFinite(raw.lastEventAt) ? raw.lastEventAt : null
  state.activityAt = Number.isFinite(raw.activityAt) ? raw.activityAt : null
  state.turnOpen = raw.turnOpen === true
  state.lastType = text(raw.lastType)
  return state
}

/** Read the cache file; any problem yields an empty map. */
function readCacheFile(file) {
  const entries = new Map()
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || parsed.version !== CACHE_VERSION) return entries
    if (parsed.files === null || typeof parsed.files !== 'object') return entries
    for (const [path, entry] of Object.entries(parsed.files)) {
      if (typeof path !== 'string' || entry === null || typeof entry !== 'object') continue
      if (!Number.isFinite(entry.size) || !Number.isFinite(entry.mtimeMs)) continue
      entries.set(path, entry)
    }
  } catch {
    /* A missing or corrupt cache only costs a full scan. */
  }
  return entries
}

/**
 * One scanner over every Session artifact in the DSH home.
 * Reads are single-flight and cheap after the first pass: only appended
 * frames are decoded. With a cache file, a restart reuses the previous fold
 * whenever an artifact's size and modification time are unchanged.
 */
export function createScanner(sessionsRoot, pricing = DEFAULT_PRICING, options = {}) {
  const readers = new Map()
  const cacheFile = typeof options.cacheFile === 'string' ? options.cacheFile : undefined
  const cacheEntries = cacheFile === undefined ? new Map() : readCacheFile(cacheFile)
  let lastRefreshAt = 0
  let lastError = null
  let inflight = null
  let scannedOnce = false
  let persistTimer = null
  let persistInflight = null
  let persistedAt = 0

  /** Write the cache, coalescing bursts; a failure never fails a scan. */
  async function persistNow(force = false) {
    if (cacheFile === undefined) return
    if (persistInflight !== null) return persistInflight
    const files = {}
    let dirty = false
    for (const [path, reader] of readers) {
      if (reader.missing || reader.pendingBytes.length > 0) continue
      if (reader.dirty) dirty = true
      files[path] = {
        size: reader.size,
        mtimeMs: reader.mtimeMs,
        offset: reader.offset,
        state: serializeSessionState(reader.state),
      }
    }
    if (!force && !dirty && persistedAt > 0) return
    const body = JSON.stringify({ version: CACHE_VERSION, updatedAt: Date.now(), files })
    persistInflight = (async () => {
      try {
        await mkdir(dirname(cacheFile), { recursive: true })
        const temporary = `${cacheFile}.${process.pid}.${Date.now()}.tmp`
        await writeFile(temporary, body)
        await rename(temporary, cacheFile)
        persistedAt = Date.now()
        for (const reader of readers.values()) reader.dirty = false
      } catch {
        /* Ignore: the next cold start simply scans again. */
      } finally {
        persistInflight = null
      }
    })()
    return persistInflight
  }

  function schedulePersist() {
    if (cacheFile === undefined || persistTimer !== null) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      void persistNow()
    }, CACHE_WRITE_DELAY_MS)
    if (typeof persistTimer.unref === 'function') persistTimer.unref()
  }

  /** Adopt a cache entry when the artifact is byte-identical to what it saw. */
  async function adoptCached(file, reader) {
    const entry = cacheEntries.get(file)
    if (entry === undefined) return
    try {
      const info = await stat(file)
      if (entry.size !== info.size || entry.mtimeMs !== info.mtimeMs) return
      const state = restoreSessionState(entry.state)
      if (state === undefined) return
      reader.state = state
      reader.offset = info.size
      reader.size = info.size
      reader.mtimeMs = info.mtimeMs
    } catch {
      /* Fall through to a full read. */
    }
  }

  async function refreshOnce() {
    let files
    try {
      files = await discoverArtifacts(sessionsRoot)
      lastError = null
    } catch (error) {
      lastError = error?.message ?? String(error)
      return
    }
    const seen = new Set(files)
    for (const [file] of readers) {
      if (!seen.has(file)) readers.delete(file)
    }
    let sliceStart = Date.now()
    for (const file of files) {
      let reader = readers.get(file)
      if (reader === undefined) {
        reader = createSessionReader(file, pricing)
        await adoptCached(file, reader)
        readers.set(file, reader)
      }
      try {
        await reader.poll()
      } catch (error) {
        reader.error = `ERR_POLL: ${error?.message ?? String(error)}`
      }
      if (Date.now() - sliceStart > 8) {
        await yieldNow()
        sliceStart = Date.now()
      }
    }
    lastRefreshAt = Date.now()
    scannedOnce = true
    schedulePersist()
  }

  return {
    /** Root the scanner reads. */
    root: sessionsRoot,
    /** Refresh at most once per `STALE_AFTER_MS`, sharing one run. */
    async refresh(force = false) {
      if (inflight !== null) return inflight
      if (!force && Date.now() - lastRefreshAt < STALE_AFTER_MS) return undefined
      inflight = refreshOnce().finally(() => {
        inflight = null
      })
      return inflight
    },
    /** Persist the current fold now; called when the plugin unloads. */
    async flush() {
      if (persistTimer !== null) {
        clearTimeout(persistTimer)
        persistTimer = null
      }
      await persistNow(true)
    },
    /**
     * Weak validator over every artifact's size and modification time.
     * Unchanged logs keep the same value, so a poll can answer 304 and skip the
     * whole payload.
     */
    etag() {
      let hash = 2166136261
      for (const [file, reader] of readers) {
        hash ^= reader.size + Math.round(reader.mtimeMs)
        hash = Math.imul(hash, 16777619)
        hash ^= file.length
        hash = Math.imul(hash, 16777619)
      }
      return `W/"${readers.size.toString(36)}-${(hash >>> 0).toString(36)}"`
    },
    /** Whether at least one full pass completed. */
    get scanned() {
      return scannedOnce
    },
    /** Last discovery failure, if any. */
    get error() {
      return lastError
    },
    /** Current snapshot; no I/O. */
    snapshot() {
      const now = Date.now()
      const sessions = []
      for (const reader of readers.values()) {
        if (reader.missing) continue
        sessions.push(summarize(reader, now))
      }
      sessions.sort((left, right) => right.total - left.total)
      const totals = zeroBuckets()
      const days = new Map()
      for (const session of sessions) {
        addBuckets(totals, session, 1)
        totals.cost += session.cost
        for (const day of session.days) {
          const bucket = days.get(day.day) ?? zeroBuckets()
          addBuckets(bucket, day, 1)
          bucket.cost += day.cost
          days.set(day.day, bucket)
        }
      }
      const dayRows = []
      for (const [day, buckets] of days) {
        dayRows.push({
          day,
          input: buckets.input,
          output: buckets.output,
          cacheRead: buckets.cacheRead,
          cacheWrite: buckets.cacheWrite,
          total: totalOf(buckets),
          cost: roundCost(buckets.cost),
        })
      }
      dayRows.sort((left, right) => left.day.localeCompare(right.day))
      const todayRow = dayRows.find((row) => row.day === dayKeyOf(now))
      return {
        ok: true,
        now,
        generatedAt: lastRefreshAt,
        scanning: !scannedOnce,
        error: lastError,
        sessions: sessions.slice(0, MAX_SESSIONS),
        totals: {
          input: totals.input,
          output: totals.output,
          cacheRead: totals.cacheRead,
          cacheWrite: totals.cacheWrite,
          total: totalOf(totals),
          cost: roundCost(totals.cost),
          sessions: sessions.length,
          today: todayRow?.total ?? 0,
          todayCost: todayRow?.cost ?? 0,
        },
        pricing: {
          currency: pricing.currency,
          symbol: pricing.symbol,
          peakMultiplier: pricing.peakMultiplier,
          source: pricing.source,
        },
        days: dayRows,
      }
    },
  }
}

/**
 * Read the optional price override file.
 * @param file - `<dsh home>/token-usage-prices.json`.
 * @param log - warning sink.
 * @returns the effective price table (built-in when the file is absent).
 */
export function loadPricing(file, log = () => {}) {
  try {
    return normalizePricing(JSON.parse(readFileSync(file, 'utf8')))
  } catch (error) {
    if (error?.code !== 'ENOENT') log(`could not read ${file}`, error)
    return DEFAULT_PRICING
  }
}

/** Answer one JSON response with no-store caching. */
function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

/** Refuse cross-site reads; same-origin browser requests and plain clients pass. */
function isAcceptableOrigin(request) {
  const origin = request.headers.origin
  if (origin === undefined) return true
  if (origin === 'null') return false
  try {
    return new URL(origin).host === request.headers.host
  } catch {
    return false
  }
}

/**
 * Register the read-only usage route.
 * @param ctx - Host context carrying the services this plugin reads.
 */
export function apply(ctx) {
  const homePath = ctx.get('dshHomePath')
  const sessionsRoot = typeof homePath === 'function' ? homePath('sessions') : join(homedir(), '.dsh', 'sessions')
  const pricingFile = typeof homePath === 'function' ? homePath(PRICE_FILE) : join(homedir(), '.dsh', PRICE_FILE)
  const log = createLogger()
  const pricing = loadPricing(pricingFile, log)
  const cacheFile = typeof homePath === 'function' ? homePath(CACHE_FILE) : join(homedir(), '.dsh', CACHE_FILE)
  const scanner = createScanner(sessionsRoot, pricing, { cacheFile })

  // Warm the cache in the background so the first page open is already cheap.
  const warm = setTimeout(() => {
    scanner.refresh(true).catch((error) => log('warm scan failed', error))
  }, 1500)
  if (typeof warm.unref === 'function') warm.unref()
  ctx.effect(() => () => {
    clearTimeout(warm)
    scanner.flush().catch(() => {})
  }, 'token-usage: warm scan')

  ctx.inject(['webServer'], (scope) => {
    const handler = async (request, response) => {
      try {
        if (!isAcceptableOrigin(request)) {
          sendJson(response, 403, { ok: false, error: 'cross-origin request refused' })
          return
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        await scanner.refresh().catch((error) => log('refresh failed', error))
        const etag = scanner.etag()
        if (request.method === 'GET' && request.headers['if-none-match'] === etag) {
          response.writeHead(304, { etag, 'cache-control': 'no-store' })
          response.end()
          return
        }
        const payload = scanner.snapshot()
        const body = JSON.stringify(payload)
        if (request.method === 'HEAD') {
          response.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(body),
            'cache-control': 'no-store',
            etag,
          })
          response.end()
          return
        }
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(body),
          'cache-control': 'no-store',
          etag,
        })
        response.end(body)
      } catch (error) {
        log('request failed', error)
        try {
          sendJson(response, 500, { ok: false, error: 'internal error' })
        } catch {
          response.destroy()
        }
      }
    }
    scope.effect(
      () => scope.webServer.register({ kind: 'exact', path: ROUTE, handler }),
      'token-usage: browser route',
    )
  })
}
