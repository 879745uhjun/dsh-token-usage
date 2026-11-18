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
    let createRoot = null
    try {
      createRoot = require('react-dom/client').createRoot
    } catch {
      createRoot = null
    }

    const NS = 'token-usage'
    const PANEL_ID = 'token-usage'
    const ENDPOINT = '/token-usage'
    /** Read-only session-box route owned by dsh-session-boxes. */
    const BOXES_ENDPOINT = '/session-boxes'
    const BOXES_TIMEOUT_MS = 1500
    const POLL_MS = 2000
    /** Selectable history windows, remembered per browser. */
    const HISTORY_WINDOWS = [7, 14, 30]
    const HISTORY_STORAGE_KEY = 'token-usage.history-days'
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
      'page.grouping': 'Group by',
      'group.workspace': 'Workspace',
      'group.box': 'Box',
      'group.none': 'None',
      'group.ungrouped': 'Ungrouped',
      'csv.box': 'Box',
      'export.label': 'Export',
      'export.sessions': 'CSV · sessions',
      'export.sessions.title': 'Download every filtered session as CSV',
      'export.days': 'CSV · days',
      'export.days.title': 'Download the daily totals of the selected range as CSV',
      'export.markdown': 'Copy table',
      'export.markdown.title': 'Copy the filtered table as a Markdown table',
      'export.downloaded': 'Exported {name}',
      'export.copied': 'Table copied to the clipboard',
      'export.copyFailed': 'Could not write to the clipboard',
      'csv.workspace': 'Workspace',
      'csv.turns': 'Turns',
      'csv.sessionId': 'Session id',
      'csv.parentSession': 'Parent session',
      'csv.date': 'Date',
      'csv.started': 'Started',
      'range.today': 'Today',
      'range.7d': 'Last 7 days',
      'range.30d': 'Last 30 days',
      'range.all': 'All time',
      'group.meta': '{count} sessions · {total} tokens · {cost}',
      'row.child': 'sub-session',
      'detail.show': 'Show daily detail',
      'detail.hide': 'Hide daily detail',
      'detail.empty': 'No usage in this range',
      'detail.summary': '{days} days · {tokens} tokens · {cost}',
      'selftest.title': 'Self-test',
      'selftest.run': 'Run self-test',
      'selftest.rerun': 'Run again',
      'selftest.copy': 'Copy results',
      'selftest.copied': 'Copied',
      'selftest.copyFailed': 'Copy failed',
      'selftest.idle': 'Not run',
      'selftest.running': 'Running',
      'selftest.pass': 'Pass',
      'selftest.fail': 'Fail',
      'selftest.summary': '{pass} passed · {fail} failed',
      'selftest.summary.idle': 'Not run',
      'selftest.check.route': 'GET /token-usage returns 200',
      'selftest.check.etag': 'Re-request with ETag returns 304',
      'selftest.check.chart': 'Chart container renders',
      'selftest.check.pricing': 'Pricing table readable',
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
      'history.window': 'History window',
      'history.days': '{days} days',
      'history.chart.bars': 'Bars',
      'history.chart.line': 'Line',
      'history.chart.pie': 'Pie',
      'history.chart.title': 'Switch the history chart form',
      'history.other': 'Others',
      'history.peak': 'peak {value}',
      'pricing.peak.left': 'Peak · {time} left',
      'pricing.valley.left': 'Off-peak · {time} left',
      'history.valleyTime': 'Off-peak',
      'history.peakTime': 'Peak',
      'history.split.valley': 'Off-peak {value}',
      'history.split.peak': 'Peak {value}',
      'pricing.now.peak': 'Peak now',
      'pricing.now.valley': 'Off-peak now',
      'pricing.now.peak.title': 'Beijing weekdays 09:00–12:00 and 14:00–18:00, excluding holidays; every rate is doubled',
      'pricing.now.valley.title': 'Everything else, including weekends and statutory holidays',
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
      'page.grouping': '分组方式',
      'group.workspace': '工作区',
      'group.box': '盒子',
      'group.none': '不分',
      'group.ungrouped': '未分组',
      'csv.box': '盒子',
      'export.label': '导出',
      'export.sessions': 'CSV · 会话',
      'export.sessions.title': '把当前筛选出的会话导出为 CSV',
      'export.days': 'CSV · 按天',
      'export.days.title': '把所选时间范围的每日汇总导出为 CSV',
      'export.markdown': '复制表格',
      'export.markdown.title': '把当前筛选出的表格复制为 Markdown',
      'export.downloaded': '已导出 {name}',
      'export.copied': '表格已复制到剪贴板',
      'export.copyFailed': '无法写入剪贴板，请检查权限',
      'csv.workspace': '工作区',
      'csv.turns': '轮次',
      'csv.sessionId': '会话 ID',
      'csv.parentSession': '父会话 ID',
      'csv.date': '日期',
      'csv.started': '开始时间',
      'range.today': '今天',
      'range.7d': '近 7 天',
      'range.30d': '近 30 天',
      'range.all': '全部时间',
      'group.meta': '{count} 个会话 · {total} tokens · {cost}',
      'row.child': '子会话',
      'detail.show': '展开每日明细',
      'detail.hide': '收起每日明细',
      'detail.empty': '该时间范围内没有记录',
      'detail.summary': '{days} 天 · {tokens} tokens · {cost}',
      'selftest.title': '自检',
      'selftest.run': '运行自检',
      'selftest.rerun': '重新运行',
      'selftest.copy': '复制结果',
      'selftest.copied': '已复制',
      'selftest.copyFailed': '复制失败',
      'selftest.idle': '未运行',
      'selftest.running': '运行中',
      'selftest.pass': '通过',
      'selftest.fail': '失败',
      'selftest.summary': '{pass} 通过 · {fail} 失败',
      'selftest.summary.idle': '未运行',
      'selftest.check.route': '/token-usage 返回 200',
      'selftest.check.etag': '带 ETag 再请求返回 304',
      'selftest.check.chart': '图表容器可渲染',
      'selftest.check.pricing': '价格表可读',
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
      'history.window': '历史天数',
      'history.days': '{days} 天',
      'history.chart.bars': '柱状',
      'history.chart.line': '折线',
      'history.chart.pie': '扇形',
      'history.chart.title': '切换历史图的类型',
      'history.other': '其他',
      'history.peak': '峰值 {value}',
      'pricing.peak.left': '峰时 · 剩余 {time}',
      'pricing.valley.left': '谷时 · 剩余 {time}',
      'history.valleyTime': '谷时',
      'history.peakTime': '峰时',
      'history.split.valley': '谷时 {value}',
      'history.split.peak': '峰时 {value}',
      'pricing.now.peak': '当前峰时',
      'pricing.now.valley': '当前谷时',
      'pricing.now.peak.title': '北京时间工作日 9:00–12:00、14:00–18:00（法定节假日除外），单价 ×2',
      'pricing.now.valley.title': '其余时段（含周末与法定节假日）按谷时计价',
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
:root{--dshc-blue:#0969DA;--dshc-green:#1A7F37;--dshc-amber:#9A6700;--dshc-red:#CF222E;--dshc-purple:#8250DF;--dshc-cyan:#1B7C83;--dshc-pink:#BF3989;--dshc-gray:#6E7781}
body[data-ds-dark-theme]{--dshc-blue:#4C8DFF;--dshc-green:#3FB950;--dshc-amber:#D29922;--dshc-red:#F85149;--dshc-purple:#A371F7;--dshc-cyan:#39C5CF;--dshc-pink:#DB61A2;--dshc-gray:#8B949E}
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
.tu-select-sm{height:24px;font-size:11px;padding:0 6px}
.tu-history-tools{display:flex;align-items:center;gap:8px;margin-left:auto}
.tu-select:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.tu-group-row>td{padding:9px 12px;background:color-mix(in srgb, var(--dsw-alias-bg-layer-2) 60%, transparent);border-bottom:.5px solid var(--dsw-alias-border-l2)}
.tu-group-name{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
.tu-group-meta{margin-left:8px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.tu-chip{appearance:none;font:inherit;font-size:10px;line-height:14px;height:18px;padding:0 6px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;display:inline-flex;align-items:center;gap:3px;white-space:nowrap;flex:none}
.tu-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.tu-chip[data-open=true]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}
.tu-chip-muted{border-color:transparent;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);cursor:default}
.tu-row-child{background:color-mix(in srgb, var(--dsw-alias-bg-layer-2) 24%, transparent)}
.tu-row-toggle{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;padding:0 2px;cursor:pointer;flex:none}
.tu-row-toggle:hover{color:var(--dsw-alias-label-primary)}
.tu-row-toggle:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px;border-radius:3px}
.tu-detail-row>td{padding:0;background:color-mix(in srgb, var(--dsw-alias-bg-layer-2) 35%, transparent);border-bottom:.5px solid var(--dsw-alias-border-l1)}
.tu-detail{padding:10px 14px 12px}
.tu-detail-meta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);margin-bottom:8px}
.tu-detail-bars{display:flex;align-items:flex-end;gap:6px;overflow-x:auto}
.tu-detail-day{flex:1 1 0;min-width:34px;display:flex;flex-direction:column;align-items:center;gap:3px}
.tu-detail-value{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}
.tu-detail-track{width:100%;max-width:38px;height:42px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);display:flex;align-items:flex-end;overflow:hidden}
.tu-detail-fill{display:block;width:100%;border-radius:4px 4px 0 0;background:var(--dsw-alias-state-business-primary);opacity:.85}
.tu-detail-label{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary)}
.tu-detail-empty{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);padding:8px 2px}
.tu-selftest{display:flex;flex-direction:column;gap:10px;margin-top:12px;padding:14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1)}
.tu-selftest-head{display:flex;align-items:center;flex-wrap:wrap;gap:10px}
.tu-selftest-title{margin:0;font-size:13px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-primary)}
.tu-selftest-summary{margin-right:auto;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.tu-selftest-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.tu-selftest-row{display:flex;align-items:baseline;flex-wrap:wrap;gap:8px;font-size:12px;line-height:18px}
.tu-selftest-label{color:var(--dsw-alias-label-primary)}
.tu-selftest-badge{padding:0 6px;border-radius:999px;font-size:10px;line-height:16px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary)}
.tu-selftest-row[data-status=pass] .tu-selftest-badge{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)}
.tu-selftest-row[data-status=fail] .tu-selftest-badge{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent)}
.tu-selftest-detail{flex-basis:100%;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.tu-selftest-notice{font-size:11px;line-height:16px;color:var(--dsw-alias-state-success-primary)}
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
.tu-seg{display:inline-flex;align-items:center;gap:2px;margin-left:0;padding:2px;border-radius:999px;background:var(--dsw-alias-bg-layer-2)}
.tu-seg-btn{appearance:none;font:inherit;font-size:11px;line-height:16px;height:22px;padding:0 10px;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}
.tu-seg-btn:hover{color:var(--dsw-alias-label-primary)}
.tu-seg-btn[data-active=true]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 0 0 .5px var(--dsw-alias-border-l2)}
.tu-seg-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.tu-section-end{display:none}
.tu-toolbar{display:flex;align-items:center;gap:8px;justify-content:flex-start;flex-wrap:wrap;margin:0 0 8px}
.tu-toolbar-export{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.tu-toolbar-label{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-right:2px}
.tu-toolbar-toggles{display:flex;align-items:center;gap:8px;margin-left:auto}
.tu-export-note{font-size:11px;line-height:16px;color:var(--dsw-alias-state-success-primary);padding-left:4px}
.tu-export-note[data-tone=error]{color:var(--dsw-alias-state-error-primary)}
.tu-chart{position:relative;box-sizing:border-box;height:232px;padding:12px 14px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1);overflow:hidden;display:flex;flex-direction:column;justify-content:center;gap:8px}
.tu-bars{flex:1;min-height:0;display:flex;align-items:flex-end;gap:6px}
.tu-bar-col{height:100%}
.tu-bar-track{flex:1;min-height:0;height:auto}
.tu-chart-legend{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:8px 14px;margin:0 0 8px;font-size:11px}
.tu-chart-legend .tu-legend-item{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary)}
.tu-chart-legend .tu-legend-value{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.tu-chart-legend .tu-legend-pct{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);min-width:30px;text-align:right}
.tu-bar-track[data-split=true]{flex-direction:column-reverse;align-items:stretch}
.tu-bar-seg{display:block;width:100%}
.tu-bar-seg[data-kind=valley]{background:var(--dshc-blue)}
.tu-bar-seg[data-kind=peak]{background:var(--dshc-amber)}
body[data-ds-dark-theme] .tu-bar-seg[data-kind=peak]{opacity:.92}
body[data-ds-dark-theme] .tu-legend-dot{opacity:.95}
.tu-now-badge{display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:999px;font-size:10px;line-height:16px;color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)}
.tu-now-badge[data-peak=true]{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 16%, transparent)}
.tu-line svg{display:block;width:100%;height:auto;flex:1;min-height:0}
.tu-pie{display:flex;flex-direction:column;align-items:stretch;justify-content:flex-start;gap:0}
.tu-pie-body{flex:1;min-height:0;display:flex;align-items:center;justify-content:center}
.tu-pie-body svg{width:168px;height:168px;max-height:100%;flex:none}
.tu-line-days{display:flex;justify-content:space-between;gap:4px;margin-top:6px;overflow:hidden}
.tu-line-days .tu-bar-day{flex:1 1 0;text-align:center;min-width:0}
.tu-pie-total{font-size:9px;font-weight:600;fill:var(--dsw-alias-label-primary)}
.tu-pie-caption{font-size:6px;fill:var(--dsw-alias-label-tertiary)}
.tu-legend-item{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.tu-legend-dot{display:inline-block;width:8px;height:8px;border-radius:2px;flex:none}
.tu-legend-label{color:var(--dsw-alias-label-secondary)}
.tu-legend-value{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.tu-legend-pct{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);min-width:34px;text-align:right}
.tu-bar-col{flex:1 1 0;min-width:0;display:flex;flex-direction:column;align-items:center;gap:4px}
.tu-bar-value{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}
.tu-bar-track{width:100%;max-width:72px;height:56px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);display:flex;align-items:flex-end;overflow:hidden}
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

    /** Local `YYYY-MM-DD HH:mm` timestamp for exported files. */
    function formatTimestamp(time) {
      if (!Number.isFinite(time)) return ''
      const date = new Date(time)
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      const hour = String(date.getHours()).padStart(2, '0')
      const minute = String(date.getMinutes()).padStart(2, '0')
      return `${date.getFullYear()}-${month}-${day} ${hour}:${minute}`
    }

    /** Compact countdown until the next pricing window: `2h 05m` or `12m`. */
    function formatRemaining(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '—'
      const minutes = Math.max(1, Math.round(ms / 60000))
      const hours = Math.floor(minutes / 60)
      const rest = minutes % 60
      return hours > 0 ? `${hours}h ${String(rest).padStart(2, '0')}m` : `${rest}m`
    }

    /** One CSV field, quoted only when it must be. */
    function csvField(value) {
      const text = value === null || value === undefined ? '' : String(value)
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
    }

    /** A CSV document with a BOM so spreadsheet apps read UTF-8. */
    function buildCsv(header, rows) {
      const lines = [header, ...rows].map((row) => row.map(csvField).join(','))
      return `\ufeff${lines.join('\r\n')}\r\n`
    }

    /** Trigger a browser download for one generated document. */
    function downloadText(filename, text, mime) {
      const blob = new Blob([text], { type: `${mime};charset=utf-8` })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      link.rel = 'noopener'
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    }

    /** Copy text with the async clipboard API, falling back to execCommand. */
    async function copyText(text) {
      try {
        if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        /* Fall through to the legacy path. */
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0'
        document.body.appendChild(area)
        area.select()
        const copied = document.execCommand('copy')
        area.remove()
        return copied
      } catch {
        return false
      }
    }

    /** The remembered history window, clamped to the offered set. */
    function readHistoryDays() {
      try {
        const stored = Number(window.localStorage.getItem(HISTORY_STORAGE_KEY))
        return HISTORY_WINDOWS.includes(stored) ? stored : 14
      } catch {
        return 14
      }
    }

    /** Persist the chosen history window; locked storage just forgets it. */
    function storeHistoryDays(days) {
      try {
        window.localStorage.setItem(HISTORY_STORAGE_KEY, String(days))
      } catch {
        /* Private mode and locked storage are not errors here. */
      }
    }

    /** Box id/name resolution over the read-only `/session-boxes` state. */
    function buildBoxInfo(state) {
      const list = Array.isArray(state?.boxes)
        ? state.boxes.filter((box) => typeof box?.id === 'string' && typeof box?.name === 'string')
        : []
      if (list.length === 0) return undefined
      const byId = new Map(list.map((box) => [box.id, box]))
      const rootOfBox = (id) => {
        let current = byId.get(id)
        const seen = new Set()
        while (current !== undefined && typeof current.parentId === 'string' && byId.has(current.parentId) && !seen.has(current.id)) {
          seen.add(current.id)
          current = byId.get(current.parentId)
        }
        return current ?? undefined
      }
      const roots = list.filter((box) => rootOfBox(box.id) === box)
      const assigned = new Map()
      const memberships = state?.memberships !== null && typeof state?.memberships === 'object' ? state.memberships : {}
      for (const [sessionId, ids] of Object.entries(memberships)) {
        if (!Array.isArray(ids) || ids.length === 0) continue
        const box = ids.map((id) => byId.get(id)).find((candidate) => candidate !== undefined)
        if (box !== undefined) assigned.set(sessionId, box)
      }
      return {
        roots,
        /** `根盒 / 子盒` label, or undefined when the session sits in no box. */
        labelOf(sessionId) {
          const box = assigned.get(sessionId)
          if (box === undefined) return undefined
          const root = rootOfBox(box.id)
          return root !== undefined && root !== box ? `${root.name} / ${box.name}` : box.name
        },
        /** Top-level box a session belongs to, or null when it sits in no box. */
        rootOf(sessionId) {
          const box = assigned.get(sessionId)
          if (box === undefined) return null
          const root = rootOfBox(box.id)
          return root === undefined ? null : root.id
        },
      }
    }

    /** Usable box info from one `/session-boxes` response, or undefined. */
    function normalizeBoxes(payload) {
      if (payload === null || typeof payload !== 'object' || payload.ok === false) return undefined
      const state = payload.state
      if (state === null || typeof state !== 'object' || !Array.isArray(state.boxes)) return undefined
      return buildBoxInfo(state)
    }

    /** Cost and token sum of one group's rows. */
    function groupTotals(rows) {
      return rows.reduce((totals, row) => {
        totals.cost += Number(row.cost) || 0
        totals.total += Number(row.total) || 0
        return totals
      }, { cost: 0, total: 0 })
    }

    /**
     * Turn flat rows into display groups.
     * `workspace` groups by working directory (largest spend first), `box`
     * groups by top-level session box (box order, ungrouped last), `none`
     * returns one unnamed group.
     */
    function buildGroups(rows, mode, boxInfo, ungroupedLabel) {
      if (mode === 'none') return [{ key: '*', name: null, order: 0, rows }]
      const map = new Map()
      const ensure = (key, name, order) => {
        let group = map.get(key)
        if (group === undefined) {
          group = { key, name, order, rows: [] }
          map.set(key, group)
        }
        return group
      }
      if (mode === 'box' && boxInfo !== undefined) {
        for (const root of [...boxInfo.roots].sort((left, right) => (left.order ?? 0) - (right.order ?? 0) || left.name.localeCompare(right.name))) {
          ensure(root.id, root.name, root.order ?? 0)
        }
        for (const row of rows) {
          const rootId = boxInfo.rootOf(row.sessionId)
          const group = rootId === null
            ? ensure('__ungrouped__', ungroupedLabel, Number.MAX_SAFE_INTEGER)
            : map.get(rootId) ?? ensure(rootId, rootId, 0)
          group.rows.push(row)
        }
      } else {
        for (const row of rows) {
          const key = row.workspace?.path ?? row.workspace?.name ?? '—'
          ensure(key, row.workspace?.name ?? key, 0).rows.push(row)
        }
      }
      const groups = [...map.values()].filter((group) => group.rows.length > 0)
      if (mode === 'box') {
        groups.sort((left, right) => left.order - right.order || String(left.name).localeCompare(String(right.name)))
      } else {
        groups.sort((left, right) => groupTotals(right.rows).cost - groupTotals(left.rows).cost || String(left.name).localeCompare(String(right.name)))
      }
      return groups
    }

    /** One session per row, with raw numbers a spreadsheet can sum. */
    function sessionCsv(rows, symbol, t, boxLabelOf) {
      const unit = typeof symbol === 'string' && symbol.length > 0 ? symbol : '¥'
      const header = [
        t('col.session'),
        t('csv.workspace'),
        t('csv.box'),
        t('col.model'),
        t('col.input'),
        t('col.output'),
        t('col.cacheRead'),
        t('col.cacheWrite'),
        t('col.total'),
        `${t('col.cost')} (${unit})`,
        `${t('col.hit')} (%)`,
        t('csv.turns'),
        t('col.last'),
        t('csv.sessionId'),
        t('csv.parentSession'),
      ]
      const lines = rows.map((row) => {
        const prompt = (Number(row.input) || 0) + (Number(row.cacheRead) || 0) + (Number(row.cacheWrite) || 0)
        return [
          row.displayTitle ?? row.title ?? '',
          row.workspace?.name ?? '',
          typeof boxLabelOf === 'function' ? boxLabelOf(row.sessionId) ?? '' : '',
          row.model ?? '',
          Math.round(Number(row.input) || 0),
          Math.round(Number(row.output) || 0),
          Math.round(Number(row.cacheRead) || 0),
          Math.round(Number(row.cacheWrite) || 0),
          Math.round(Number(row.total) || 0),
          (Number(row.cost) || 0).toFixed(6),
          prompt > 0 ? ((Number(row.cacheRead) || 0) / prompt * 100).toFixed(2) : '0',
          Math.round(Number(row.turns) || 0),
          formatTimestamp(row.lastActivityAt),
          row.sessionId ?? '',
          row.parentSession ?? '',
        ]
      })
      return buildCsv(header, lines)
    }

    /** One local day per row for the selected range. */
    function dayCsv(dayRows, symbol, t) {
      const unit = typeof symbol === 'string' && symbol.length > 0 ? symbol : '¥'
      const header = [
        t('csv.date'),
        t('col.input'),
        t('col.output'),
        t('col.cacheRead'),
        t('col.cacheWrite'),
        t('col.total'),
        `${t('col.cost')} (${unit})`,
      ]
      const lines = dayRows.map((row) => [
        row.day ?? '',
        Math.round(Number(row.input) || 0),
        Math.round(Number(row.output) || 0),
        Math.round(Number(row.cacheRead) || 0),
        Math.round(Number(row.cacheWrite) || 0),
        Math.round(Number(row.total) || 0),
        (Number(row.cost) || 0).toFixed(6),
      ])
      return buildCsv(header, lines)
    }

    /** The filtered table as a portable Markdown table. */
    function markdownTable(rows, symbol, t, boxLabelOf) {
      const header = [
        t('col.session'),
        t('csv.workspace'),
        t('csv.box'),
        t('col.model'),
        t('col.total'),
        t('col.cost'),
        t('col.hit'),
        t('col.last'),
      ]
      const align = ['---', '---', '---', '---', '---:', '---:', '---:', '---']
      const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
      const lines = [`| ${header.map(cell).join(' | ')} |`, `| ${align.join(' | ')} |`]
      for (const row of rows) {
        const prompt = (Number(row.input) || 0) + (Number(row.cacheRead) || 0) + (Number(row.cacheWrite) || 0)
        lines.push(`| ${[
          cell(row.displayTitle ?? row.title ?? ''),
          cell(row.workspace?.name ?? ''),
          cell(typeof boxLabelOf === 'function' ? boxLabelOf(row.sessionId) ?? '' : ''),
          cell(row.model ?? ''),
          formatExact(row.total),
          formatMoney(row.cost, symbol),
          formatPercent(prompt > 0 ? (Number(row.cacheRead) || 0) / prompt : 0),
          cell(formatTimestamp(row.lastActivityAt)),
        ].join(' | ')} |`)
      }
      return `${lines.join('\n')}\n`
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
      const etag = useRef(null)

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
              headers: {
                accept: 'application/json',
                ...(etag.current === null ? {} : { 'if-none-match': etag.current }),
              },
            })
            if (response.status === 304) {
              // Unchanged since the previous poll: keep the rendered data and skip
              // the JSON transfer and parse entirely.
              schedule()
              return
            }
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const next = response.headers?.get?.('etag')
            if (typeof next === 'string' && next.length > 0) etag.current = next
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
    /** Selectable history chart forms, remembered per browser. */
    const CHART_TYPES = ['bars', 'line', 'pie']
    const CHART_STORAGE_KEY = 'token-usage.chart'
    /** Off-peak and peak colors shared by every split chart. */
    const PEAK_COLORS = { valley: 'var(--dshc-blue)', peak: 'var(--dshc-amber)' }

    /** The remembered chart form, or bars when nothing valid is stored. */
    function readChartType() {
      try {
        const stored = window.localStorage.getItem(CHART_STORAGE_KEY)
        return CHART_TYPES.includes(stored) ? stored : 'bars'
      } catch {
        return 'bars'
      }
    }

    /** Persist the chosen chart form; locked storage just forgets it. */
    function storeChartType(chart) {
      try {
        window.localStorage.setItem(CHART_STORAGE_KEY, chart)
      } catch {
        /* Private mode and locked storage are not errors here. */
      }
    }

    /** One value label for the active metric. */
    function historyValue(row, field, metric, symbol) {
      return metric === 'cost' ? formatMoney(row.cost, symbol) : formatTokens(row.total)
    }

    /** Short label above a bar: at most one decimal, blank for empty days. */
    function barValueLabel(row, field, metric, symbol) {
      const value = Number(row[field]) || 0
      if (value <= 0) return ''
      if (metric !== 'cost') return formatTokens(value)
      const unit = typeof symbol === 'string' && symbol.length > 0 ? symbol : '¥'
      if (value >= 100) return `${unit}${Math.round(value)}`
      if (value >= 10) return `${unit}${value.toFixed(1)}`
      return `${unit}${value.toFixed(2)}`
    }

    /** Peak/off-peak legend: same rows, same order, same columns for every chart. */
    function HistoryLegend({ rows, symbol, t }) {
      const valley = rows.reduce((sum, row) => sum + (Number(row.costValley) || 0), 0)
      const peak = rows.reduce((sum, row) => sum + (Number(row.costPeak) || 0), 0)
      const total = valley + peak
      const share = (value) => `${total > 0 ? Math.round((value / total) * 100) : 0}%`
      return h('div', { className: 'tu-chart-legend' },
        h('span', { className: 'tu-legend-item' },
          h('i', { className: 'tu-legend-dot', style: { background: PEAK_COLORS.valley } }),
          h('span', { className: 'tu-legend-label' }, t('history.valleyTime')),
          h('span', { className: 'tu-legend-value' }, formatMoney(valley, symbol)),
          h('span', { className: 'tu-legend-pct' }, share(valley))),
        h('span', { className: 'tu-legend-item' },
          h('i', { className: 'tu-legend-dot', style: { background: PEAK_COLORS.peak } }),
          h('span', { className: 'tu-legend-label' }, t('history.peakTime')),
          h('span', { className: 'tu-legend-value' }, formatMoney(peak, symbol)),
          h('span', { className: 'tu-legend-pct' }, share(peak))))
    }

    /** Bars: one tone for tokens, off-peak + peak stacked for spend. */
    function HistoryBars({ rows, field, metric, symbol, todayKey, t }) {
      const max = rows.reduce((peak, row) => Math.max(peak, row[field]), 0)
      const split = metric === 'cost'
      return h('div', { className: 'tu-chart' },
        split ? h(HistoryLegend, { rows, symbol, t }) : null,
        h('div', { className: 'tu-bars' }, rows.map((row) => {
          const ratio = max > 0 ? row[field] / max : 0
          const peakShare = row.cost > 0 ? row.costPeak / row.cost : 0
          const peakPct = ratio * peakShare * 100
          const valleyPct = ratio * (1 - peakShare) * 100
          const title = `${row.key}\n${formatExact(row.total)} tokens\n${t('summary.input')} ${formatExact(row.input)} · ${t('summary.output')} ${formatExact(row.output)}\n${t('summary.cacheRead')} ${formatExact(row.cacheRead)} · ${t('col.cacheWrite')} ${formatExact(row.cacheWrite)}\n${t('col.cost')} ${formatMoney(row.cost, symbol)} · ${t('history.split.valley', { value: formatMoney(row.costValley, symbol) })} · ${t('history.split.peak', { value: formatMoney(row.costPeak, symbol) })}`
          return h('div', {
            key: row.key,
            className: 'tu-bar-col',
            'data-today': row.key === todayKey ? 'true' : undefined,
            title,
          },
          h('span', { className: 'tu-bar-value' }, barValueLabel(row, field, metric, symbol)),
          h('span', { className: 'tu-bar-track', 'data-split': split ? 'true' : undefined },
            split
              ? h(React.Fragment, null,
                h('i', { className: 'tu-bar-seg', 'data-kind': 'valley', style: { height: `${Math.max(0, valleyPct)}%` } }),
                h('i', { className: 'tu-bar-seg', 'data-kind': 'peak', style: { height: `${Math.max(0, peakPct)}%` } }))
              : h('i', {
                className: 'tu-bar-fill',
                style: { height: row[field] > 0 ? `${Math.max(4, Math.round(ratio * 100))}%` : '2px' },
              })),
          h('span', { className: 'tu-bar-day' }, formatDayLabel(row.date)))
        })))
    }

    /** Line + area over the same daily values; spend adds a peak series. */
    function HistoryLine({ rows, field, metric, symbol, todayKey, t }) {
      const split = metric === 'cost'
      const max = rows.reduce((peak, row) => Math.max(peak, row[field]), 0)
      const count = rows.length
      const x = (index) => (count <= 1 ? 50 : (index / (count - 1)) * 100)
      const y = (value) => (max > 0 ? 96 - (value / max) * 84 : 96)
      const valleyPoints = rows.map((row, index) => `${x(index).toFixed(2)},${y(split ? row.costValley : row[field]).toFixed(2)}`)
      const peakPoints = split ? rows.map((row, index) => `${x(index).toFixed(2)},${y(row.costPeak).toFixed(2)}`) : null
      const line = valleyPoints.join(' ')
      const area = `0,100 ${line} 100,100`
      return h('div', { className: 'tu-chart tu-line' },
        split ? h(HistoryLegend, { rows, symbol, t }) : null,
        h('svg', { viewBox: '0 0 100 100', preserveAspectRatio: 'none', role: 'img', 'aria-label': t('history.chart.line') },
          h('defs', null,
            h('linearGradient', { id: 'tu-line-fill', x1: '0', y1: '0', x2: '0', y2: '1' },
              h('stop', { offset: '0%', style: { stopColor: PEAK_COLORS.valley, stopOpacity: '0.30' } }),
              h('stop', { offset: '100%', style: { stopColor: PEAK_COLORS.valley, stopOpacity: '0' } }))),
          h('polygon', { points: area, fill: 'url(#tu-line-fill)' }),
          h('polyline', {
            points: line,
            fill: 'none',
            style: { stroke: split ? PEAK_COLORS.valley : 'var(--dsw-alias-state-business-primary)' },
            strokeWidth: 2,
            vectorEffect: 'non-scaling-stroke',
            strokeLinejoin: 'round',
            strokeLinecap: 'round',
          }),
          peakPoints === null
            ? null
            : h('polyline', {
              points: peakPoints.join(' '),
              fill: 'none',
              style: { stroke: PEAK_COLORS.peak },
              strokeWidth: 2,
              strokeDasharray: '4 3',
              vectorEffect: 'non-scaling-stroke',
              strokeLinejoin: 'round',
              strokeLinecap: 'round',
            }),
          rows.map((row, index) => h('g', { key: row.key },
            h('circle', {
              cx: x(index),
              cy: y(split ? row.costValley : row[field]),
              r: 1.3,
              style: { fill: split ? PEAK_COLORS.valley : 'var(--dsw-alias-state-business-primary)' },
            }),
            split
              ? h('circle', { cx: x(index), cy: y(row.costPeak), r: 1.1, style: { fill: PEAK_COLORS.peak } })
              : null,
            h('title', null, split
              ? `${row.key} · ${t('history.split.valley', { value: formatMoney(row.costValley, symbol) })} · ${t('history.split.peak', { value: formatMoney(row.costPeak, symbol) })}`
              : `${row.key} · ${historyValue(row, field, metric, symbol)}`)))),
        h('div', { className: 'tu-line-days' }, rows.map((row) => h('span', {
          key: row.key,
          className: 'tu-bar-day',
          'data-today': row.key === todayKey ? 'true' : undefined,
        }, formatDayLabel(row.date)))))
    }

    /** Donut over the same window: top days plus the remainder. */
    function HistoryPie({ rows, field, metric, symbol, t }) {
      const split = metric === 'cost'
      const colors = split
        ? [PEAK_COLORS.valley, PEAK_COLORS.peak]
        : ['var(--dshc-blue)', 'var(--dshc-green)', 'var(--dshc-amber)', 'var(--dshc-red)', 'var(--dshc-purple)', 'var(--dshc-cyan)', 'var(--dshc-pink)', 'var(--dshc-gray)']
      let slices
      if (split) {
        const valley = rows.reduce((sum, row) => sum + (Number(row.costValley) || 0), 0)
        const peak = rows.reduce((sum, row) => sum + (Number(row.costPeak) || 0), 0)
        slices = [
          { key: 'valley', label: t('history.valleyTime'), value: valley },
          { key: 'peak', label: t('history.peakTime'), value: peak },
        ].filter((slice) => slice.value > 0)
      } else {
        const entries = rows.filter((row) => row[field] > 0).sort((left, right) => right[field] - left[field])
        slices = entries.slice(0, 6).map((row) => ({ key: row.key, label: formatDayLabel(row.date), value: row[field] }))
        const restValue = entries.slice(6).reduce((sum, row) => sum + row[field], 0)
        if (restValue > 0) slices.push({ key: '__rest__', label: t('history.other'), value: restValue })
      }
      const total = slices.reduce((sum, slice) => sum + slice.value, 0)
      const circumference = 2 * Math.PI * 40
      let offset = 0
      const format = (value) => (metric === 'cost' ? formatMoney(value, symbol) : formatTokens(value))
      return h('div', { className: 'tu-chart tu-pie' },
        h('div', { className: 'tu-chart-legend' }, slices.map((slice, index) => h('span', { key: slice.key, className: 'tu-legend-item' },
          h('i', { className: 'tu-legend-dot', style: { background: colors[index % colors.length] } }),
          h('span', { className: 'tu-legend-label' }, slice.label),
          h('span', { className: 'tu-legend-value' }, format(slice.value)),
          h('span', { className: 'tu-legend-pct' }, `${total > 0 ? Math.round((slice.value / total) * 100) : 0}%`)))),
        h('div', { className: 'tu-pie-body' },
        h('svg', { viewBox: '0 0 100 100', role: 'img', 'aria-label': t('history.chart.pie') },
          h('circle', { cx: 50, cy: 50, r: 40, fill: 'none', style: { stroke: 'var(--dsw-alias-bg-layer-2)' }, strokeWidth: 18 }),
          slices.map((slice, index) => {
            const length = total > 0 ? (slice.value / total) * circumference : 0
            const share = total > 0 ? Math.round((slice.value / total) * 100) : 0
            const arc = h('circle', {
              key: slice.key,
              cx: 50,
              cy: 50,
              r: 40,
              fill: 'none',
              style: { stroke: colors[index % colors.length] },
              strokeWidth: 18,
              strokeDasharray: `${length.toFixed(2)} ${(circumference - length).toFixed(2)}`,
              strokeDashoffset: (-offset).toFixed(2),
              transform: 'rotate(-90 50 50)',
            }, h('title', null, `${slice.label} · ${format(slice.value)} · ${share}%`))
            offset += length
            return arc
          }),
          h('text', { x: 50, y: 48, textAnchor: 'middle', className: 'tu-pie-total' }, format(total)),
          h('text', { x: 50, y: 60, textAnchor: 'middle', className: 'tu-pie-caption' },
            t(metric === 'cost' ? 'history.metric.cost' : 'history.metric.tokens')))))
    }

    function HistoryStrip({ data, t, now, windowDays, onDaysChange }) {
      const [metric, setMetric] = useState('cost')
      const [chart, setChart] = useState(readChartType)
      const symbol = data?.pricing?.symbol
      const byDay = useMemo(() => {
        const map = new Map()
        for (const row of Array.isArray(data?.days) ? data.days : []) {
          if (typeof row?.day === 'string') map.set(row.day, row)
        }
        return map
      }, [data])
      const days = useMemo(() => recentDayKeys(windowDays), [now, windowDays])
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
          costPeak: Number(bucket?.costPeak) || 0,
          costValley: Number(bucket?.costValley) || 0,
        }
      })
      const field = metric === 'cost' ? 'cost' : 'total'
      const todayKey = dayKeyOf(Date.now())
      const hasAny = rows.some((row) => row[field] > 0)
      const chooseChart = (next) => {
        setChart(next)
        storeChartType(next)
      }
      const chartBody = !hasAny
        ? h('div', { className: 'tu-state' }, h('div', { className: 'tu-state-detail' }, t('history.empty')))
        : chart === 'line'
          ? h(HistoryLine, { rows, field, metric, symbol, todayKey, t })
          : chart === 'pie'
            ? h(HistoryPie, { rows, field, metric, symbol, t })
            : h(HistoryBars, { rows, field, metric, symbol, todayKey, t })
      return h('section', { className: 'tu-section' },
        h('div', { className: 'tu-section-head' },
          h('h2', { className: 'tu-section-title' }, t('history.title')),
          h('span', { className: 'tu-section-sub' }, t('history.subtitle', { days: windowDays })),
          h('div', { className: 'tu-history-tools' },
            h('select', {
              className: 'tu-select tu-select-sm',
              value: String(windowDays),
              'aria-label': t('history.window'),
              title: t('history.window'),
              onChange: (event) => onDaysChange(Number(event.target.value)),
            }, HISTORY_WINDOWS.map((count) => h('option', { key: count, value: String(count) }, t('history.days', { days: count })))),
            h('div', { className: 'tu-seg', title: t('history.chart.title'), role: 'group' },
              CHART_TYPES.map((type) => h('button', {
                key: type,
                type: 'button',
                className: 'tu-seg-btn',
                'data-active': chart === type ? 'true' : undefined,
                'aria-pressed': chart === type,
                onClick: () => chooseChart(type),
              }, t(`history.chart.${type}`)))),
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
            }, t('history.metric.tokens'))))),
        chartBody)
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
    /** Per-day strip for one expanded session row. */
    function SessionDayStrip({ row, startKey, symbol, t }) {
      const days = (Array.isArray(row.days) ? row.days : [])
        .filter((day) => typeof day?.day === 'string' && (startKey === null || day.day >= startKey))
        .sort((left, right) => left.day.localeCompare(right.day))
      if (days.length === 0) return h('div', { className: 'tu-detail-empty' }, t('detail.empty'))
      const totalCost = days.reduce((sum, day) => sum + (Number(day.cost) || 0), 0)
      const totalTokens = days.reduce((sum, day) => sum + (Number(day.total) || 0), 0)
      const useCost = totalCost > 0
      const max = days.reduce((peak, day) => Math.max(peak, useCost ? Number(day.cost) || 0 : Number(day.total) || 0), 0)
      return h('div', { className: 'tu-detail' },
        h('div', { className: 'tu-detail-meta' }, t('detail.summary', {
          days: days.length,
          tokens: formatTokens(totalTokens),
          cost: formatMoney(totalCost, symbol),
        })),
        h('div', { className: 'tu-detail-bars' }, days.map((day) => {
          const value = useCost ? Number(day.cost) || 0 : Number(day.total) || 0
          return h('div', {
            key: day.day,
            className: 'tu-detail-day',
            title: `${day.day} · ${formatExact(day.total)} tokens · ${formatMoney(day.cost, symbol)}`,
          },
          h('span', { className: 'tu-detail-value' }, useCost ? formatMoney(day.cost, symbol) : formatTokens(day.total)),
          h('span', { className: 'tu-detail-track' },
            h('i', { className: 'tu-detail-fill', style: { height: `${max > 0 ? Math.max(4, Math.round((value / max) * 100)) : 4}%` } })),
          h('span', { className: 'tu-detail-label' }, day.day.slice(5)))
        })))
    }

    function SessionRow({ row, now, onOpen, t, peak, symbol, depth = 0, childCount = 0, childCost = 0, expanded = false, onToggleChildren, detailOpen = false, onToggleDetail }) {
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
          h('button', {
            type: 'button',
            className: 'tu-row-toggle',
            'aria-expanded': detailOpen,
            'aria-label': detailOpen ? t('detail.hide') : t('detail.show'),
            title: detailOpen ? t('detail.hide') : t('detail.show'),
            onClick: (event) => {
              event.stopPropagation()
              if (typeof onToggleDetail === 'function') onToggleDetail(row.sessionId)
            },
          }, detailOpen ? '▾' : '▸'),
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
          typeof row.boxLabel === 'string' && row.boxLabel.length > 0 ? ` · ${row.boxLabel}` : '',
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
    function SessionTable({ rows, groups, hiddenCount, sort, onSort, now, onOpen, t, symbol, expanded, onToggleChildren, detailOpen, onToggleDetail, startKey }) {
      const peak = rows.reduce((value, row) => Math.max(value, Number(row.total) || 0), 0)

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
          const showDetail = detailOpen instanceof Set ? detailOpen.has(row.sessionId) : false
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
            detailOpen: showDetail,
            onToggleDetail,
          }))
          if (showDetail) {
            output.push(h('tr', { key: `${row.sessionId}:detail`, className: 'tu-detail-row' },
              h('td', { colSpan: 10 }, h(SessionDayStrip, { row, startKey, symbol, t }))))
          }
          if (open) {
            for (const child of children) {
              const childDetail = detailOpen instanceof Set ? detailOpen.has(child.sessionId) : false
              output.push(h(SessionRow, {
                key: child.sessionId,
                row: child,
                now,
                onOpen,
                t,
                peak,
                symbol,
                depth: 1,
                detailOpen: childDetail,
                onToggleDetail,
              }))
              if (childDetail) {
                output.push(h('tr', { key: `${child.sessionId}:detail`, className: 'tu-detail-row' },
                  h('td', { colSpan: 10 }, h(SessionDayStrip, { row: child, startKey, symbol, t }))))
              }
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
              groups.map((group) => {
                const totals = groupTotals(group.rows)
                return h('tbody', { key: group.key, className: 'tu-group' },
                  group.name === null
                    ? null
                    : h('tr', { className: 'tu-group-row' },
                      h('td', { colSpan: 10 },
                        h('span', { className: 'tu-group-name' }, group.name),
                        h('span', { className: 'tu-group-meta' }, t('group.meta', {
                          count: group.rows.length,
                          total: formatTokens(totals.total),
                          cost: formatMoney(totals.cost, symbol),
                        })))),
                  renderGroupRows(group))
              }))),
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
    // ---------------------------------------------------------------------
    // Self-test section (plugins.detail.section)
    // ---------------------------------------------------------------------

    const SELFTEST_ID = 'dsh-token-usage.selftest'
    const SELFTEST_TIMEOUT_MS = 2000

    /** Fetch with a hard timeout; throws a readable message on abort. */
    async function fetchWithTimeout(url, options, timeoutMs) {
      const controller = new AbortController()
      const timer = window.setTimeout(() => controller.abort(), timeoutMs)
      try {
        return await fetch(url, { ...options, signal: controller.signal })
      } catch (error) {
        if (controller.signal.aborted || error?.name === 'AbortError') throw new Error(`超时 ${timeoutMs}ms`)
        throw error
      } finally {
        window.clearTimeout(timer)
      }
    }

    /** Render one bar chart offscreen and report the DOM it produced. */
    async function renderChartProbe() {
      if (typeof createRoot !== 'function') throw new Error('react-dom/client 不可用')
      const container = document.createElement('div')
      container.style.cssText = 'position:absolute;left:-10000px;top:0;width:640px;height:240px'
      document.body.appendChild(container)
      const root = createRoot(container)
      const probe = {
        key: '2026-01-01',
        date: new Date(),
        day: '2026-01-01',
        total: 1000,
        input: 500,
        output: 100,
        cacheRead: 400,
        cacheWrite: 0,
        cost: 0.42,
        costPeak: 0.12,
        costValley: 0.3,
      }
      try {
        root.render(h(HistoryBars, {
          rows: [probe],
          field: 'cost',
          metric: 'cost',
          symbol: '¥',
          todayKey: '2026-01-01',
          t: (key) => key,
        }))
        await new Promise((resolve) => setTimeout(resolve, 60))
        const bars = container.querySelector('.tu-bars')
        if (bars === null) throw new Error('图表 DOM 未生成')
        return `${container.querySelectorAll('.tu-bar-col').length} 个柱 · ${container.querySelectorAll('.tu-bar-seg').length} 段`
      } finally {
        try {
          root.unmount()
        } catch {
          /* A failed unmount must not mask the check result. */
        }
        container.remove()
      }
    }

    /** `- [x] 标签 — 通过` lines for the copy button. */
    function selftestMarkdown(results) {
      return results
        .map((result) => (result.ok ? `- [x] ${result.label} — 通过` : `- [ ] ${result.label} — 失败：${result.detail}`))
        .join('\n')
    }

    /** Run every check once; failures stay isolated per row. */
    async function runSelftest(t) {
      const context = { etag: null, payload: null }
      const checks = [
        {
          id: 'route',
          label: t('selftest.check.route'),
          async run() {
            const response = await fetchWithTimeout(ENDPOINT, {
              cache: 'no-store',
              headers: { accept: 'application/json' },
            }, SELFTEST_TIMEOUT_MS)
            if (response.status !== 200) throw new Error(`HTTP ${response.status}`)
            context.etag = response.headers.get('etag')
            context.payload = await response.json()
            const sessions = Array.isArray(context.payload?.sessions) ? context.payload.sessions.length : 0
            return `HTTP 200 · ${sessions} 个会话`
          },
        },
        {
          id: 'etag',
          label: t('selftest.check.etag'),
          async run() {
            if (context.etag === null) throw new Error('首次响应没有 ETag')
            const response = await fetchWithTimeout(ENDPOINT, {
              cache: 'no-store',
              headers: { accept: 'application/json', 'if-none-match': context.etag },
            }, SELFTEST_TIMEOUT_MS)
            if (response.status !== 304) throw new Error(`期望 304，实际 ${response.status}`)
            return `HTTP 304 · ${context.etag}`
          },
        },
        { id: 'chart', label: t('selftest.check.chart'), run: () => renderChartProbe() },
        {
          id: 'pricing',
          label: t('selftest.check.pricing'),
          async run() {
            const pricing = context.payload?.pricing
            if (pricing === null || typeof pricing !== 'object') throw new Error('payload 缺少 pricing')
            if (typeof pricing.currency !== 'string' || pricing.currency.length === 0) throw new Error('pricing.currency 缺失')
            const multiplier = Number(pricing.peakMultiplier)
            return `${pricing.currency} · 来源 ${pricing.source ?? 'builtin'} · 峰时 ×${Number.isFinite(multiplier) ? multiplier : '?'}`
          },
        },
      ]
      const results = []
      for (const check of checks) {
        try {
          results.push({ id: check.id, label: check.label, ok: true, detail: await check.run() })
        } catch (error) {
          results.push({ id: check.id, label: check.label, ok: false, detail: error?.message ?? String(error) })
        }
      }
      return results
    }

    function PluginSelfTest({ t, subject }) {
      if (subject !== undefined && subject !== null && typeof subject.id === 'string' && !subject.id.includes('token-usage')) {
        return null
      }
      const [results, setResults] = useState(null)
      const [running, setRunning] = useState(false)
      const [notice, setNotice] = useState('')
      const start = useCallback(async () => {
        setRunning(true)
        setNotice('')
        try {
          const next = await runSelftest(t)
          setResults(next)
        } finally {
          setRunning(false)
        }
      }, [t])
      const copy = useCallback(async () => {
        if (results === null) return
        const copied = await copyText(selftestMarkdown(results))
        setNotice(copied ? t('selftest.copied') : t('selftest.copyFailed'))
      }, [results, t])
      const pass = results === null ? 0 : results.filter((row) => row.ok).length
      const fail = results === null ? 0 : results.length - pass
      const summary = results === null
        ? t('selftest.summary.idle')
        : t('selftest.summary', { pass, fail })
      return h('section', { className: 'tu-card tu-selftest', 'data-selftest': SELFTEST_ID },
        h('div', { className: 'tu-selftest-head' },
          h('h3', { className: 'tu-selftest-title' }, t('selftest.title')),
          h('span', { className: 'tu-selftest-summary' }, summary),
          h('button', {
            type: 'button',
            className: 'tu-btn',
            disabled: running,
            onClick: () => {
              void start()
            },
          }, running ? t('selftest.running') : results === null ? t('selftest.run') : t('selftest.rerun')),
          h('button', {
            type: 'button',
            className: 'tu-btn',
            disabled: results === null,
            onClick: () => {
              void copy()
            },
          }, t('selftest.copy')),
          notice === '' ? null : h('span', { className: 'tu-selftest-notice', role: 'status' }, notice)),
        h('ul', { className: 'tu-selftest-list' }, (results ?? CHECKS_PLACEHOLDER(t)).map((row) => h('li', {
          key: row.id,
          className: 'tu-selftest-row',
          'data-status': row.ok === undefined ? 'idle' : row.ok ? 'pass' : 'fail',
        },
        h('span', { className: 'tu-selftest-label' }, row.label),
        h('span', { className: 'tu-selftest-badge' }, row.ok === undefined
          ? t('selftest.idle')
          : row.ok ? t('selftest.pass') : t('selftest.fail')),
        row.ok === false ? h('span', { className: 'tu-selftest-detail' }, row.detail) : null))))
    }

    /** Idle rows shown before the first run. */
    function CHECKS_PLACEHOLDER(t) {
      return [
        { id: 'route', label: t('selftest.check.route') },
        { id: 'etag', label: t('selftest.check.etag') },
        { id: 'chart', label: t('selftest.check.chart') },
        { id: 'pricing', label: t('selftest.check.pricing') },
      ]
    }

    function TokenUsagePage(props) {
      const { ctx } = props
      const locale = ctx.locale ?? ctx.get('locale')
      useLocaleRevision(locale)
      const t = locale.bind(NS)

      const [live, setLive] = useState(true)
      const [query, setQuery] = useState('')
      const [showZero, setShowZero] = useState(false)
      const [range, setRange] = useState('all')
      const [historyDays, setHistoryDays] = useState(readHistoryDays)
      const [grouping, setGrouping] = useState('workspace')
      const [boxInfo, setBoxInfo] = useState(null)
      const [expanded, setExpanded] = useState(() => new Set())
      const [detail, setDetail] = useState(() => new Set())
      const [sort, setSort] = useState({ key: 'total', direction: 'desc' })
      const now = useNow(30000)
      const { status, data, error, fetchedAt, refresh } = useUsageData({ live, revision: 0 })

      // Session boxes are optional: a missing, slow, or malformed route only
      // hides the box dimension; it never blocks the page.
      useEffect(() => {
        let cancelled = false
        const controller = new AbortController()
        const timer = window.setTimeout(() => controller.abort(), BOXES_TIMEOUT_MS)
        const load = async () => {
          try {
            const response = await fetch(BOXES_ENDPOINT, {
              signal: controller.signal,
              cache: 'no-store',
              headers: { accept: 'application/json' },
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const body = await response.json()
            if (!cancelled) setBoxInfo(normalizeBoxes(body) ?? null)
          } catch {
            if (!cancelled) setBoxInfo(null)
          } finally {
            window.clearTimeout(timer)
          }
        }
        void load()
        return () => {
          cancelled = true
          window.clearTimeout(timer)
          controller.abort()
        }
      }, [])

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
      const sorted = useMemo(() => {
        const list = [...visible].sort((left, right) => compareRows(left, right, sort))
        if (boxInfo === null) return list
        return list.map((row) => ({ ...row, boxLabel: boxInfo.labelOf(row.sessionId) }))
      }, [visible, sort, boxInfo])
      const boxLabelOf = useCallback(
        (sessionId) => (boxInfo === null ? undefined : boxInfo.labelOf(sessionId)),
        [boxInfo],
      )
      const effectiveGrouping = grouping === 'box' && boxInfo === null ? 'workspace' : grouping
      const groups = useMemo(
        () => buildGroups(sorted, effectiveGrouping, boxInfo ?? undefined, t('group.ungrouped')),
        [sorted, effectiveGrouping, boxInfo, t],
      )
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

      const toggleDetail = useCallback((sessionId) => {
        setDetail((previous) => {
          const next = new Set(previous)
          if (next.has(sessionId)) next.delete(sessionId)
          else next.add(sessionId)
          return next
        })
      }, [])

      const [notice, setNotice] = useState(null)
      const noticeTimer = useRef(null)
      const flash = useCallback((text, tone) => {
        setNotice({ text, tone: tone ?? 'ok' })
        if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
        noticeTimer.current = window.setTimeout(() => setNotice(null), 3200)
      }, [])
      useEffect(() => () => {
        if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
      }, [])

      const exportSessions = useCallback(() => {
        const name = `token-usage-sessions-${shiftDayKey(0)}.csv`
        downloadText(name, sessionCsv(sorted, data?.pricing?.symbol, t, boxLabelOf), 'text/csv')
        flash(t('export.downloaded', { name }))
      }, [sorted, data, t, boxLabelOf, flash])

      const exportDays = useCallback(() => {
        const start = rangeStartKey(range)
        const list = (Array.isArray(data?.days) ? data.days : []).filter((row) => start === null || row.day >= start)
        const name = `token-usage-days-${shiftDayKey(0)}.csv`
        downloadText(name, dayCsv(list, data?.pricing?.symbol, t), 'text/csv')
        flash(t('export.downloaded', { name }))
      }, [data, range, t, flash])

      const copyTable = useCallback(async () => {
        const copied = await copyText(markdownTable(sorted, data?.pricing?.symbol, t, boxLabelOf))
        flash(copied ? t('export.copied') : t('export.copyFailed'), copied ? 'ok' : 'error')
      }, [sorted, data, t, boxLabelOf, flash])

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
            h('span', {
              className: 'tu-now-badge',
              'data-peak': data?.pricing?.peakNow === true ? 'true' : undefined,
              title: data?.pricing?.peakNow === true ? t('pricing.now.peak.title') : t('pricing.now.valley.title'),
            }, data?.pricing?.peakNow === true
              ? t('pricing.peak.left', { time: formatRemaining((data?.pricing?.nextSwitchAt ?? NaN) - now) })
              : t('pricing.valley.left', { time: formatRemaining((data?.pricing?.nextSwitchAt ?? NaN) - now) })),
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
                h(HistoryStrip, {
                  data,
                  t,
                  now,
                  windowDays: historyDays,
                  onDaysChange: (days) => {
                    setHistoryDays(days)
                    storeHistoryDays(days)
                  },
                }),
                allRows.length === 0
                  ? h('div', { className: 'tu-state' }, h('div', { className: 'tu-state-title' }, t('state.empty')))
                  : h(React.Fragment, null,
                    h('div', { className: 'tu-toolbar' },
                      h('div', { className: 'tu-toolbar-export' },
                        h('span', { className: 'tu-toolbar-label' }, t('export.label')),
                        h('button', {
                          type: 'button',
                          className: 'tu-btn',
                          title: t('export.sessions.title'),
                          onClick: exportSessions,
                        }, t('export.sessions')),
                        h('button', {
                          type: 'button',
                          className: 'tu-btn',
                          title: t('export.days.title'),
                          onClick: exportDays,
                        }, t('export.days')),
                        h('button', {
                          type: 'button',
                          className: 'tu-btn',
                          title: t('export.markdown.title'),
                          onClick: () => {
                            void copyTable()
                          },
                        }, t('export.markdown'))),
                      notice === null
                        ? null
                        : h('span', { className: 'tu-export-note', role: 'status', 'data-tone': notice.tone }, notice.text),
                      h('div', { className: 'tu-toolbar-toggles' },
                        h('div', { className: 'tu-seg', role: 'group', title: t('page.grouping') },
                          h('button', {
                            type: 'button',
                            className: 'tu-seg-btn',
                            'data-active': effectiveGrouping === 'workspace' ? 'true' : undefined,
                            'aria-pressed': effectiveGrouping === 'workspace',
                            onClick: () => setGrouping('workspace'),
                          }, t('group.workspace')),
                          boxInfo === null
                            ? null
                            : h('button', {
                              type: 'button',
                              className: 'tu-seg-btn',
                              'data-active': effectiveGrouping === 'box' ? 'true' : undefined,
                              'aria-pressed': effectiveGrouping === 'box',
                              onClick: () => setGrouping('box'),
                            }, t('group.box')),
                          h('button', {
                            type: 'button',
                            className: 'tu-seg-btn',
                            'data-active': effectiveGrouping === 'none' ? 'true' : undefined,
                            'aria-pressed': effectiveGrouping === 'none',
                            onClick: () => setGrouping('none'),
                          }, t('group.none'))),
                        h('button', {
                          type: 'button',
                          className: 'tu-btn',
                          'aria-pressed': showZero,
                          title: showZero ? t('page.hideZero') : t('page.showZero'),
                          onClick: () => setShowZero((value) => !value),
                        }, showZero ? t('page.hideZero') : t('page.showZero')))),
                    h(SessionTable, {
                      rows,
                      groups,
                      hiddenCount,
                      sort,
                      onSort,
                      now,
                      onOpen: openSession,
                      t,
                      symbol: data.pricing?.symbol,
                      expanded,
                      onToggleChildren: toggleChildren,
                      detailOpen: detail,
                      onToggleDetail: toggleDetail,
                      startKey,
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

        // Self-test block on this plugin's detail page; runs only on click.
        const SelfTest = (props) => h(PluginSelfTest, Object.assign({}, props, { t }))
        ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
          name: 'plugins.detail.section',
          id: SELFTEST_ID,
          order: 90,
          label: () => t('selftest.title'),
          locale: NS,
        }, SelfTest))
      },
    }
  },
})
