// DOM harness for the Token usage page.
//
// Runs the shipped client bundle inside jsdom with a stubbed module loader and
// a stubbed Host route, then drives the real React component: layout, range
// windows, workspace grouping, sub-session folding, sorting, search, filters,
// opening a session, and the error/empty states.
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

// React's DOM renderer reads `window`/`document` globals, so install jsdom
// before importing it.
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'http://127.0.0.1:56696/',
  pretendToBeVisual: true,
  runScripts: 'outside-only',
})
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })

const React = (await import('react')).default
const { createRoot } = await import('react-dom/client')

// Browsers only: jsdom has neither object URLs nor a clipboard, so the export
// helpers get observable stand-ins.
const downloads = []
const clicks = []
const copied = []
window.URL.createObjectURL = (blob) => {
  downloads.push(blob)
  return 'blob:mock'
}
window.URL.revokeObjectURL = () => {}
window.HTMLAnchorElement.prototype.click = function click() {
  clicks.push({ name: this.download, href: this.href })
}
Object.defineProperty(window.navigator, 'clipboard', {
  configurable: true,
  value: {
    writeText: async (text) => {
      copied.push(text)
    },
  },
})

/** Wait until `probe` returns a truthy value or the deadline passes. */
async function waitFor(probe, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** Local day key offset from today. */
function dayKey(offset) {
  const today = new Date()
  const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** One day bucket. */
function day(offset, input, output, cacheRead, cost, peakShare = 0.25) {
  return {
    day: dayKey(offset),
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    total: input + output + cacheRead,
    cost,
    costPeak: cost * peakShare,
    costValley: cost * (1 - peakShare),
  }
}

/**
 * Synthetic payload with known totals.
 * A, B and C carry usage; D has none; E is B's sub-session.
 */
function payload() {
  const session = (id, title, workspace, days, extra = {}) => {
    const input = days.reduce((sum, row) => sum + row.input, 0)
    const output = days.reduce((sum, row) => sum + row.output, 0)
    const cacheRead = days.reduce((sum, row) => sum + row.cacheRead, 0)
    const cost = days.reduce((sum, row) => sum + row.cost, 0)
    return {
      sessionId: id,
      title,
      workspace: { name: workspace, path: `D:\\Work\\${workspace}` },
      model: 'demo-model',
      provider: 'demo-provider',
      preset: 'standard',
      origin: 'user',
      parentSession: null,
      contextWindow: 1000000,
      createdAt: 1793600000000,
      lastActivityAt: Date.now() - 60000,
      active: false,
      live: false,
      turns: 1,
      steps: 2,
      input,
      output,
      cacheRead,
      cacheWrite: 0,
      total: input + output + cacheRead,
      prompt: input + cacheRead,
      cost,
      cacheHitRate: (input + cacheRead) > 0 ? cacheRead / (input + cacheRead) : 0,
      error: null,
      days,
      ...extra,
    }
  }
  const sessions = [
    session('session-a', 'Alpha, "quoted" | 会话', 'workplace', [day(0, 100, 50, 150, 0.5)]),
    session('session-b', 'Beta 会话', 'workplace', [day(0, 150, 75, 175, 0.75), day(10, 50, 25, 25, 0.5)], { live: true }),
    session('session-c', 'Gamma 会话', 'docs', [day(0, 10, 5, 85, 0.15)]),
    session('session-d', 'Zero 会话', 'docs', []),
    session('session-e', 'Beta 子任务', 'workplace', [day(0, 20, 10, 30, 0.3)], {
      origin: 'subagent',
      parentSession: 'session-b',
      model: 'demo-model-mini',
    }),
  ]
  return {
    ok: true,
    now: Date.now(),
    generatedAt: Date.now(),
    scanning: false,
    error: null,
    pricing: { currency: 'CNY', symbol: '¥', peakMultiplier: 2, source: 'builtin', peakNow: false, nextSwitchAt: Date.now() + 2 * 3600 * 1000 },
    sessions,
    totals: {
      input: 330,
      output: 165,
      cacheRead: 465,
      cacheWrite: 0,
      total: 960,
      cost: 2.2,
      costPeak: 0.55,
      costValley: 1.65,
      todayCost: 1.7,
      sessions: 4,
      today: 860,
    },
    days: [
      { day: dayKey(0), input: 280, output: 140, cacheRead: 440, cacheWrite: 0, total: 860, cost: 1.7, costPeak: 0.425, costValley: 1.275 },
      { day: dayKey(10), input: 50, output: 25, cacheRead: 25, cacheWrite: 0, total: 100, cost: 0.5, costPeak: 0.125, costValley: 0.375 },
    ],
  }
}

/** Load the client bundle with a stubbed loader and Host route. */
function loadPlugin(options) {
  const opened = []
  const panels = []
  const registrations = []
  const dicts = {}
  const container = document.createElement('div')
  document.body.appendChild(container)
  // Lets a test answer the next poll with `304 Not Modified`.
  const fetchState = { notModified: false }
  // Shared layout selection source, mirroring the host layout store.
  const selectPanel = (id) => {
    panels.push(id)
  }

  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register(_ns, table) {
        dicts.zh = table.zh
        dicts.en = table.en
      },
      bind: () => (key, params) => {
        const template = dicts.zh?.[key] ?? dicts.en?.[key] ?? key
        if (params === undefined) return template
        return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
      },
      subscribe: () => () => {},
      getSnapshot: () => ({ active: 'zh' }),
    },
    slots: {
      inject(_name, fn) {
        fn()
      },
      register(entry, component) {
        registrations.push({ entry, component })
        return () => {}
      },
    },
    get(name) {
      if (name === 'uiWorkspace') return { openSession: (id) => opened.push(id) }
      if (name === 'locale') return ctx.locale
      return undefined
    },
    layout: { selectPanel },
  }

  window.__ModuleLoader__ = {
    load(def) {
      const api = def.factory((id) => {
        if (id === 'react') return React
        throw new Error(`unexpected require: ${id}`)
      })
      api.apply(ctx)
    },
  }
  window.fetch = async (url, init) => {
    if (String(url).startsWith('/session-boxes')) {
      if (options.boxesMode === 'missing') {
        return { ok: false, status: 404, async json() { return {} } }
      }
      if (options.boxesMode === 'bad') {
        return { ok: true, status: 200, async json() { return { ok: true, state: { boxes: 'nope' } } } }
      }
      if (options.boxesMode === 'hang') {
        return new Promise((resolve, reject) => {
          const signal = init?.signal
          if (signal !== undefined && signal !== null) signal.addEventListener('abort', () => reject(new Error('aborted')))
        })
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return options.boxesPayload ?? { ok: true, state: { boxes: [], memberships: {} } }
        },
      }
    }
    if (options.fail === true) throw new Error('boom')
    if (fetchState.notModified) {
      return {
        ok: true,
        status: 304,
        headers: { get: () => undefined },
        async json() {
          throw new Error('a 304 body must never be parsed')
        },
      }
    }
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (String(name).toLowerCase() === 'etag' ? 'W/"dom"' : null) },
      async json() {
        return options.data ?? payload()
      },
    }
  }
  window.eval(SOURCE)
  return { container, opened, panels, registrations, ctx, dicts, fetchState }
}

/** Mount the registered main panel into its container. */
function mount(build) {
  const page = build.registrations.find((row) => row.entry.name === 'main')
  if (page === undefined) throw new Error('main panel was not registered')
  const root = createRoot(build.container)
  root.render(React.createElement(page.component, {}))
  return {
    container: build.container,
    rows: () => Array.from(build.container.querySelectorAll('tbody tr.tu-row')),
    groups: () => Array.from(build.container.querySelectorAll('tr.tu-group-row')),
    headers: () => Array.from(build.container.querySelectorAll('thead th')),
    text: () => build.container.textContent,
    unmount: () => root.unmount(),
  }
}

/** Set an input/select value the way React observes it. */
function setValue(window, element, value, eventName = 'input') {
  const prototype = element instanceof window.HTMLSelectElement
    ? window.HTMLSelectElement.prototype
    : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set
  setter.call(element, value)
  element.dispatchEvent(new window.Event(eventName, { bubbles: true }))
}

let failures = 0
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`✔ ${label}`)
    return
  }
  failures += 1
  console.error(`✖ ${label}${detail ? ` — ${detail}` : ''}`)
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

const build = loadPlugin({})
const page = mount(build)
await waitFor(() => page.rows().length > 0, 'table rows')

check('registers a main panel', build.registrations.some((row) => row.entry.name === 'main' && row.entry.key === 'token-usage'))
check('registers a sidebar entry', build.registrations.some((row) => row.entry.name === 'sidebar.panellist' && row.entry.id === 'token-usage'))
const sidebarEntry = build.registrations.find((row) => row.entry.name === 'sidebar.panellist')
check('sidebar label is localized', sidebarEntry.entry.label() === 'Token 用量', String(sidebarEntry.entry.label()))
check('page title rendered', build.container.querySelector('.tu-title')?.textContent === 'Token 用量')
check('summary spend rendered', build.container.querySelector('.tu-card-value')?.textContent === '¥2.20', build.container.querySelector('.tu-card-value')?.textContent ?? '')
check('summary tokens rendered', build.container.querySelectorAll('.tu-card-value')[2]?.textContent === '960', build.container.querySelectorAll('.tu-card-value')[2]?.textContent ?? '')
check('zero-usage session hidden by default', page.rows().length === 3, String(page.rows().length))
check('default sort is total desc', page.rows()[0].textContent.includes('Beta'))
check('live marker rendered once', build.container.querySelectorAll('.tu-dot').length === 1)
check('stylesheet installed once', document.querySelectorAll('style[data-plugin-css="dsh-token-usage/TokenUsage.css"]').length === 1)

// All-time keeps lifetime totals and compares the latest seven days.
const cards = () => Array.from(build.container.querySelectorAll('.tu-summary .tu-card'))
const lifetimeTrend = cards()[0].querySelector('.tu-trend')
check('lifetime cards carry a recent trend', lifetimeTrend !== null
  && (lifetimeTrend.getAttribute('title') ?? '').includes('近 7 天'), lifetimeTrend?.getAttribute('title') ?? 'none')
check('today cards carry a trend', cards()[1].querySelector('.tu-trend') !== null && cards()[3].querySelector('.tu-trend') !== null)
check('today cost trend marks a new amount', cards()[1].querySelector('.tu-trend').getAttribute('data-direction') === 'new'
  && cards()[1].querySelector('.tu-trend').textContent.includes('新增'), cards()[1].querySelector('.tu-trend').textContent)

// Grouping is on by default: one header row per workspace.
check('groups by workspace', page.groups().length === 2, String(page.groups().length))
check('group names and subtotals', page.groups()[0].textContent.includes('workplace') && page.groups()[0].textContent.includes('¥2.05'),
  page.groups()[0].textContent.slice(0, 60))
check('sub-session is folded into its parent', page.rows().length === 3)

// Expand and collapse the sub-session.
const childChip = page.rows().find((row) => row.textContent.includes('Beta')).querySelector('.tu-chip[aria-expanded]')
check('parent shows a sub-session chip', childChip !== null && childChip.textContent.includes('1 个子会话'), childChip?.textContent ?? '')
childChip.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await waitFor(() => page.rows().length === 4, 'child row expanded')
check('chip expands the sub-session', page.rows().some((row) => row.classList.contains('tu-row-child') && row.textContent.includes('Beta 子任务')))
page.rows().find((row) => row.textContent.includes('Beta') && !row.classList.contains('tu-row-child'))
  .querySelector('.tu-chip[aria-expanded]')
  .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await waitFor(() => page.rows().length === 3, 'child row collapsed')
check('chip collapses the sub-session', page.rows().length === 3)

// Per-session daily detail: the chevron expands a day strip without opening.
const detailToggle = page.rows()[0].querySelector('.tu-row-toggle')
check('row detail toggle renders', detailToggle !== null)
detailToggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await waitFor(() => build.container.querySelectorAll('tr.tu-detail-row').length === 1, 'detail row')
check('row detail expands daily bars', build.container.querySelectorAll('.tu-detail-day').length >= 1,
  String(build.container.querySelectorAll('.tu-detail-day').length))
check('row detail does not open the session', build.opened.length === 0)
detailToggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await waitFor(() => build.container.querySelectorAll('tr.tu-detail-row').length === 0, 'detail collapsed')
check('row detail collapses again', build.container.querySelectorAll('tr.tu-detail-row').length === 0)

// Flat list: the grouping dimension offers workspace and none without boxes.
const groupButtons = Array.from(build.container.querySelectorAll('.tu-toolbar-toggles .tu-seg .tu-seg-btn'))
check('grouping offers workspace and none without boxes', groupButtons.length === 2, String(groupButtons.length))
groupButtons[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await waitFor(() => page.groups().length === 0, 'grouping off')
check('grouping toggle flattens the list', page.groups().length === 0 && page.rows().length === 3)

// Sorting: Output is the fourth header.
page.headers()[3].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await waitFor(() => page.rows()[0]?.textContent.includes('Beta'), 'sort by output desc')
check('sort by output desc', page.rows().map((row) => (row.textContent.includes('Beta') && !row.classList.contains('tu-row-child') ? 'B' : row.textContent.includes('Alpha') ? 'A' : 'C')).join('') === 'BAC')

page.headers()[3].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await waitFor(() => page.rows()[0]?.textContent.includes('Gamma'), 'sort by output asc')
check('sort by output asc toggles direction', page.rows()[0].textContent.includes('Gamma'))

page.headers()[2].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await waitFor(() => page.rows()[0]?.textContent.includes('Beta'), 'sort by input desc')
check('sort by input desc', page.rows()[0].textContent.includes('Beta'))

// Spend is the eighth header and sorts independently of tokens.
page.headers()[7].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await waitFor(() => page.rows()[0]?.textContent.includes('Beta'), 'sort by spend desc')
check('sort by spend desc', page.rows()[0].textContent.includes('Beta') && page.rows()[0].textContent.includes('¥1.25'))
page.headers()[7].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await waitFor(() => page.rows()[0]?.textContent.includes('Gamma'), 'sort by spend asc')
check('sort by spend asc', page.rows()[0].textContent.includes('Gamma'))

// The history strip switches between spend and tokens.
const segButtons = Array.from(build.container.querySelectorAll('.tu-seg-btn'))
check('history defaults to spend', segButtons[0]?.getAttribute('data-active') === 'true')
segButtons[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await waitFor(() => segButtons[1].getAttribute('data-active') === 'true', 'history metric toggle')
check('history can switch to tokens', segButtons[1].getAttribute('data-active') === 'true')
segButtons[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await waitFor(() => segButtons[0].getAttribute('data-active') === 'true', 'history metric back')

// Chart forms and the peak/off-peak split.
const chartSeg = build.container.querySelectorAll('.tu-history-tools .tu-seg')[0]
const chartButtons = () => Array.from(chartSeg.querySelectorAll('.tu-seg-btn'))
check('history defaults to bars', build.container.querySelector('.tu-bars') !== null && build.container.querySelector('.tu-line') === null)
check('current pricing window badge', /^(峰时|谷时)/.test(build.container.querySelector('.tu-now-badge')?.textContent ?? ''),
  build.container.querySelector('.tu-now-badge')?.textContent ?? '')
check('pricing badge counts down to the next switch', /剩余/.test(build.container.querySelector('.tu-now-badge')?.textContent ?? ''))
check('spend bars split peak and valley', build.container.querySelectorAll('.tu-bar-seg').length === 28,
  String(build.container.querySelectorAll('.tu-bar-seg').length))
check('split legend names both windows', (build.container.querySelector('.tu-chart-legend')?.textContent ?? '').includes('谷时')
  && (build.container.querySelector('.tu-chart-legend')?.textContent ?? '').includes('峰时'))
const barLabels = Array.from(build.container.querySelectorAll('.tu-bar-value')).map((node) => node.textContent)
check('bar labels stay compact', barLabels.filter(Boolean).every((text) => /^¥\d+(\.\d{1,2})?$/.test(text)),
  barLabels.filter(Boolean).slice(0, 3).join(','))

chartButtons()[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await waitFor(() => build.container.querySelector('.tu-line') !== null, 'line chart')
check('line chart renders two series', build.container.querySelectorAll('.tu-line polyline').length === 2)

chartButtons()[2].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await waitFor(() => build.container.querySelector('.tu-pie') !== null, 'pie chart')
check('spend pie shows peak and valley', build.container.querySelectorAll('.tu-pie circle[stroke-dasharray]').length === 2,
  String(build.container.querySelectorAll('.tu-pie circle[stroke-dasharray]').length))

chartButtons()[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await waitFor(() => build.container.querySelector('.tu-bars') !== null, 'bars back')

// The history window is selectable and remembered in localStorage.
const bars = () => build.container.querySelectorAll('.tu-bar-col')
check('history defaults to 14 days', bars().length === 14, String(bars().length))
const historySelect = build.container.querySelector('.tu-select-sm')
setValue(window, historySelect, '7', 'change')
await waitFor(() => bars().length === 7, '7-day history window')
check('history window follows the select', bars().length === 7)
setValue(window, historySelect, '14', 'change')
await waitFor(() => bars().length === 14, '14-day history window')

// Search.
const input = build.container.querySelector('.tu-search')
setValue(window, input, 'Beta')
await waitFor(() => page.rows().length === 1, 'search filter')
check('search filters rows', page.rows().length === 1 && page.rows()[0].textContent.includes('Beta'))
setValue(window, input, '')
await waitFor(() => page.rows().length === 3, 'search reset')

// Time range: B has a ten-day-old bucket, so the 7-day window drops it.
const rangeSelect = build.container.querySelector('.tu-select')
setValue(window, rangeSelect, '7d', 'change')
await waitFor(() => build.container.querySelector('.tu-card-value')?.textContent === '¥1.70', '7-day window')
check('range window recomputes spend', build.container.querySelector('.tu-card-value')?.textContent === '¥1.70', build.container.querySelector('.tu-card-value')?.textContent ?? '')
check('range window recomputes tokens', build.container.querySelectorAll('.tu-card-value')[2]?.textContent === '860', build.container.querySelectorAll('.tu-card-value')[2]?.textContent ?? '')

// The 7-day window compares against the seven days before it: spend rose
// 0.50 → 1.70 (red), the cache hit rate rose 33.3% → 61.1% (green).
const spendTrend = cards()[0].querySelector('.tu-trend')
check('spend trend is up and red', spendTrend !== null
  && spendTrend.getAttribute('data-tone') === 'bad'
  && spendTrend.textContent.includes('▲')
  && spendTrend.textContent.includes('240%'), spendTrend?.textContent ?? 'none')
check('spend trend explains the comparison', (spendTrend?.getAttribute('title') ?? '').includes('较上一周期'))
const hitTrend = cards()[7].querySelector('.tu-trend')
check('hit-rate trend is up and green', hitTrend !== null
  && hitTrend.getAttribute('data-tone') === 'good'
  && hitTrend.textContent.includes('pp'), hitTrend?.textContent ?? 'none')
setValue(window, rangeSelect, 'today', 'change')
await waitFor(() => build.container.querySelector('.tu-card-value')?.textContent === '¥1.70', 'today window')
setValue(window, rangeSelect, 'all', 'change')
await waitFor(() => build.container.querySelector('.tu-card-value')?.textContent === '¥2.20', 'all-time window')
check('range returns to all time', build.container.querySelector('.tu-card-value')?.textContent === '¥2.20')

// Exports: session CSV, daily CSV, and the Markdown copy.
const exportButtons = Array.from(build.container.querySelectorAll('.tu-toolbar-export .tu-btn'))
check('export buttons render', exportButtons.length === 3)
const clickButton = (button) => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))

clickButton(exportButtons[0])
await waitFor(() => clicks.length === 1, 'session csv download')
const sessionCsvText = await downloads.at(-1).text()
const sessionBytes = new Uint8Array(await downloads.at(-1).arrayBuffer())
const sessionLines = sessionCsvText.split('\r\n').filter(Boolean)
check('session csv has a header and four rows', sessionLines.length === 5, String(sessionLines.length))
check('session csv starts with a UTF-8 BOM', sessionBytes[0] === 0xef && sessionBytes[1] === 0xbb && sessionBytes[2] === 0xbf, `${sessionBytes[0]},${sessionBytes[1]},${sessionBytes[2]}`)
check('session csv quotes commas and quotes', sessionCsvText.includes('"Alpha, ""quoted"" | 会话"'))
check('session csv names the money column', sessionLines[0].includes('花费 (¥)'), sessionLines[0])
check('session csv carries raw token counts', sessionCsvText.includes(',100,50,150,0,300,'), sessionLines[1])

clickButton(exportButtons[1])
await waitFor(() => clicks.length === 2, 'days csv download')
const daysAll = (await downloads.at(-1).text()).split('\r\n').filter(Boolean)
check('days csv covers every recorded day', daysAll.length === 3, String(daysAll.length))

setValue(window, rangeSelect, '7d', 'change')
await waitFor(() => build.container.querySelector('.tu-card-value')?.textContent === '¥1.70', 'range 7d for export')
clickButton(exportButtons[1])
await waitFor(() => clicks.length === 3, 'days csv for 7d')
const days7 = (await downloads.at(-1).text()).split('\r\n').filter(Boolean)
check('days csv follows the range', days7.length === 2, String(days7.length))
setValue(window, rangeSelect, 'all', 'change')
await waitFor(() => build.container.querySelector('.tu-card-value')?.textContent === '¥2.20', 'range back to all')

clickButton(exportButtons[2])
await waitFor(() => copied.length === 1, 'markdown clipboard')
check('markdown table starts with the header', copied[0].startsWith('| 会话 |'), copied[0].slice(0, 40))
check('markdown table escapes pipes', copied[0].includes('\\|'), copied[0].split('\n')[2])
check('markdown table has one row per session', copied[0].trim().split('\n').length === 6, String(copied[0].trim().split('\n').length))

// Zero-usage toggle.
const zeroToggle = build.container.querySelectorAll('.tu-toolbar-toggles .tu-btn')[0]
zeroToggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await waitFor(() => page.rows().length === 4, 'zero row shown')
check('zero-usage toggle shows the empty session', page.rows().length === 4)
zeroToggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await waitFor(() => page.rows().length === 3, 'zero row hidden')

// Row click opens the session; the Back button returns to the conversation.
const betaRow = page.rows().find((row) => row.textContent.includes('Beta'))
betaRow.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
check('row click opens the session', build.opened[0] === 'session-b', JSON.stringify(build.opened))
const back = Array.from(build.container.querySelectorAll('.tu-head-tools .tu-btn')).at(-1)
back.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
check('back button returns to chat', build.panels.at(-1) === null, JSON.stringify(build.panels))

// A 304 from the Host keeps the rendered table instead of clearing or erroring.
build.fetchState.notModified = true
const rowsBefore = page.rows().length
Array.from(build.container.querySelectorAll('.tu-head-tools .tu-btn'))[1]
  .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await new Promise((resolve) => setTimeout(resolve, 400))
check('a 304 keeps the current table', page.rows().length === rowsBefore && build.container.querySelector('.tu-state-title') === null,
  `${page.rows().length}/${rowsBefore}`)
page.unmount()

// ---------------------------------------------------------------------------
// Box grouping (read-only /session-boxes)
// ---------------------------------------------------------------------------

const boxesPayload = {
  ok: true,
  state: {
    boxes: [
      { id: 'b1', name: '项目 A', parentId: null, order: 0 },
      { id: 'b1c', name: '子盒 A1', parentId: 'b1', order: 1 },
      { id: 'b2', name: '项目 B', parentId: null, order: 2 },
    ],
    memberships: { 'session-a': ['b1c'], 'session-b': ['b1'], 'session-e': ['b1'], 'session-c': ['b2'] },
  },
}

const boxed = loadPlugin({ boxesPayload })
const boxedPage = mount(boxed)
await waitFor(() => boxedPage.rows().length === 3, 'boxed rows load')
const boxButtons = Array.from(boxed.container.querySelectorAll('.tu-toolbar-toggles .tu-seg .tu-seg-btn'))
check('box dimension appears when boxes load', boxButtons.length === 3, String(boxButtons.length))
boxButtons[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await waitFor(() => boxedPage.groups().length === 2, 'box groups')
check('box groups follow the box tree',
  boxedPage.groups()[0].textContent.includes('项目 A') && boxedPage.groups()[1].textContent.includes('项目 B'),
  boxedPage.groups().map((row) => row.textContent.slice(0, 12)).join('|'))
check('parent box includes child-box members', (boxedPage.groups()[0].textContent ?? '').includes('¥2.05'),
  boxedPage.groups()[0].textContent.slice(0, 90))
check('child box label rides the row', boxedPage.rows().some((row) => row.textContent.includes('项目 A / 子盒 A1')))

// Ungrouped sessions land in a trailing group.
boxed.container.querySelectorAll('.tu-toolbar-toggles .tu-btn')[0]
  .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await waitFor(() => boxedPage.groups().length === 3, 'ungrouped group')
check('ungrouped sits last', boxedPage.groups().at(-1).textContent.includes('未分组'), boxedPage.groups().map((row) => row.textContent.slice(0, 8)).join('|'))

// Exports carry the box column.
const clicksBefore = clicks.length
boxed.container.querySelectorAll('.tu-toolbar-export .tu-btn')[0]
  .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await waitFor(() => clicks.length > clicksBefore, 'boxed csv')
const boxedCsv = await downloads.at(-1).text()
check('csv carries the box column', boxedCsv.split('\r\n')[0].includes('盒子') && boxedCsv.includes('项目 A / 子盒 A1'))
const copiedBefore = copied.length
boxed.container.querySelectorAll('.tu-toolbar-export .tu-btn')[2]
  .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await waitFor(() => copied.length > copiedBefore, 'boxed markdown')
check('markdown carries the box column', copied.at(-1).includes('盒子') && copied.at(-1).includes('项目 A / 子盒 A1'))
boxedPage.unmount()

// Degradations: 404, malformed JSON, and a hanging route all fall back silently.
for (const mode of ['missing', 'bad', 'hang']) {
  const degraded = loadPlugin({ boxesMode: mode })
  const degradedPage = mount(degraded)
  await waitFor(() => degradedPage.rows().length === 3, `${mode} rows`)
  if (mode === 'hang') await new Promise((resolve) => setTimeout(resolve, 1700))
  const buttons = degraded.container.querySelectorAll('.tu-toolbar-toggles .tu-seg .tu-seg-btn')
  check(`${mode}: box dimension hidden and workspace grouping kept`,
    buttons.length === 2 && degradedPage.groups().length === 2 && degraded.container.querySelector('.tu-state-title') === null,
    `${buttons.length}/${degradedPage.groups().length}`)
  degradedPage.unmount()
}

// ---------------------------------------------------------------------------
// Error and empty states
// ---------------------------------------------------------------------------

const failing = loadPlugin({ fail: true })
const failingPage = mount(failing)
await waitFor(() => failingPage.container.textContent.includes('暂时无法读取 token 用量'), 'error state')
check('error state rendered', failingPage.container.textContent.includes('暂时无法读取 token 用量'))
failingPage.unmount()

const empty = loadPlugin({ data: { ok: true, sessions: [], totals: { total: 0, today: 0, sessions: 0 }, days: [] } })
const emptyPage = mount(empty)
await waitFor(() => emptyPage.container.textContent.includes('还没有记录任何会话'), 'empty state')
check('empty state rendered', emptyPage.container.textContent.includes('还没有记录任何会话'))
emptyPage.unmount()

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall DOM checks passed')
}
