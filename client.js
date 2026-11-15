/**
 * dsh-token-usage — browser half.
 *
 * Contributes one global panel: a dedicated page in the centre column that
 * shows the provider-reported token usage of every Session, live and
 * historical. It is a page, not an overlay: opening it replaces the
 * Conversation in the main slot (the sidebar row selects the panel), so
 * nothing is drawn on top of the chat and the page owns its own scrolling.
 *
 *  - a summary strip totals every Session, today included;
 *  - a 14-day strip charts the history by local calendar day;
 *  - a table lists every Session with sortable columns (click a header),
 *    search, and a live marker while its artifact keeps growing.
 *
 * Numbers come from the same-origin `/token-usage` route served by the Host
 * half; the page polls it every two seconds while visible.
 */
window.__ModuleLoader__.load({
  id: 'dsh-token-usage',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'token-usage'
    const PANEL_ID = 'token-usage'
    const ENDPOINT = '/token-usage'
    const POLL_MS = 2000
    const HISTORY_DAYS = 14
    const MAX_ROWS = 500

    /** Selectable summary/table windows; `null` keeps the whole lifetime. */
    const RANGE_OPTIONS = [
      { id: 'today', days: 1 },
      { id: '7d', days: 7 },
      { id: '30d', days: 30 },
      { id: 'all', days: null },
    ]

    /* ------------------------------------------------------------------ *
     * Dictionaries (English is the key-set source of truth)
     * ------------------------------------------------------------------ */

    const EN = {
      'panel': 'Token usage',
      'page.title': 'Token usage',
      'page.subtitle': 'Tokens billed by every session, live and historical',
      'page.back': 'Back to chat',
      'page.refresh': 'Refresh',
      'page.live': 'Live',
      'page.liveOn': 'Live updates on · pauses when this page is hidden',
      'page.liveOff': 'Live updates paused',
      'page.search': 'Search sessions, workspaces, models',
      'page.range': 'Time range',
      'page.group': 'Group by workspace',
      'range.today': 'Today',
      'range.7d': 'Last 7 days',
      'range.30d': 'Last 30 days',
      'range.all': 'All time',
      'group.meta': '{count} sessions · {total} tokens · {cost}',
      'row.child': 'sub-session',
      'row.children': '{count} sub-sessions · {cost}',
      'row.children.title': 'Expand or collapse sub-sessions',
      'page.updated': 'Updated {time}',
      'page.scanning': 'Scanning session logs…',
      'page.showZero': 'Show sessions without usage',
      'page.hideZero': 'Hide sessions without usage',
      'page.count': '{shown} of {total} sessions',
      'summary.total': 'Total tokens',
      'summary.today': 'Today',
      'summary.cost': 'Estimated spend',
      'summary.todayCost': 'Today spend',
      'summary.estimated': 'estimated from list prices',
      'summary.costNote': 'Estimated with DeepSeek CNY list prices, including peak windows; override rates in ~/.dsh/token-usage-prices.json',
      'summary.input': 'Input',
      'summary.output': 'Output',
      'summary.cacheRead': 'Cache read',
      'summary.cacheHit': 'Cache hit rate',
      'summary.sessions': '{count} sessions',
      'summary.localDay': 'local day',
      'summary.uncached': 'uncached prompt',
      'summary.generated': 'generated',
      'summary.reused': 'served from cache',
      'summary.ofPrompt': 'of prompt',
      'trend.new': 'new',
      'trend.window': 'vs previous period ({from} – {to})',
      'trend.recent': 'last {days} days vs the {days} before',
      'trend.yesterday': 'vs yesterday ({day})',
      'history.title': 'History',
      'history.subtitle': 'Last {days} days by local calendar day',
      'history.empty': 'No usage recorded yet',
      'history.day': '{day}',
      'history.metric.cost': 'Spend',
      'history.metric.tokens': 'Tokens',
      'history.metric.title': 'Switch what the history bars measure',
      'col.session': 'Session',
      'col.model': 'Model',
      'col.input': 'Input',
      'col.output': 'Output',
      'col.cacheRead': 'Cache read',
      'col.cacheWrite': 'Cache write',
      'col.total': 'Total',
      'col.cost': 'Spend',
      'col.hit': 'Cache hit',
      'col.last': 'Last active',
      'col.session.title': 'Session title and workspace; click to sort',
      'col.model.title': 'Provider model recorded by the latest request; click to sort',
      'col.input.title': 'Uncached prompt tokens; click to sort',
      'col.output.title': 'Generated tokens; click to sort',
      'col.cacheRead.title': 'Prompt tokens served from the provider cache; click to sort',
      'col.cacheWrite.title': 'Prompt tokens written into the provider cache; click to sort',
      'col.total.title': 'Input + output + cache read + cache write; click to sort',
      'col.cost.title': 'Estimated from the price table; click to sort',
      'col.hit.title': 'Cache read ÷ all prompt tokens; click to sort',
      'col.last.title': 'When this session log last changed; click to sort',
      'row.untitled': '(untitled)',
      'row.unknownModel': 'unknown model',
      'row.live': 'Running now',
      'row.open': 'Open this session',
      'row.more': '+{count} more sessions are hidden by search or the usage filter',
      'row.error': 'This session log could not be read completely',
      'time.justNow': 'just now',
      'time.minutes': '{n} min ago',
      'time.hours': '{n} h ago',
      'time.days': '{n} d ago',
      'state.loading': 'Loading token usage…',
      'state.empty': 'No sessions recorded yet',
      'state.emptyFiltered': 'No session matches the current filter',
      'state.error': 'Token usage is unavailable',
      'state.retry': 'Try again',
    }

    const ZH = {
      'panel': 'Token 用量',
      'page.title': 'Token 用量',
      'page.subtitle': '每个会话的实时与历史 token 消耗',
      'page.back': '返回对话',
      'page.refresh': '刷新',
      'page.live': '实时',
      'page.liveOn': '实时更新中 · 页面隐藏时自动暂停',
      'page.liveOff': '实时更新已暂停',
      'page.search': '搜索会话、工作区、模型',
      'page.range': '时间范围',
      'page.group': '按工作区分组',
      'range.today': '今天',
      'range.7d': '近 7 天',
      'range.30d': '近 30 天',
      'range.all': '全部时间',
      'group.meta': '{count} 个会话 · {total} tokens · {cost}',
      'row.child': '子会话',
      'row.children': '{count} 个子会话 · {cost}',
      'row.children.title': '展开或收起子会话',
      'page.updated': '更新于 {time}',
      'page.scanning': '正在扫描会话日志…',
      'page.showZero': '显示无消耗会话',
      'page.hideZero': '隐藏无消耗会话',
      'page.count': '共 {total} 个会话，显示 {shown} 个',
      'summary.total': '总 tokens',
      'summary.today': '今日',
      'summary.cost': '预估花费',
      'summary.todayCost': '今日花费',
      'summary.estimated': '按官方价目估算',
      'summary.costNote': '按 DeepSeek 官方人民币价目表（含峰谷时段）估算，仅供参照；可在 ~/.dsh/token-usage-prices.json 覆盖单价',
      'summary.input': '输入',
      'summary.output': '输出',
      'summary.cacheRead': '缓存读',
      'summary.cacheHit': '缓存命中率',
      'summary.sessions': '{count} 个会话',
      'summary.localDay': '按本地日期',
      'summary.uncached': '未命中缓存',
      'summary.generated': '模型生成',
      'summary.reused': '由缓存提供',
      'summary.ofPrompt': '占提示词',
      'trend.new': '新增',
      'trend.window': '较上一周期（{from} ~ {to}）',
      'trend.recent': '近 {days} 天较前 {days} 天',
      'trend.yesterday': '较昨日（{day}）',
      'history.title': '历史消耗',
      'history.subtitle': '最近 {days} 天，按本地日期统计',
      'history.empty': '还没有消耗记录',
      'history.day': '{day}',
      'history.metric.cost': '花费',
      'history.metric.tokens': 'tokens',
      'history.metric.title': '切换历史条的统计口径',
      'col.session': '会话',
      'col.model': '模型',
      'col.input': '输入',
      'col.output': '输出',
      'col.cacheRead': '缓存读',
      'col.cacheWrite': '缓存写',
      'col.total': '总计',
      'col.cost': '花费',
      'col.hit': '缓存命中',
      'col.last': '最后活动',
      'col.session.title': '会话标题与工作区；点击排序',
      'col.model.title': '最近一次请求记录的模型；点击排序',
      'col.input.title': '未命中缓存的提示词 token；点击排序',
      'col.output.title': '模型生成的 token；点击排序',
      'col.cacheRead.title': '由模型服务缓存提供的提示词 token；点击排序',
      'col.cacheWrite.title': '写入模型服务缓存的提示词 token；点击排序',
      'col.total.title': '输入 + 输出 + 缓存读 + 缓存写；点击排序',
      'col.cost.title': '按价目表估算的花费；点击排序',
      'col.hit.title': '缓存读 ÷ 全部提示词；点击排序',
      'col.last.title': '这个会话日志最后一次变化的时间；点击排序',
      'row.untitled': '（无标题）',
      'row.unknownModel': '未知模型',
      'row.live': '正在运行',
      'row.open': '打开这个会话',
      'row.more': '还有 {count} 个会话被搜索条件或用量筛选隐藏',
      'row.error': '这个会话日志未能完整读取',
      'time.justNow': '刚刚',
      'time.minutes': '{n} 分钟前',
      'time.hours': '{n} 小时前',
      'time.days': '{n} 天前',
      'state.loading': '正在读取 token 用量…',
      'state.empty': '还没有记录任何会话',
      'state.emptyFiltered': '没有会话符合当前筛选条件',
      'state.error': '暂时无法读取 token 用量',
      'state.retry': '重试',
    }

    const LOCALES = { zh: ZH, en: EN, ja: EN, es: EN, fr: EN, de: EN, ru: EN, pt: EN }

    /* ------------------------------------------------------------------ *
     * Styles — theme tokens only, every selector scoped under .tu
     * ------------------------------------------------------------------ */

    const CSS = `
.tu{box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;padding-top:var(--dsh-frame-top-clearance,0px)}
.tu *,.tu *:before,.tu *:after{box-sizing:border-box}
.tu-head{flex:none;display:flex;align-items:flex-start;gap:16px;padding:18px 28px 12px}
.tu-head-main{flex:1;min-width:0}
.tu-title{margin:0;font-size:20px;line-height:28px;font-weight:600;color:var(--dsw-alias-label-primary)}
.tu-sub{margin-top:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.tu-head-tools{flex:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.tu-btn{appearance:none;font:inherit;font-size:12px;line-height:18px;height:30px;padding:0 12px;border-radius:var(--dsw-radius-md,8px);border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.tu-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.tu-btn[data-active=true]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}
.tu-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.tu-ico{width:14px;height:14px;flex:none}
.tu-search{font:inherit;font-size:12px;line-height:18px;height:30px;width:230px;max-width:46vw;padding:0 10px;border-radius:var(--dsw-radius-md,8px);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);outline:none}
.tu-search::placeholder{color:var(--dsw-alias-label-tertiary)}
.tu-search:focus{border-color:var(--dsw-alias-state-business-primary)}
.tu-select{font:inherit;font-size:12px;height:30px;padding:0 8px;border-radius:var(--dsw-radius-md,8px);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer}
.tu-select:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.tu-group-row>td{padding:9px 12px;background:color-mix(in srgb, var(--dsw-alias-bg-layer-2) 60%, transparent);border-bottom:.5px solid var(--dsw-alias-border-l2)}
.tu-group-name{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
.tu-group-meta{margin-left:8px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.tu-chip{appearance:none;font:inherit;font-size:10px;line-height:14px;height:18px;padding:0 6px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;display:inline-flex;align-items:center;gap:3px;white-space:nowrap;flex:none}
.tu-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.tu-chip[data-open=true]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}
.tu-chip-muted{border-color:transparent;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);cursor:default}
.tu-row-child{background:color-mix(in srgb, var(--dsw-alias-bg-layer-2) 24%, transparent)}
.tu-row-child .tu-td-session{padding-left:26px}
.tu-row-child .tu-title-text{font-weight:400;color:var(--dsw-alias-label-secondary)}
.tu-scroll{flex:1;min-height:0;overflow:auto;padding:0 28px 36px;overscroll-behavior:contain}
.tu-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:10px;margin:4px 0 20px}
.tu-card{position:relative;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1);padding:12px 14px 14px;min-width:0}
.tu-card-label{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tu-card-value{margin-top:4px;font-size:22px;line-height:28px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.tu-card-value[data-accent=true]{color:var(--dsw-alias-state-business-primary)}
.tu-card-sub{margin-top:2px;font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:52px}
.tu-trend{position:absolute;right:10px;bottom:9px;display:inline-flex;align-items:center;gap:2px;height:16px;padding:0 5px;border-radius:999px;font-size:10px;line-height:16px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
.tu-trend-arrow{font-size:8px;line-height:8px}
.tu-trend[data-tone=good]{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)}
.tu-trend[data-tone=bad]{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent)}
.tu-trend[data-tone=neutral]{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2)}
.tu-section{margin:0 0 22px}
.tu-section-head{display:flex;align-items:baseline;gap:10px;margin:0 0 10px}
.tu-section-title{margin:0;font-size:14px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}
.tu-section-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.tu-seg{display:inline-flex;align-items:center;gap:2px;margin-left:auto;padding:2px;border-radius:999px;background:var(--dsw-alias-bg-layer-2)}
.tu-seg-btn{appearance:none;font:inherit;font-size:11px;line-height:16px;height:22px;padding:0 10px;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}
.tu-seg-btn:hover{color:var(--dsw-alias-label-primary)}
.tu-seg-btn[data-active=true]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 0 0 .5px var(--dsw-alias-border-l2)}
.tu-seg-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.tu-section-end{display:none}
.tu-toolbar{display:flex;align-items:center;gap:8px;justify-content:flex-end;margin:0 0 8px}
.tu-bars{display:flex;align-items:flex-end;gap:6px;padding:10px 12px 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1);overflow-x:auto}
.tu-bar-col{flex:1 1 0;min-width:34px;display:flex;flex-direction:column;align-items:center;gap:4px}
.tu-bar-value{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}
.tu-bar-track{width:100%;max-width:38px;height:56px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);display:flex;align-items:flex-end;overflow:hidden}
.tu-bar-fill{display:block;width:100%;border-radius:4px 4px 0 0;background:var(--dsw-alias-state-business-primary);opacity:.75;min-height:2px}
.tu-bar-col[data-today=true] .tu-bar-fill{opacity:1}
.tu-bar-col[data-today=true] .tu-bar-day{color:var(--dsw-alias-label-secondary);font-weight:600}
.tu-bar-day{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.tu-table-wrap{overflow-x:auto;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1)}
.tu-table{width:100%;border-collapse:separate;border-spacing:0;font-size:12px;line-height:18px}
.tu-th{background:var(--dsw-alias-bg-layer-1);border-bottom:.5px solid var(--dsw-alias-border-l2);padding:9px 10px;font-weight:500;color:var(--dsw-alias-label-secondary);text-align:left;white-space:nowrap;cursor:pointer;user-select:none}
.tu-th:hover{color:var(--dsw-alias-label-primary)}
.tu-th[data-active=true]{color:var(--dsw-alias-label-primary);font-weight:600}
.tu-th:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.tu-th-num{text-align:right}
.tu-th-inner{display:inline-flex;align-items:center;gap:4px}
.tu-th-num .tu-th-inner{justify-content:flex-end;width:100%}
.tu-sort{font-size:9px;line-height:10px;color:var(--dsw-alias-label-tertiary)}
.tu-th[data-active=true] .tu-sort{color:var(--dsw-alias-state-business-primary)}
.tu-td{padding:8px 10px;border-bottom:.5px solid var(--dsw-alias-border-l1);vertical-align:middle}
.tu-row:last-child .tu-td{border-bottom:none}
.tu-row{cursor:pointer}
.tu-row:hover .tu-td{background:var(--dsw-alias-interactive-bg-hover)}
.tu-row:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.tu-td-session{min-width:220px;max-width:420px}
.tu-title-line{display:flex;align-items:center;gap:6px;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;font-weight:500}
.tu-title-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tu-sub-line{margin-top:1px;font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tu-flag{color:var(--dsw-alias-state-warn-primary);cursor:help}
.tu-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:none;box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-success-primary) 22%, transparent)}
.tu-td-model{max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.tu-td-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.tu-td-total{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--dsw-alias-label-primary);font-weight:600}
.tu-td-cost{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--dsw-alias-label-primary);font-weight:600}
.tu-total-wrap{display:inline-flex;flex-direction:column;align-items:flex-end;gap:3px;min-width:74px}
.tu-meter{width:100%;height:3px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.tu-meter-fill{display:block;height:100%;border-radius:2px;background:var(--dsw-alias-state-business-primary);opacity:.85}
.tu-td-last{white-space:nowrap;color:var(--dsw-alias-label-tertiary)}
.tu-badge{display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 6px;border-radius:999px;font-size:10px;line-height:12px;background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent);color:var(--dsw-alias-state-success-primary)}
.tu-state{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:56px 16px;color:var(--dsw-alias-label-secondary);text-align:center}
.tu-state-title{font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary)}
.tu-state-detail{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);max-width:520px;word-break:break-word}
.tu-skeleton{width:min(520px,80%);height:8px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;position:relative}
.tu-skeleton:after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,var(--dsw-alias-interactive-bg-hover),transparent);animation:tu-shimmer 1.4s infinite}
@keyframes tu-shimmer{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
.tu-note{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary);padding:6px 2px 10px}
.tu-visually-hidden{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
@media (prefers-reduced-motion:reduce){.tu-skeleton:after{animation:none}}
@media (max-width:720px){.tu-head{padding:14px 16px 10px;flex-wrap:wrap}.tu-scroll{padding:0 16px 28px}.tu-search{width:100%;max-width:none}}
`

    /* ------------------------------------------------------------------ *
     * Formatting helpers
     * ------------------------------------------------------------------ */

    /** Compact token count for dense cells. */
    function formatTokens(value) {
      const number = Number(value)
      if (!Number.isFinite(number) || number <= 0) return '0'
      if (number < 1000) return String(Math.round(number))
      if (number < 10000) return `${(number / 1000).toFixed(1).replace(/\.0$/, '')}k`
      if (number < 1000000) return `${Math.round(number / 1000)}k`
      if (number < 10000000) return `${(number / 1000000).toFixed(2).replace(/\.?0+$/, '')}M`
      return `${(number / 1000000).toFixed(1).replace(/\.0$/, '')}M`
    }

    /** Exact count for hover titles and accessible labels. */
    function formatExact(value) {
      const number = Number(value)
      if (!Number.isFinite(number)) return '0'
      return Math.round(number).toLocaleString()
    }

    /** Percentage with a fixed decimal budget. */
    function formatPercent(ratio) {
      const value = Number(ratio)
      if (!Number.isFinite(value) || value <= 0) return '0%'
      const percent = value * 100
      if (percent < 0.1) return '<0.1%'
      return `${percent >= 10 ? percent.toFixed(0) : percent.toFixed(1)}%`
    }

    /** Money in the payload's currency, with enough decimals for small amounts. */
    function formatMoney(value, symbol) {
      const unit = typeof symbol === 'string' && symbol.length > 0 ? symbol : '¥'
      const number = Number(value)
      if (!Number.isFinite(number) || number <= 0) return `${unit}0`
      if (number < 1) return `${unit}${number.toFixed(3)}`
      if (number < 10000) return `${unit}${number.toFixed(2)}`
      return `${unit}${Math.round(number).toLocaleString()}`
    }

    /** Local calendar day key of one epoch millisecond value. */
    function dayKeyOf(time) {
      const date = new Date(time)
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      return `${date.getFullYear()}-${month}-${day}`
    }

    /** The last `count` local calendar days, oldest first, ending today. */
    function recentDayKeys(count) {
      const keys = []
      const today = new Date()
      for (let offset = count - 1; offset >= 0; offset -= 1) {
        const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset)
        const month = String(date.getMonth() + 1).padStart(2, '0')
        const day = String(date.getDate()).padStart(2, '0')
        keys.push({ key: `${date.getFullYear()}-${month}-${day}`, date })
      }
      return keys
    }

    /** Day key where a selected range starts; null keeps the whole lifetime. */
    function rangeStartKey(rangeId) {
      const option = RANGE_OPTIONS.find((item) => item.id === rangeId) ?? RANGE_OPTIONS[RANGE_OPTIONS.length - 1]
      if (option.days === null) return null
      const today = new Date()
      const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (option.days - 1))
      const month = String(start.getMonth() + 1).padStart(2, '0')
      const day = String(start.getDate()).padStart(2, '0')
      return `${start.getFullYear()}-${month}-${day}`
    }

    /** Recompute one Session's usage inside a window, from its own day buckets. */
    function windowSession(session, startKey) {
      if (startKey === null) return session
      let input = 0
      let output = 0
      let cacheRead = 0
      let cacheWrite = 0
      let cost = 0
      for (const day of Array.isArray(session.days) ? session.days : []) {
        if (typeof day?.day !== 'string' || day.day < startKey) continue
        input += Number(day.input) || 0
        output += Number(day.output) || 0
        cacheRead += Number(day.cacheRead) || 0
        cacheWrite += Number(day.cacheWrite) || 0
        cost += Number(day.cost) || 0
      }
      const total = input + output + cacheRead + cacheWrite
      const prompt = input + cacheRead + cacheWrite
      return {
        ...session,
        input,
        output,
        cacheRead,
        cacheWrite,
        total,
        cost,
        prompt,
        cacheHitRate: prompt > 0 ? cacheRead / prompt : 0,
      }
    }

    /** Day key shifted by a signed offset from today. */
    function shiftDayKey(offset) {
      const today = new Date()
      const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset)
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      return `${date.getFullYear()}-${month}-${day}`
    }

    /** Aggregate the global day rows over an inclusive day-key window. */
    function statsBetween(dayRows, startKey, endKey) {
      const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, prompt: 0, hitRate: 0 }
      for (const row of Array.isArray(dayRows) ? dayRows : []) {
        if (typeof row?.day !== 'string' || row.day < startKey || row.day > endKey) continue
        totals.input += Number(row.input) || 0
        totals.output += Number(row.output) || 0
        totals.cacheRead += Number(row.cacheRead) || 0
        totals.cacheWrite += Number(row.cacheWrite) || 0
        totals.cost += Number(row.cost) || 0
      }
      totals.total = totals.input + totals.output + totals.cacheRead + totals.cacheWrite
      totals.prompt = totals.input + totals.cacheRead + totals.cacheWrite
      totals.hitRate = totals.prompt > 0 ? totals.cacheRead / totals.prompt : 0
      return totals
    }

    /**
     * Period-over-period change for a count.
     * `higherIsBetter` decides the colour: spending more is red, a higher cache
     * hit rate is green.
     */
    function percentTrend(current, previous, higherIsBetter, title) {
      const now = Number(current) || 0
      const before = Number(previous) || 0
      if (before === 0 && now === 0) return null
      if (before === 0) return { direction: 'new', tone: higherIsBetter ? 'good' : 'bad', title }
      const percent = Math.abs((now - before) / before) * 100
      if (percent < 0.1) return { direction: 'flat', tone: 'neutral', label: '0%', title }
      const rising = now > before
      return {
        direction: rising ? 'up' : 'down',
        tone: higherIsBetter === rising ? 'good' : 'bad',
        label: `${percent >= 10 ? String(Math.round(percent)) : percent.toFixed(1)}%`,
        title,
      }
    }

    /** Percentage-point change for a rate such as the cache hit rate. */
    function pointTrend(current, previous, title) {
      const now = Number(current) || 0
      const before = Number(previous) || 0
      if (now === 0 && before === 0) return null
      const delta = (now - before) * 100
      if (Math.abs(delta) < 0.1) return { direction: 'flat', tone: 'neutral', label: '0pp', title }
      const rising = delta > 0
      return {
        direction: rising ? 'up' : 'down',
        tone: rising ? 'good' : 'bad',
        label: `${Math.abs(delta).toFixed(1)}pp`,
        title,
      }
    }

    /** Short month-day label for the history strip. */
    function formatDayLabel(date) {
      return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    }

    /** Relative activity label with a coarser fallback past a week. */    function relativeTime(time, now, t) {
      if (!Number.isFinite(time)) return '—'
      const delta = Math.max(0, now - time)
      if (delta < 60 * 1000) return t('time.justNow')
      if (delta < 60 * 60 * 1000) return t('time.minutes', { n: Math.floor(delta / 60000) })
      if (delta < 24 * 60 * 60 * 1000) return t('time.hours', { n: Math.floor(delta / 3600000) })
      if (delta < 7 * 24 * 60 * 60 * 1000) return t('time.days', { n: Math.floor(delta / 86400000) })
      return new Date(time).toLocaleDateString()
    }

    /* ------------------------------------------------------------------ *
     * Data hooks
     * ------------------------------------------------------------------ */

    /** Subscribe to locale revisions so translated copy re-renders on switch. */
    function useLocaleRevision(locale) {
      const [revision, setRevision] = useState(0)
      useEffect(() => {
        if (locale === undefined || typeof locale.subscribe !== 'function') return undefined
        return locale.subscribe(() => setRevision((value) => value + 1))
      }, [locale])
      return revision
    }

    /** A clock for relative timestamps. */
    function useNow(intervalMs) {
      const [now, setNow] = useState(() => Date.now())
      useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
        return () => window.clearInterval(timer)
      }, [intervalMs])
      return now
    }

    /**
     * Poll the Host route.
     * @param options.live - re-fetch on the interval while the document is visible.
     * @param options.revision - bump to force an immediate fetch.
     */
    function useUsageData(options) {
      const { live, revision } = options
      const [state, setState] = useState({ status: 'loading', data: null, error: null, fetchedAt: 0 })
      const [forced, setForced] = useState(0)
      const timer = useRef(null)

      useEffect(() => {
        let cancelled = false
        const schedule = () => {
          if (cancelled || !live) return
          timer.current = window.setTimeout(() => void load(), POLL_MS)
        }
        const load = async () => {
          if (document.visibilityState === 'hidden') {
            schedule()
            return
          }
          try {
            const response = await fetch(ENDPOINT, {
              cache: 'no-store',
              headers: { accept: 'application/json' },
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const body = await response.json()
            if (body === null || typeof body !== 'object' || body.ok === false) {
              throw new Error(body?.error ?? 'request rejected')
            }
            if (!cancelled) setState({ status: 'ready', data: body, error: null, fetchedAt: Date.now() })
          } catch (error) {
            if (!cancelled) {
              setState((previous) => ({
                ...previous,
                status: previous.data === null ? 'error' : 'ready',
                error: String(error?.message ?? error),
              }))
            }
          } finally {
            schedule()
          }
        }
        void load()
        return () => {
          cancelled = true
          if (timer.current !== null) window.clearTimeout(timer.current)
          timer.current = null
        }
      }, [live, revision, forced])

      // Resume promptly when the tab becomes visible again.
      useEffect(() => {
        const onVisible = () => {
          if (document.visibilityState === 'visible') setForced((value) => value + 1)
        }
        document.addEventListener('visibilitychange', onVisible)
        return () => document.removeEventListener('visibilitychange', onVisible)
      }, [])

      const refresh = useCallback(() => setForced((value) => value + 1), [])
      return { ...state, refresh }
    }

    /* ------------------------------------------------------------------ *
     * Components
     * ------------------------------------------------------------------ */

    function IconRefresh({ className }) {
      return h('svg', { className, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M13.2 8a5.2 5.2 0 1 1-1.6-3.7', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('path', { d: 'M13 2.4v3.2H9.8', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    function IconBack({ className }) {
      return h('svg', { className, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M9.8 3.4 5.2 8l4.6 4.6', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    function IconPulse({ className }) {
      return h('svg', { className, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M1.6 8.4h2.9l1.7-4.6 3 9.2 1.6-4.6h3.6', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    /** Sidebar glyph: three ascending bars over a baseline. */
    function PanelIcon({ size = 18 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
      },
      h('path', { d: 'M2.6 13.2h10.8', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
      h('path', { d: 'M4.4 13V9.6M8 13V6.2M11.6 13V3.4', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }))
    }

    /** One summary card. */
    function SummaryCard({ label, value, sub, accent, title, trend, t }) {
      const glyph = trend === undefined || trend === null
        ? null
        : trend.direction === 'up' ? '▲' : trend.direction === 'down' ? '▼' : '→'
      return h('div', { className: 'tu-card', title },
        h('div', { className: 'tu-card-label' }, label),
        h('div', { className: 'tu-card-value', 'data-accent': accent === true ? 'true' : undefined }, value),
        sub === undefined ? null : h('div', { className: 'tu-card-sub' }, sub),
        trend === undefined || trend === null
          ? null
          : h('span', {
            className: 'tu-trend',
            'data-tone': trend.tone,
            'data-direction': trend.direction,
            title: trend.title,
            'aria-label': trend.title,
          },
          h('span', { className: 'tu-trend-arrow', 'aria-hidden': 'true' }, glyph),
          h('span', null, trend.direction === 'new' ? t('trend.new') : trend.label)))
    }

    /** Summary strip over every Session, with period-over-period badges. */
    function SummaryStrip({ summary, today, t, symbol, rangeLabel, windowStats, todayStats, windowTitle, todayTitle }) {
      const totals = summary
      const sessions = Number(totals.sessions) || 0
      const cacheRead = Number(totals.cacheRead) || 0
      const prompt = (Number(totals.input) || 0) + cacheRead + (Number(totals.cacheWrite) || 0)
      const windowMoney = (key) => windowStats === null
        ? null
        : percentTrend(
          windowStats.current[key],
          windowStats.previous[key],
          false,
          `${windowTitle}：${formatMoney(windowStats.previous[key], symbol)} → ${formatMoney(windowStats.current[key], symbol)}`,
        )
      const windowTokens = (key) => windowStats === null
        ? null
        : percentTrend(
          windowStats.current[key],
          windowStats.previous[key],
          false,
          `${windowTitle}：${formatExact(windowStats.previous[key])} → ${formatExact(windowStats.current[key])} tokens`,
        )
      const todayMoney = percentTrend(
        todayStats.current.cost,
        todayStats.previous.cost,
        false,
        `${todayTitle}：${formatMoney(todayStats.previous.cost, symbol)} → ${formatMoney(todayStats.current.cost, symbol)}`,
      )
      const todayTokens = percentTrend(
        todayStats.current.total,
        todayStats.previous.total,
        false,
        `${todayTitle}：${formatExact(todayStats.previous.total)} → ${formatExact(todayStats.current.total)} tokens`,
      )
      const hitTrend = windowStats === null
        ? null
        : pointTrend(
          windowStats.current.hitRate,
          windowStats.previous.hitRate,
          `${windowTitle}：${formatPercent(windowStats.previous.hitRate)} → ${formatPercent(windowStats.current.hitRate)}`,
        )
      return h('div', { className: 'tu-summary' },
        h(SummaryCard, {
          label: t('summary.cost'),
          value: formatMoney(totals.cost, symbol),
          sub: rangeLabel,
          accent: true,
          title: t('summary.costNote'),
          trend: windowMoney('cost'),
          t,
        }),
        h(SummaryCard, {
          label: t('summary.todayCost'),
          value: formatMoney(today.cost, symbol),
          sub: t('summary.localDay'),
          title: t('summary.costNote'),
          trend: todayMoney,
          t,
        }),
        h(SummaryCard, {
          label: t('summary.total'),
          value: formatTokens(totals.total),
          sub: t('summary.sessions', { count: sessions }),
          title: `${formatExact(totals.total)} tokens`,
          trend: windowTokens('total'),
          t,
        }),
        h(SummaryCard, {
          label: t('summary.today'),
          value: formatTokens(today.tokens),
          sub: t('summary.localDay'),
          title: `${formatExact(today.tokens)} tokens`,
          trend: todayTokens,
          t,
        }),
        h(SummaryCard, {
          label: t('summary.input'),
          value: formatTokens(totals.input),
          sub: t('summary.uncached'),
          title: `${formatExact(totals.input)} tokens`,
          trend: windowTokens('input'),
          t,
        }),
        h(SummaryCard, {
          label: t('summary.output'),
          value: formatTokens(totals.output),
          sub: t('summary.generated'),
          title: `${formatExact(totals.output)} tokens`,
          trend: windowTokens('output'),
          t,
        }),
        h(SummaryCard, {
          label: t('summary.cacheRead'),
          value: formatTokens(cacheRead),
          sub: t('summary.reused'),
          title: `${formatExact(cacheRead)} tokens`,
          trend: windowTokens('cacheRead'),
          t,
        }),
        h(SummaryCard, {
          label: t('summary.cacheHit'),
          value: formatPercent(prompt > 0 ? cacheRead / prompt : 0),
          sub: t('summary.ofPrompt'),
          trend: hitTrend,
          t,
        }))
    }

    /** Fourteen local days of total usage. */
    function HistoryStrip({ data, t, now }) {
      const [metric, setMetric] = useState('cost')
      const symbol = data?.pricing?.symbol
      const byDay = useMemo(() => {
        const map = new Map()
        for (const row of Array.isArray(data?.days) ? data.days : []) {
          if (typeof row?.day === 'string') map.set(row.day, row)
        }
        return map
      }, [data])
      const days = useMemo(() => recentDayKeys(HISTORY_DAYS), [now])
      const rows = days.map(({ key, date }) => {
        const bucket = byDay.get(key)
        return {
          key,
          date,
          total: Number(bucket?.total) || 0,
          input: Number(bucket?.input) || 0,
          output: Number(bucket?.output) || 0,
          cacheRead: Number(bucket?.cacheRead) || 0,
          cacheWrite: Number(bucket?.cacheWrite) || 0,
          cost: Number(bucket?.cost) || 0,
        }
      })
      const field = metric === 'cost' ? 'cost' : 'total'
      const max = rows.reduce((peak, row) => Math.max(peak, row[field]), 0)
      const todayKey = dayKeyOf(Date.now())
      const hasAny = rows.some((row) => row[field] > 0)
      return h('section', { className: 'tu-section' },
        h('div', { className: 'tu-section-head' },
          h('h2', { className: 'tu-section-title' }, t('history.title')),
          h('span', { className: 'tu-section-sub' }, t('history.subtitle', { days: HISTORY_DAYS })),
          h('div', { className: 'tu-seg', title: t('history.metric.title'), role: 'group' },
            h('button', {
              type: 'button',
              className: 'tu-seg-btn',
              'data-active': metric === 'cost' ? 'true' : undefined,
              'aria-pressed': metric === 'cost',
              onClick: () => setMetric('cost'),
            }, t('history.metric.cost')),
            h('button', {
              type: 'button',
              className: 'tu-seg-btn',
              'data-active': metric === 'tokens' ? 'true' : undefined,
              'aria-pressed': metric === 'tokens',
              onClick: () => setMetric('tokens'),
            }, t('history.metric.tokens')))),
        hasAny
          ? h('div', { className: 'tu-bars' }, rows.map((row) => {
            const ratio = max > 0 ? row[field] / max : 0
            const title = `${row.key}\n${formatExact(row.total)} tokens\n${t('summary.input')} ${formatExact(row.input)} · ${t('summary.output')} ${formatExact(row.output)}\n${t('summary.cacheRead')} ${formatExact(row.cacheRead)} · ${t('col.cacheWrite')} ${formatExact(row.cacheWrite)}\n${t('col.cost')} ${formatMoney(row.cost, symbol)}`
            return h('div', {
              key: row.key,
              className: 'tu-bar-col',
              'data-today': row.key === todayKey ? 'true' : undefined,
              title,
            },
            h('span', { className: 'tu-bar-value' }, metric === 'cost' ? formatMoney(row.cost, symbol) : formatTokens(row.total)),
            h('span', { className: 'tu-bar-track' },
              h('i', {
                className: 'tu-bar-fill',
                style: { height: row[field] > 0 ? `${Math.max(4, Math.round(ratio * 100))}%` : '2px' },
              })),
            h('span', { className: 'tu-bar-day' }, formatDayLabel(row.date)))
          }))
          : h('div', { className: 'tu-state' }, h('div', { className: 'tu-state-detail' }, t('history.empty'))))
    }

    /** Sort indicator for one header. */
    function SortGlyph({ active, direction }) {
      if (!active) return h('span', { className: 'tu-sort', 'aria-hidden': 'true' }, '↕')
      return h('span', { className: 'tu-sort', 'aria-hidden': 'true' }, direction === 'asc' ? '↑' : '↓')
    }

    /** Header cell bound to one sort key. */
    function SortableHeader({ column, label, sort, onSort, numeric, title }) {
      const active = sort.key === column
      return h('th', {
        className: numeric ? 'tu-th tu-th-num' : 'tu-th',
        'data-active': active ? 'true' : undefined,
        scope: 'col',
        tabIndex: 0,
        role: 'columnheader',
        'aria-sort': active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none',
        title,
        onClick: () => onSort(column),
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onSort(column)
          }
        },
      },
      h('span', { className: 'tu-th-inner' },
        h('span', null, label),
        h(SortGlyph, { active, direction: sort.direction })))
    }

    /** One Session row. */
    function SessionRow({ row, now, onOpen, t, peak, symbol, depth = 0, childCount = 0, childCost = 0, expanded = false, onToggleChildren }) {
      const total = Number(row.total) || 0
      const prompt = (Number(row.input) || 0) + (Number(row.cacheRead) || 0) + (Number(row.cacheWrite) || 0)
      const ratio = peak > 0 ? total / peak : 0
      const open = () => {
        if (typeof onOpen === 'function') onOpen(row.sessionId)
      }
      return h('tr', {
        className: depth > 0 ? 'tu-row tu-row-child' : 'tu-row',
        tabIndex: 0,
        title: t('row.open'),
        onClick: open,
        onKeyDown: (event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            open()
          }
        },
      },
      h('td', { className: 'tu-td tu-td-session' },
        h('div', { className: 'tu-title-line' },
          row.live === true ? h('span', { className: 'tu-dot', title: t('row.live') }) : null,
          depth > 0 ? h('span', { className: 'tu-chip tu-chip-muted' }, t('row.child')) : null,
          h('span', { className: 'tu-title-text' }, row.displayTitle),
          row.live === true ? h('span', { className: 'tu-badge' }, t('row.live')) : null,
          childCount > 0
            ? h('button', {
              type: 'button',
              className: 'tu-chip',
              'data-open': expanded ? 'true' : undefined,
              'aria-expanded': expanded,
              title: t('row.children.title'),
              onClick: (event) => {
                event.stopPropagation()
                if (typeof onToggleChildren === 'function') onToggleChildren()
              },
              onKeyDown: (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.stopPropagation()
                  event.preventDefault()
                  if (typeof onToggleChildren === 'function') onToggleChildren()
                }
              },
            }, t('row.children', { count: childCount, cost: formatMoney(childCost, symbol) }))
            : null),
        h('div', { className: 'tu-sub-line', title: row.workspace?.path ?? '' },
          row.workspace?.name ?? '—',
          row.error ? h('span', { className: 'tu-flag', title: row.error }, ' · !') : null)),
      h('td', { className: 'tu-td tu-td-model', title: row.model ?? '' }, row.model ?? t('row.unknownModel')),
      h('td', { className: 'tu-td tu-td-num', title: formatExact(row.input) }, formatTokens(row.input)),
      h('td', { className: 'tu-td tu-td-num', title: formatExact(row.output) }, formatTokens(row.output)),
      h('td', { className: 'tu-td tu-td-num', title: formatExact(row.cacheRead) }, formatTokens(row.cacheRead)),
      h('td', { className: 'tu-td tu-td-num', title: formatExact(row.cacheWrite) }, formatTokens(row.cacheWrite)),
      h('td', { className: 'tu-td tu-td-total', title: `${formatExact(total)} tokens` },
        h('span', { className: 'tu-total-wrap' },
          h('span', null, formatTokens(total)),
          h('span', { className: 'tu-meter' },
            h('i', { className: 'tu-meter-fill', style: { width: `${Math.max(2, Math.round(ratio * 100))}%` } })))),
      h('td', { className: 'tu-td tu-td-cost', title: formatMoney(row.cost, symbol) }, formatMoney(row.cost, symbol)),
      h('td', { className: 'tu-td tu-td-num', title: formatPercent(prompt > 0 ? (Number(row.cacheRead) || 0) / prompt : 0) },
        formatPercent(prompt > 0 ? (Number(row.cacheRead) || 0) / prompt : 0)),
      h('td', { className: 'tu-td tu-td-last', title: Number.isFinite(row.lastActivityAt) ? new Date(row.lastActivityAt).toLocaleString() : '' },
        relativeTime(row.lastActivityAt, now, t)))
    }

    /** The sortable Session table. */
    function SessionTable({ rows, hiddenCount, sort, onSort, now, onOpen, t, symbol, grouped, expanded, onToggleChildren }) {
      const peak = rows.reduce((value, row) => Math.max(value, Number(row.total) || 0), 0)
      /** Grouped rows plus each group's subtotal. */
      const groups = useMemo(() => {
        if (!grouped) {
          return [{
            key: '*',
            name: null,
            rows,
            cost: rows.reduce((sum, row) => sum + (Number(row.cost) || 0), 0),
            total: rows.reduce((sum, row) => sum + (Number(row.total) || 0), 0),
          }]
        }
        const map = new Map()
        for (const row of rows) {
          const key = row.workspace?.path ?? row.workspace?.name ?? '—'
          let group = map.get(key)
          if (group === undefined) {
            group = { key, name: row.workspace?.name ?? key, rows: [], cost: 0, total: 0 }
            map.set(key, group)
          }
          group.rows.push(row)
          group.cost += Number(row.cost) || 0
          group.total += Number(row.total) || 0
        }
        return [...map.values()].sort((left, right) => right.cost - left.cost || String(left.name).localeCompare(String(right.name)))
      }, [rows, grouped])

      /** One group's rows, with sub-sessions nested under their parent. */
      const renderGroupRows = (group) => {
        const byId = new Map(group.rows.map((row) => [row.sessionId, row]))
        const nested = new Map()
        const tops = []
        for (const row of group.rows) {
          if (row.origin === 'subagent' && typeof row.parentSession === 'string' && byId.has(row.parentSession)) {
            const list = nested.get(row.parentSession) ?? []
            list.push(row)
            nested.set(row.parentSession, list)
          } else {
            tops.push(row)
          }
        }
        const output = []
        for (const row of tops) {
          const children = nested.get(row.sessionId) ?? []
          const open = expanded instanceof Set ? expanded.has(row.sessionId) : false
          output.push(h(SessionRow, {
            key: row.sessionId,
            row,
            now,
            onOpen,
            t,
            peak,
            symbol,
            depth: 0,
            childCount: children.length,
            childCost: children.reduce((sum, child) => sum + (Number(child.cost) || 0), 0),
            expanded: open,
            onToggleChildren: children.length > 0 ? () => onToggleChildren(row.sessionId) : undefined,
          }))
          if (open) {
            for (const child of children) {
              output.push(h(SessionRow, {
                key: child.sessionId,
                row: child,
                now,
                onOpen,
                t,
                peak,
                symbol,
                depth: 1,
              }))
            }
          }
        }
        return output
      }
      return h('section', { className: 'tu-section' },
        h('div', { className: 'tu-section-head' },
          h('h2', { className: 'tu-section-title' }, t('col.session')),
          h('span', { className: 'tu-section-sub' }, t('page.count', { shown: rows.length, total: rows.length + hiddenCount }))),
        rows.length === 0
          ? h('div', { className: 'tu-state' }, h('div', { className: 'tu-state-title' }, t('state.emptyFiltered')))
          : h('div', { className: 'tu-table-wrap' },
            h('table', { className: 'tu-table' },
              h('thead', null,
                h('tr', null,
                  h(SortableHeader, { column: 'title', label: t('col.session'), sort, onSort, title: t('col.session.title') }),
                  h(SortableHeader, { column: 'model', label: t('col.model'), sort, onSort, title: t('col.model.title') }),
                  h(SortableHeader, { column: 'input', label: t('col.input'), sort, onSort, numeric: true, title: t('col.input.title') }),
                  h(SortableHeader, { column: 'output', label: t('col.output'), sort, onSort, numeric: true, title: t('col.output.title') }),
                  h(SortableHeader, { column: 'cacheRead', label: t('col.cacheRead'), sort, onSort, numeric: true, title: t('col.cacheRead.title') }),
                  h(SortableHeader, { column: 'cacheWrite', label: t('col.cacheWrite'), sort, onSort, numeric: true, title: t('col.cacheWrite.title') }),
                  h(SortableHeader, { column: 'total', label: t('col.total'), sort, onSort, numeric: true, title: t('col.total.title') }),
                  h(SortableHeader, { column: 'cost', label: t('col.cost'), sort, onSort, numeric: true, title: t('col.cost.title') }),
                  h(SortableHeader, { column: 'hit', label: t('col.hit'), sort, onSort, numeric: true, title: t('col.hit.title') }),
                  h(SortableHeader, { column: 'lastActivityAt', label: t('col.last'), sort, onSort, numeric: true, title: t('col.last.title') }))),
              groups.map((group) => h('tbody', { key: group.key, className: 'tu-group' },
                group.name === null
                  ? null
                  : h('tr', { className: 'tu-group-row' },
                    h('td', { colSpan: 10 },
                      h('span', { className: 'tu-group-name' }, group.name),
                      h('span', { className: 'tu-group-meta' }, t('group.meta', {
                        count: group.rows.length,
                        total: formatTokens(group.total),
                        cost: formatMoney(group.cost, symbol),
                      })))),
                renderGroupRows(group))))),
        hiddenCount > 0 ? h('div', { className: 'tu-note' }, t('row.more', { count: hiddenCount })) : null)
    }

    /** Numeric value of one sortable column. */
    function numericValue(row, key) {
      if (key === 'hit') {
        const prompt = (Number(row.input) || 0) + (Number(row.cacheRead) || 0) + (Number(row.cacheWrite) || 0)
        return prompt > 0 ? (Number(row.cacheRead) || 0) / prompt : 0
      }
      return Number(row[key]) || 0
    }

    /** Comparator for the active sort. */
    function compareRows(left, right, sort) {
      const direction = sort.direction === 'asc' ? 1 : -1
      if (sort.key === 'title' || sort.key === 'model') {
        const leftText = sort.key === 'title' ? left.displayTitle : (left.model ?? '')
        const rightText = sort.key === 'title' ? right.displayTitle : (right.model ?? '')
        const compared = String(leftText).localeCompare(String(rightText))
        return compared * direction
      }
      const delta = numericValue(left, sort.key) - numericValue(right, sort.key)
      if (delta !== 0) return delta * direction
      return (Number(right.total) || 0) - (Number(left.total) || 0)
    }

    /** The page itself. */
    function TokenUsagePage(props) {
      const { ctx } = props
      const locale = ctx.locale ?? ctx.get('locale')
      useLocaleRevision(locale)
      const t = locale.bind(NS)

      const [live, setLive] = useState(true)
      const [query, setQuery] = useState('')
      const [showZero, setShowZero] = useState(false)
      const [range, setRange] = useState('all')
      const [grouped, setGrouped] = useState(true)
      const [expanded, setExpanded] = useState(() => new Set())
      const [sort, setSort] = useState({ key: 'total', direction: 'desc' })
      const now = useNow(30000)
      const { status, data, error, fetchedAt, refresh } = useUsageData({ live, revision: 0 })

      const openSession = useCallback((sessionId) => {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return
        try {
          const workspace = ctx.get('uiWorkspace')
          if (workspace !== undefined && typeof workspace.openSession === 'function') workspace.openSession(sessionId)
        } catch (failure) {
          console.warn('[token-usage] could not open session:', failure)
        }
      }, [ctx])

      const onSort = useCallback((key) => {
        setSort((previous) => {
          if (previous.key === key) return { key, direction: previous.direction === 'asc' ? 'desc' : 'asc' }
          const text = key === 'title' || key === 'model'
          return { key, direction: text ? 'asc' : 'desc' }
        })
      }, [])

      const allRows = useMemo(() => {
        const list = Array.isArray(data?.sessions) ? data.sessions : []
        return list.map((session) => ({
          ...session,
          displayTitle: typeof session.title === 'string' && session.title.trim().length > 0 ? session.title.trim() : t('row.untitled'),
        }))
      }, [data, t])

      // The selected window rewrites each session's usage from its own day buckets.
      const startKey = useMemo(() => rangeStartKey(range), [range])
      const rangedRows = useMemo(
        () => allRows.map((row) => windowSession(row, startKey)),
        [allRows, startKey],
      )
      const summary = useMemo(() => {
        const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, total: 0, sessions: 0 }
        for (const row of rangedRows) {
          totals.input += Number(row.input) || 0
          totals.output += Number(row.output) || 0
          totals.cacheRead += Number(row.cacheRead) || 0
          totals.cacheWrite += Number(row.cacheWrite) || 0
          totals.cost += Number(row.cost) || 0
          totals.total += Number(row.total) || 0
          if ((Number(row.total) || 0) > 0) totals.sessions += 1
        }
        return totals
      }, [rangedRows])
      const today = useMemo(() => ({
        tokens: Number(data?.totals?.today) || 0,
        cost: Number(data?.totals?.todayCost) || 0,
      }), [data])
      const rangeLabel = t(`range.${range}`)

      const dayRows = data?.days
      const todayKey = shiftDayKey(0)
      const rangeDays = RANGE_OPTIONS.find((option) => option.id === range)?.days ?? null
      // Every badge compares one window with the window before it. "All time"
      // keeps the lifetime totals and compares the latest seven days.
      const trendDays = rangeDays ?? 7
      const windowStats = useMemo(() => ({
        current: statsBetween(dayRows, shiftDayKey(-(trendDays - 1)), todayKey),
        previous: statsBetween(dayRows, shiftDayKey(-(2 * trendDays - 1)), shiftDayKey(-trendDays)),
      }), [trendDays, todayKey, dayRows])
      const todayStats = useMemo(() => ({
        current: statsBetween(dayRows, todayKey, todayKey),
        previous: statsBetween(dayRows, shiftDayKey(-1), shiftDayKey(-1)),
      }), [dayRows, todayKey])
      const windowTitle = rangeDays === null
        ? t('trend.recent', { days: trendDays })
        : t('trend.window', {
          from: shiftDayKey(-(2 * trendDays - 1)).slice(5),
          to: shiftDayKey(-trendDays).slice(5),
        })
      const todayTitle = t('trend.yesterday', { day: shiftDayKey(-1).slice(5) })

      const needle = query.trim().toLowerCase()
      const matched = useMemo(() => {
        if (needle.length === 0) return rangedRows
        return rangedRows.filter((row) => {
          const haystack = [
            row.displayTitle,
            row.workspace?.name,
            row.workspace?.path,
            row.model,
            row.provider,
            row.preset,
            row.sessionId,
          ]
          return haystack.some((value) => typeof value === 'string' && value.toLowerCase().includes(needle))
        })
      }, [rangedRows, needle])

      const visible = useMemo(() => matched.filter((row) => showZero || (Number(row.total) || 0) > 0), [matched, showZero])
      const sorted = useMemo(() => [...visible].sort((left, right) => compareRows(left, right, sort)), [visible, sort])
      const rows = sorted.length > MAX_ROWS ? sorted.slice(0, MAX_ROWS) : sorted
      const hiddenCount = matched.length - rows.length

      const toggleChildren = useCallback((sessionId) => {
        setExpanded((previous) => {
          const next = new Set(previous)
          if (next.has(sessionId)) next.delete(sessionId)
          else next.add(sessionId)
          return next
        })
      }, [])

      const updated = fetchedAt > 0 ? relativeTime(fetchedAt, now, t) : ''

      return h('div', { className: 'tu' },
        h('header', { className: 'tu-head' },
          h('div', { className: 'tu-head-main' },
            h('h1', { className: 'tu-title' }, t('page.title')),
            h('div', { className: 'tu-sub' },
              t('page.subtitle'),
              data?.generatedAt ? ` · ${t('page.updated', { time: updated })}` : '',
              data?.scanning === true ? ` · ${t('page.scanning')}` : '')),
          h('div', { className: 'tu-head-tools' },
            h('button', {
              type: 'button',
              className: 'tu-btn',
              'data-active': live ? 'true' : undefined,
              'aria-pressed': live,
              title: live ? t('page.liveOn') : t('page.liveOff'),
              onClick: () => setLive((value) => !value),
            }, h(IconPulse, { className: 'tu-ico' }), t('page.live')),
            h('select', {
              className: 'tu-select',
              value: range,
              'aria-label': t('page.range'),
              title: t('page.range'),
              onChange: (event) => setRange(event.target.value),
            }, RANGE_OPTIONS.map((option) => h('option', { key: option.id, value: option.id }, t(`range.${option.id}`)))),
            h('input', {
              className: 'tu-search',
              type: 'search',
              value: query,
              placeholder: t('page.search'),
              'aria-label': t('page.search'),
              onChange: (event) => setQuery(event.target.value),
            }),
            h('button', {
              type: 'button',
              className: 'tu-btn',
              title: t('page.refresh'),
              onClick: () => refresh(),
            }, h(IconRefresh, { className: 'tu-ico' }), t('page.refresh')),
            h('button', {
              type: 'button',
              className: 'tu-btn',
              title: t('page.back'),
              onClick: () => ctx.layout.selectPanel(null),
            }, h(IconBack, { className: 'tu-ico' }), t('page.back')))),
        h('div', { className: 'tu-scroll' },
          status === 'loading'
            ? h('div', { className: 'tu-state' },
              h('div', { className: 'tu-state-title' }, t('state.loading')),
              h('div', { className: 'tu-skeleton' }))
            : status === 'error'
              ? h('div', { className: 'tu-state' },
                h('div', { className: 'tu-state-title' }, t('state.error')),
                h('div', { className: 'tu-state-detail' }, error ?? ''),
                h('button', { type: 'button', className: 'tu-btn', onClick: () => refresh() }, t('state.retry')))
              : h(React.Fragment, null,
                h(SummaryStrip, {
                  summary,
                  today,
                  t,
                  symbol: data.pricing?.symbol,
                  rangeLabel,
                  windowStats,
                  todayStats,
                  windowTitle,
                  todayTitle,
                }),
                h(HistoryStrip, { data, t, now }),
                allRows.length === 0
                  ? h('div', { className: 'tu-state' }, h('div', { className: 'tu-state-title' }, t('state.empty')))
                  : h(React.Fragment, null,
                    h('div', { className: 'tu-toolbar' },
                      h('button', {
                        type: 'button',
                        className: 'tu-btn',
                        'data-active': grouped ? 'true' : undefined,
                        'aria-pressed': grouped,
                        title: t('page.group'),
                        onClick: () => setGrouped((value) => !value),
                      }, t('page.group')),
                      h('button', {
                        type: 'button',
                        className: 'tu-btn',
                        'aria-pressed': showZero,
                        title: showZero ? t('page.hideZero') : t('page.showZero'),
                        onClick: () => setShowZero((value) => !value),
                      }, showZero ? t('page.hideZero') : t('page.showZero'))),
                    h(SessionTable, {
                      rows,
                      hiddenCount,
                      sort,
                      onSort,
                      now,
                      onOpen: openSession,
                      t,
                      symbol: data.pricing?.symbol,
                      grouped,
                      expanded,
                      onToggleChildren: toggleChildren,
                    })))))
    }

    /* ------------------------------------------------------------------ *
     * Client plugin
     * ------------------------------------------------------------------ */

    return {
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-plugin-css', 'dsh-token-usage/TokenUsage.css')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => {
            style.remove()
          }
        }, 'token-usage: styles')

        ctx.effect(
          () => ctx.locale.register(NS, LOCALES),
          'token-usage: dictionaries',
        )

        const Page = (props) => h(TokenUsagePage, Object.assign({}, props, { ctx }))
        const t = ctx.locale.bind(NS)

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, Page))

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 5,
          label: () => t('panel'),
          locale: NS,
        }, PanelIcon))
      },
    }
  },
})
