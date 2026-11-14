/**
 * dsh-context-console — 一个面板，统一控制所有会话的上下文预算。
 *
 * 四组旋钮，改动后下一轮就生效，不需要重启：
 *
 *   1. 上下文上限    拦截 `llm.resolveModelInfo` / `resolveModelInfoFor`，把所有模型的
 *                    contextWindow 钳到上限值；默认输出预算按上限的 1/4 收敛。
 *   2. 默认思考等级  拦截 `llm.resolveCallWithInfo`，只在会话没有显式挑档位时补默认值。
 *   3. 自动压缩      写进每个 agent 预设里 `compaction` 组的 `compaction-basic`
 *                    （thresholdRatio / retainRatio / headroomTokens）。
 *   4. 工具结果裁剪  写进同一个组的 `tool-result-pruner`
 *                    （thresholdChars / headChars / tailChars）。
 *
 * 为什么 3、4 要写预设而不是改实例：`dsh-web-app` 的预设把这两个服务放在
 * `isolate: { compaction: true, toolResultPruner: true }` 的隔离组里，每个 agent 各起一份，
 * 宿主侧根本看不见。官方给的唯一稳定入口就是「按 id 覆盖预设行」——Web 编辑器保存的改动
 * 走的是同一条路，等价于手改 `cordis.patch.yml`。
 *
 * 状态（上限、思考等级、阈值）存在 `$DSH_HOME/dsh-context-console/state.json`；
 * 面板通过 `/context-console/api/{state,apply,reset}` 读写。
 *
 * @module dsh-context-console
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'context-console'

/** `webServer` 挂路由；`configEditor`、`llm` 按需探测，缺了对应那组显示未就绪。 */
export const inject = ['webServer']

const API = '/context-console/api'

/** 与 llm 侧的 THINKING_LEVELS 对齐。 */
export const THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh', 'max']

/** 裁剪标记的保守长度上限：head + marker + tail 必须装得进 threshold。 */
const MARKER_RESERVE = 96

/** 预设行的识别特征。 */
const PRESET_NAME = '@deepseek-ai/dsh-agent-preset'

export const DEFAULTS = Object.freeze({
  /** 0 = 不限制，保持模型目录里的原值。 */
  contextCap: 0,
  /** '' = 跟随模型/提供方默认。 */
  reasoningDefault: '',
  compaction: Object.freeze({
    thresholdRatio: 0.8,
    retainRatio: 0.16,
    headroomTokens: 65536,
  }),
  tools: Object.freeze({
    thresholdChars: 8192,
    headChars: 4096,
    tailChars: 1024,
  }),
})

/**
 * cordis 里 `ctx.llm` 这种属性访问在没 inject 时会直接抛错，`ctx.get(name)` 才是安全的。
 * 所有可选服务都从这里取：拿不到就是 `undefined`，对应那组旋钮显示「未就绪」而不是把面板打崩。
 */
function service(ctx, name) {
  try {
    return ctx.get?.(name) ?? undefined
  } catch {
    return undefined
  }
}

function homeDir() {
  const fromEnv = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  return fromEnv ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh')
}

function stateFile() {
  return join(homeDir(), 'dsh-context-console', 'state.json')
}

const num = (value, fallback) => {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback
  const raw = String(value).trim().toLowerCase().replace(/[,\s_]/g, '')
  if (raw === '') return fallback
  const match = /^(\d+(?:\.\d+)?)([kmbt])?$/.exec(raw)
  if (!match) return fallback
  const scale = match[2] === 'k' ? 1024 : match[2] === 'm' ? 1048576 : match[2] === 'b' ? 1073741824 : match[2] === 't' ? 1099511627776 : 1
  const parsed = Number(match[1]) * scale
  return Number.isFinite(parsed) ? parsed : fallback
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

/**
 * 把任意来源的输入收敛成一份可用状态。
 * 所有互相约束的字段都在这里兜住，绝不让非法组合流到运行时：
 * `retainRatio` 必须小于 `thresholdRatio`（否则压缩引擎每次都会抛错），
 * `head + marker + tail` 必须装进 `thresholdChars`（否则裁剪器拒绝改写）。
 */
export function normalize(raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const compactionInput = input.compaction && typeof input.compaction === 'object' ? input.compaction : {}
  const toolsInput = input.tools && typeof input.tools === 'object' ? input.tools : {}

  const thresholdRatio = clamp(num(compactionInput.thresholdRatio, DEFAULTS.compaction.thresholdRatio), 0.3, 0.98)
  const retainRatio = clamp(
    num(compactionInput.retainRatio, DEFAULTS.compaction.retainRatio),
    0,
    Math.max(0, thresholdRatio - 0.02),
  )
  const headroomTokens = clamp(
    Math.round(num(compactionInput.headroomTokens, DEFAULTS.compaction.headroomTokens)),
    0,
    4_000_000,
  )

  const thresholdChars = clamp(
    Math.round(num(toolsInput.thresholdChars, DEFAULTS.tools.thresholdChars)),
    512,
    4_000_000,
  )
  let headChars = clamp(Math.round(num(toolsInput.headChars, DEFAULTS.tools.headChars)), 0, thresholdChars)
  let tailChars = clamp(Math.round(num(toolsInput.tailChars, DEFAULTS.tools.tailChars)), 0, thresholdChars)
  if (headChars + MARKER_RESERVE + tailChars > thresholdChars) {
    // 按原比例缩进预算内，保证裁剪器不会因为「保留得比阈值还多」而失灵。
    const budget = Math.max(0, thresholdChars - MARKER_RESERVE)
    const total = headChars + tailChars || 1
    headChars = Math.floor((headChars / total) * budget)
    tailChars = Math.max(0, budget - headChars)
  }

  const reasoningDefault = THINKING_LEVELS.includes(input.reasoningDefault) ? input.reasoningDefault : ''

  return {
    contextCap: clamp(Math.round(num(input.contextCap, DEFAULTS.contextCap)), 0, 20_000_000),
    reasoningDefault,
    compaction: { thresholdRatio, retainRatio, headroomTokens },
    tools: { thresholdChars, headChars, tailChars },
  }
}

/* ------------------------------------------------------------------ *
 * 状态：内存中的当前值 + 落盘
 * ------------------------------------------------------------------ */

let current = normalize({})
/** 最近一次套用结果，`/state` 直接回传，便于看出哪组没生效。 */
let lastReport = { llm: false, presets: 0, presetIds: [], notes: [] }

let stateLoaded = false

function loadState() {
  try {
    current = normalize(JSON.parse(readFileSync(stateFile(), 'utf8')))
    stateLoaded = true
  } catch {
    current = normalize({})
    // 没读到本地状态时不要拿默认值去覆盖 profile 里已经落盘的值。
    stateLoaded = false
  }
  return current
}

function saveState() {
  const file = stateFile()
  try {
    mkdirSync(dirname(file), { recursive: true })
    const temp = `${file}.tmp`
    writeFileSync(temp, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
    renameSync(temp, file)
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ *
 * 第 1、2 组：上下文上限 + 默认思考等级（拦截 llm 服务）
 * ------------------------------------------------------------------ */

/** 已经拦过的 llm 实例，避免热重载时重复包一层。 */
const patchedLlms = new WeakSet()

function clampInfo(info) {
  const cap = current.contextCap
  if (!info || typeof info !== 'object') return info
  if (!cap || cap <= 0) return info
  const window = info.context?.contextWindow
  const next = { ...info }
  if (Number.isInteger(window) && window > cap) next.context = { contextWindow: cap }
  // 输出预算跟着窗口走：留 1/4 给回复，避免 64K 窗口配 384K 输出把预算算成负数。
  if (Number.isInteger(info.defaultMaxTokens) && info.defaultMaxTokens > Math.floor(cap / 4)) {
    next.defaultMaxTokens = Math.max(1024, Math.floor(cap / 4))
  }
  return next
}

function withReasoningDefault(config, info) {
  const level = current.reasoningDefault
  if (!level) return config
  if (!config || typeof config !== 'object') return config
  if (config.reasoningEffort !== undefined) return config
  const efforts = info?.reasoning?.efforts
  if (!Array.isArray(efforts) || !efforts.some((effort) => effort?.id === level)) return config
  return { ...config, reasoningEffort: level }
}

function patchLlm(ctx) {
  const llm = service(ctx, 'llm')
  if (!llm || typeof llm !== 'object' || patchedLlms.has(llm)) return Boolean(llm)
  try {
    // 只包这一个汇聚点：`resolveModelInfo` 和 `resolveModelInfoFor` 最终都会走到它，
    // 包两层会互相叠加（连「原值」都读不出来），只包这一层还能留一条干净的取数通道。
    const originalNormalize = llm.normalizeModelInfo
    if (typeof originalNormalize === 'function') {
      llm.normalizeModelInfo = function patchedNormalizeModelInfo(registration, model, resolved) {
        return clampInfo(originalNormalize.call(this, registration, model, resolved))
      }
    }
    const originalCall = llm.resolveCallWithInfo
    if (typeof originalCall === 'function') {
      llm.resolveCallWithInfo = function patchedResolveCallWithInfo(config, info) {
        return originalCall.call(this, withReasoningDefault(config, info), info)
      }
    }
    patchedLlms.add(llm)
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ *
 * 第 3、4 组：把阈值写进每个 agent 预设的 compaction 组
 * ------------------------------------------------------------------ */

/** 把阈值套到一份预设插件的行数组上，返回新数组（不改原对象）。 */
function patchPluginRows(rows) {
  if (!Array.isArray(rows)) return rows
  return rows.map((row) => {
    if (!row || row.id !== 'compaction' || !Array.isArray(row.config)) return row
    const children = row.config.map((child) => {
      if (!child) return child
      if (child.id === 'compaction-basic') {
        return {
          ...child,
          config: {
            ...(child.config ?? {}),
            thresholdRatio: current.compaction.thresholdRatio,
            retainRatio: current.compaction.retainRatio,
            headroomTokens: current.compaction.headroomTokens,
          },
        }
      }
      if (child.id === 'tool-result-pruner') {
        return {
          ...child,
          config: {
            ...(child.config ?? {}),
            thresholdChars: current.tools.thresholdChars,
            headChars: current.tools.headChars,
            tailChars: current.tools.tailChars,
          },
        }
      }
      return child
    })
    return { ...row, config: children }
  })
}

/** 收集可写的预设行：名字对得上，且 plugins 里真的有 compaction 组。 */
function presetEntries(configEditor) {
  let entries = []
  try {
    entries = configEditor.entries()
  } catch {
    return []
  }
  return entries.filter((entry) => {
    const options = entry?.options ?? entry
    if (options?.name !== PRESET_NAME) return false
    const plugins = options?.config?.plugins
    return Array.isArray(plugins) && plugins.some((row) => row?.id === 'compaction' && Array.isArray(row.config))
  })
}

/** 读一份预设里当前生效的阈值，用于面板回显（取第一个预设的 compaction 组）。 */
function readPresetValues(configEditor) {
  const entries = presetEntries(configEditor)
  if (entries.length === 0) return null
  const options = entries[0]?.options ?? entries[0]
  const group = options.config.plugins.find((row) => row.id === 'compaction')
  const basic = group.config.find((row) => row.id === 'compaction-basic')
  const pruner = group.config.find((row) => row.id === 'tool-result-pruner')
  return {
    presetId: options.id,
    compaction: basic?.config ?? null,
    tools: pruner?.config ?? null,
  }
}

/**
 * 把当前阈值写进所有预设行。
 *
 * `configEditor.edit` 会校验 schema、落盘到 profile 的 `cordis.patch.yml`、并让 Loader
 * 重新材质化这些预设行——所以新开的会话天然拿到新值，重启也还在。
 *
 * 两处保守处理：
 *   * 值已经一致就跳过，避免每次开面板都重写文件；
 *   * 首次写入前把原 patch 文件另存一份，改坏了能一键比对回去。
 */
let patchBackedUp = false

function backupPatch(configEditor) {
  if (patchBackedUp) return
  patchBackedUp = true
  try {
    const path = configEditor.patchPath ?? configEditor.documentPath
    if (!path) return
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    writeFileSync(`${path}.bak-console-${stamp}`, readFileSync(path, 'utf8'), 'utf8')
  } catch {
    /* 备份失败不影响写入 */
  }
}

/** 判断一份预设的压缩阈值是否已经是目标值（缺省字段按引擎默认值算）。 */
function presetMatches(options) {
  const plugins = Array.isArray(options?.config?.plugins) ? options.config.plugins : []
  const group = plugins.find((row) => row?.id === 'compaction')
  if (!group || !Array.isArray(group.config)) return false
  const basic = { ...DEFAULTS.compaction, ...(group.config.find((row) => row?.id === 'compaction-basic')?.config ?? {}) }
  const prunerRow = group.config.find((row) => row?.id === 'tool-result-pruner')?.config
  const pruner = prunerRow === undefined ? null : { ...DEFAULTS.tools, ...prunerRow }
  const basicOk =
    basic.thresholdRatio === current.compaction.thresholdRatio &&
    basic.retainRatio === current.compaction.retainRatio &&
    basic.headroomTokens === current.compaction.headroomTokens
  const prunerOk =
    pruner === null ||
    (pruner.thresholdChars === current.tools.thresholdChars &&
      pruner.headChars === current.tools.headChars &&
      pruner.tailChars === current.tools.tailChars)
  return basicOk && prunerOk
}

async function writePresets(ctx) {
  const configEditor = service(ctx, 'configEditor')
  if (!configEditor || typeof configEditor.edit !== 'function') {
    return { count: 0, ids: [], error: '配置编辑器不可用' }
  }
  const entries = presetEntries(configEditor)
  if (entries.length === 0) return { count: 0, ids: [], error: '没找到带压缩组的 agent 预设' }
  const ids = []
  for (const entry of entries) {
    const options = entry?.options ?? entry
    if (presetMatches(options)) {
      ids.push(options.id ?? '?')
      continue
    }
    try {
      backupPatch(configEditor)
      await configEditor.edit(entry, (config) => ({
        ...(config ?? {}),
        // 注意：profile 的预设行是「整体替换」而非按 id 合并（实测 plugins 只剩传入的那几行），
        // 所以必须交回完整快照，只改 compaction 组里的两个子行。
        plugins: patchPluginRows(config?.plugins),
      }))
      ids.push(options.id ?? '?')
    } catch (error) {
      return { count: ids.length, ids, error: `${options.id ?? '?'}: ${String(error?.message ?? error)}` }
    }
  }
  return { count: ids.length, ids, error: null }
}

/* ------------------------------------------------------------------ *
 * 套用总入口
 * ------------------------------------------------------------------ */

export function applyLive(ctx) {
  const notes = []
  const llm = patchLlm(ctx)
  if (!llm) notes.push('llm 尚未就绪')
  if (!service(ctx, 'configEditor')) notes.push('配置编辑器不可用：压缩/裁剪两组只能读')
  lastReport = { ...lastReport, llm, notes }
  return lastReport
}

/* ------------------------------------------------------------------ *
 * 面板路由
 * ------------------------------------------------------------------ */

/** 模型清单缓存：面板要显示「哪些模型会被这条上限削到」。 */
let catalogCache = { at: 0, models: [] }

/**
 * 从配置树里读「目录声明的窗口」。
 *
 * 不能拿 `llm.resolveModelInfo` 反推——那已经是钳过的值。配置树才是原始声明：
 *   * `llm-pi-ai`：`providers.<id>.models[].contextWindow`，缺省用它自己的 `defaultContextWindow`
 *   * `llm-deepseek`：`models[].contextWindow`
 */
function declaredWindows(ctx) {
  const map = new Map()
  const configEditor = service(ctx, 'configEditor')
  if (!configEditor) return map
  let rows = []
  try {
    rows = configEditor.entries()
  } catch {
    return map
  }
  for (const entry of rows) {
    const options = entry?.options ?? entry
    const config = options?.config
    if (!config || typeof config !== 'object') continue
    if (options.id === 'llm-pi-ai') {
      const providers = config.providers && typeof config.providers === 'object' ? config.providers : {}
      for (const [providerId, profile] of Object.entries(providers)) {
        const fallback = profile?.defaultContextWindow
        for (const model of Array.isArray(profile?.models) ? profile.models : []) {
          const window = model?.contextWindow ?? fallback
          if (Number.isInteger(window) && model?.id) map.set(`${providerId}/${model.id}`, window)
        }
      }
    }
    if (options.id === 'llm-deepseek') {
      for (const model of Array.isArray(config.models) ? config.models : []) {
        if (Number.isInteger(model?.contextWindow) && model?.id) map.set(`deepseek/${model.id}`, model.contextWindow)
      }
    }
  }
  return map
}

async function readCatalog(ctx) {
  if (Date.now() - catalogCache.at < 15_000) return catalogCache.models
  const llm = service(ctx, 'llm')
  if (!llm || typeof llm.listProviders !== 'function') return []
  const declared = declaredWindows(ctx)
  const models = []
  let providers = []
  try {
    providers = llm.listProviders()
  } catch {
    return []
  }
  for (const provider of providers) {
    let list = []
    try {
      list = await llm.listModels(provider.id)
    } catch {
      continue
    }
    for (const model of list) {
      let effective
      try {
        const info = await llm.resolveModelInfo(provider.id, model.id)
        effective = info?.context?.contextWindow
      } catch {
        effective = undefined
      }
      const declaredValue = declared.get(`${provider.id}/${model.id}`) ?? null
      const effectiveValue = Number.isInteger(effective) ? effective : null
      models.push({
        provider: provider.id,
        providerName: provider.name ?? provider.id,
        id: model.id,
        name: model.name ?? model.id,
        declared: declaredValue,
        effective: effectiveValue,
        limited: declaredValue !== null && effectiveValue !== null && effectiveValue < declaredValue,
      })
    }
  }
  catalogCache = { at: Date.now(), models }
  return models
}

async function buildState(ctx) {
  const models = await readCatalog(ctx)
  const configEditor = service(ctx, 'configEditor')
  const preset = configEditor ? readPresetValues(configEditor) : null
  return {
    config: current,
    report: lastReport,
    defaults: DEFAULTS,
    levels: THINKING_LEVELS,
    stateFile: stateFile(),
    preset,
    models,
  }
}

function installRoutes(ctx) {
  const webServer = service(ctx, 'webServer')
  if (!webServer) return () => {}

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  const route = (path, handler) =>
    ctx.effect(() =>
      webServer.register({
        kind: 'exact',
        path,
        // 任何未捕获异常都会让宿主层直接回一个空 400，问题就查无实据了。
        // 统一在这里兜住，把真正的原因交回面板。
        handler: async (req, res) => {
          try {
            await handler(req, res)
          } catch (error) {
            if (res.headersSent) {
              res.destroy()
              return
            }
            send(res, 500, { error: 'handler-failed', message: String(error?.message ?? error) })
          }
        },
      }),
    )

  route(`${API}/state`, async (req, res) => {
    if (req.method !== 'GET') return send(res, 405, { error: 'method-not-allowed' })
    try {
      applyLive(ctx)
    } catch {
      /* 套用失败不该挡住读状态 */
    }
    send(res, 200, await buildState(ctx))
  })

  route(`${API}/apply`, async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { error: 'method-not-allowed' })
    let raw = ''
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > 32 * 1024) return send(res, 413, { error: 'payload-too-large' })
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      return send(res, 400, { error: 'invalid-json' })
    }
    current = normalize({ ...current, ...parsed })
    // 上限一变，清单里的 limited/effective 就全变了；不能拿 15 秒内的旧缓存回给面板。
    catalogCache = { at: 0, models: [] }
    const persisted = saveState()
    applyLive(ctx)
    const written = await writePresets(ctx)
    lastReport = {
      ...lastReport,
      presets: written.count,
      presetIds: written.ids,
      notes: [
        ...lastReport.notes,
        ...(written.error ? [`预设写入未完成：${written.error}`] : []),
        ...(persisted ? [] : ['写入 state.json 失败']),
      ],
    }
    send(res, 200, await buildState(ctx))
  })

  route(`${API}/reset`, async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { error: 'method-not-allowed' })
    current = normalize({})
    catalogCache = { at: 0, models: [] }
    const persisted = saveState()
    applyLive(ctx)
    const written = await writePresets(ctx)
    lastReport = {
      ...lastReport,
      presets: written.count,
      presetIds: written.ids,
      notes: [
        ...(written.error ? [`预设写入未完成：${written.error}`] : []),
        ...(persisted ? [] : ['写入 state.json 失败']),
      ],
    }
    send(res, 200, await buildState(ctx))
  })

  // 自检：目录声明的窗口 vs llm 实际返回的窗口，证明上限真的生效
  route(`${API}/probe`, async (req, res) => {
    catalogCache = { at: 0, models: [] }
    const models = await readCatalog(ctx)
    send(res, 200, {
      cap: current.contextCap,
      total: models.length,
      limited: models.filter((model) => model.limited).map((model) => ({
        route: `${model.provider}/${model.id}`,
        declared: model.declared,
        effective: model.effective,
      })),
      sample: models.slice(0, 8).map((model) => ({
        route: `${model.provider}/${model.id}`,
        declared: model.declared,
        effective: model.effective,
      })),
    })
  })

  // 诊断：预设行的「当前层 / 继承层 / 覆盖层」到底长什么样
  route(`${API}/inspect`, async (req, res) => {
    const configEditor = service(ctx, 'configEditor')
    if (!configEditor || typeof configEditor.configuration !== 'function') {
      return send(res, 503, { error: 'config-editor-unavailable' })
    }
    try {
      const rows = configEditor.configuration()
      const pick = (config) => {
        const plugins = Array.isArray(config?.plugins) ? config.plugins : []
        const persona = plugins.find((row) => row?.id === 'persona')
        const group = plugins.find((row) => row?.id === 'compaction')
        return {
          pluginCount: plugins.length,
          personaPrefix: persona?.config?.prefix ?? null,
          compactionRows: Array.isArray(group?.config) ? group.config.map((row) => row?.id) : null,
        }
      }
      const presets = rows
        .filter((row) => (row.entry?.options ?? row.entry)?.name === PRESET_NAME)
        .map((row) => ({
          id: (row.entry?.options ?? row.entry)?.id,
          current: pick(row.entry?.options?.config),
          inherited: pick(row.inherited),
          override: Object.keys(row.override ?? {}),
          personaRow: (() => {
            const plugins = Array.isArray(row.entry?.options?.config?.plugins) ? row.entry.options.config.plugins : []
            const persona = plugins.find((item) => item?.id === 'persona')
            try {
              return JSON.stringify(persona).slice(0, 500)
            } catch {
              return 'unserializable'
            }
          })(),
        }))
      send(res, 200, { presets })
    } catch (error) {
      send(res, 500, { error: 'inspect-failed', message: String(error?.message ?? error) })
    }
  })

  return () => {}
}

/* ------------------------------------------------------------------ *
 * 挂载
 * ------------------------------------------------------------------ */

export function apply(ctx) {
  loadState()
  catalogCache = { at: 0, models: [] }
  const disposeRoutes = installRoutes(ctx)

  // llm / configEditor 往往晚于插件本体就绪，启动后补几次。
  // 用全局 setTimeout 而不是 ctx.setTimeout：后者需要额外 inject 'timer'。
  const timers = []
  const retry = () => {
    try {
      applyLive(ctx)
    } catch {
      /* 下一轮再说 */
    }
  }
  for (const delay of [0, 250, 1200, 4000]) {
    const handle = setTimeout(retry, delay)
    if (typeof handle?.unref === 'function') handle.unref()
    timers.push(handle)
  }

  let offService = () => {}
  if (typeof ctx.on === 'function') {
    try {
      offService = ctx.on('internal/service', retry) ?? (() => {})
    } catch {
      offService = () => {}
    }
  }

  // 启动时对齐一次预设：只统计已匹配的行（零写入）来喂报告里的 presets 计数，
  // 只有「state.json 读到了、且与 profile 漂移」时才真的落盘，
  // 避免状态文件丢失时用默认值把用户已生效的阈值覆盖掉。
  const alignTimer = setTimeout(async () => {
    try {
      const configEditor = service(ctx, 'configEditor')
      if (!configEditor) return
      const entries = presetEntries(configEditor)
      if (entries.length === 0) return
      const matched = entries.filter((entry) => presetMatches(entry?.options ?? entry))
      if (matched.length === entries.length) {
        lastReport = {
          ...lastReport,
          presets: matched.length,
          presetIds: entries.map((entry) => (entry?.options ?? entry)?.id ?? '?'),
        }
        return
      }
      if (!stateLoaded) return
      const result = await writePresets(ctx)
      if (!result.error) {
        lastReport = { ...lastReport, presets: result.count, presetIds: result.ids }
      }
    } catch {
      /* 面板里手动再点一次即可 */
    }
  }, 6000)
  if (typeof alignTimer?.unref === 'function') alignTimer.unref()

  ctx.effect(
    () => () => {
      for (const handle of timers) clearTimeout(handle)
      clearTimeout(alignTimer)
      disposeRoutes?.()
      offService?.()
    },
    'dsh-context-console: routes and listeners',
  )
}

export default {
  name,
  inject,
  apply,
}
