window.__ModuleLoader__.load({
  id: 'dsh-context-console',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    // 模块表可能给回命名空间本身或套了 default 的对象，两种都兜住。
    const hooks = React.useState ? React : React.default || {}
    const useState = hooks.useState
    const useEffect = hooks.useEffect
    const useRef = hooks.useRef
    const useCallback = hooks.useCallback

    const PANEL_KEY = 'context-console'
    const API = '/context-console/api'
    const MUTED = 'rgba(127,127,127,0.78)'
    const LINE = 'rgba(127,127,127,0.24)'
    const PANEL_BG = 'rgba(127,127,127,0.045)'
    const ACCENT = '#4b8bf5'
    const WARN = '#d9822b'

    const ComponentBase = React.Component || hooks.Component
    class Boundary extends ComponentBase {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error: String((error && error.message) || error) }
      }
      render() {
        if (this.state.error !== null) {
          return h('div', { style: { padding: '18px 22px', fontSize: 12, lineHeight: 1.7, color: WARN } }, [
            h('strong', { key: 't', style: { display: 'block', marginBottom: 6 } }, '上下文控制台渲染失败'),
            h('code', { key: 'm', style: { fontSize: 11 } }, this.state.error),
          ])
        }
        return this.props.children
      }
    }

    function ConsoleIcon({ size }) {
      const s = size || 18
      return h(
        'svg',
        {
          width: s,
          height: s,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
        },
        [
          h('rect', { key: 'a', x: 3, y: 4.5, width: 18, height: 15, rx: 2.5 }),
          h('path', { key: 'b', d: 'M7 9.5h6M7 13h4' }),
          h('path', { key: 'c', d: 'M15.5 9.2v5.6M13.4 12.6l2.1 2.2 2.1-2.2' }),
        ],
      )
    }

    const CAP_PRESETS = [
      { label: '不限', value: 0 },
      { label: '32K', value: 32768 },
      { label: '64K', value: 65536 },
      { label: '128K', value: 131072 },
      { label: '256K', value: 262144 },
      { label: '512K', value: 524288 },
      { label: '1M', value: 1048576 },
    ]

    function formatTokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '—'
      if (value >= 1048576 && value % 1048576 === 0) return `${value / 1048576}M`
      if (value >= 1024 && value % 1024 === 0) {
        const k = value / 1024
        return k >= 1024 ? `${(k / 1024).toFixed(k % 1024 === 0 ? 0 : 1)}M` : `${k}K`
      }
      return value.toLocaleString('en-US')
    }

    function parseTokens(text) {
      const raw = String(text ?? '').trim().toLowerCase().replace(/[,\s_]/g, '')
      if (raw === '') return null
      const match = /^(\d+(?:\.\d+)?)([kKmMbBtT])?$/.exec(raw)
      if (!match) return null
      const unit = (match[2] || '').toUpperCase()
      const scale = unit === 'K' ? 1024 : unit === 'M' ? 1048576 : unit === 'B' ? 1073741824 : unit === 'T' ? 1099511627776 : 1
      const value = Math.round(Number(match[1]) * scale)
      return Number.isFinite(value) && value > 0 ? value : null
    }

    /* ---------------------------------------------------------------- *
     * 小组件
     * ---------------------------------------------------------------- */

    function Card({ title, subtitle, children, badge }) {
      return h(
        'section',
        {
          style: {
            border: `1px solid ${LINE}`,
            borderRadius: 12,
            background: PANEL_BG,
            padding: '14px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          },
        },
        [
          h('header', { key: 'head', style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } }, [
            h('strong', { key: 't', style: { fontSize: 13.5, letterSpacing: 0.2 } }, title),
            subtitle
              ? h('span', { key: 's', style: { fontSize: 11.5, color: MUTED } }, subtitle)
              : null,
            badge
              ? h(
                  'span',
                  {
                    key: 'b',
                    style: {
                      marginLeft: 'auto',
                      fontSize: 11,
                      padding: '1px 8px',
                      borderRadius: 999,
                      border: `1px solid ${LINE}`,
                      color: MUTED,
                    },
                  },
                  badge,
                )
              : null,
          ]),
          children,
        ],
      )
    }

    function Chip({ active, onClick, children, title }) {
      return h(
        'button',
        {
          type: 'button',
          onClick,
          title,
          style: {
            padding: '5px 11px',
            borderRadius: 8,
            fontSize: 12,
            cursor: 'pointer',
            border: `1px solid ${active ? ACCENT : LINE}`,
            background: active ? 'rgba(75,139,245,0.14)' : 'transparent',
            color: 'inherit',
            fontWeight: active ? 600 : 400,
            transition: 'background 120ms ease, border-color 120ms ease',
          },
        },
        children,
      )
    }

    function NumField({ label, value, onCommit, suffix, min, max, hint }) {
      const [text, setText] = useState(String(value ?? ''))
      useEffect(() => {
        setText(String(value ?? ''))
      }, [value])
      const commit = () => {
        const parsed = parseTokens(text)
        if (parsed === null) {
          setText(String(value ?? ''))
          return
        }
        const bounded = Math.min(max ?? Number.MAX_SAFE_INTEGER, Math.max(min ?? 0, parsed))
        setText(String(bounded))
        if (bounded !== value) onCommit(bounded)
      }
      return h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 120 } }, [
        h('span', { key: 'l', style: { fontSize: 11.5, color: MUTED } }, label),
        h(
          'span',
          { key: 'i', style: { display: 'flex', alignItems: 'center', gap: 6 } },
          [
            h('input', {
              key: 'in',
              value: text,
              onChange: (event) => setText(event.target.value),
              onBlur: commit,
              onKeyDown: (event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
              },
              spellCheck: false,
              style: {
                flex: 1,
                minWidth: 0,
                padding: '6px 9px',
                fontSize: 12.5,
                fontVariantNumeric: 'tabular-nums',
                borderRadius: 8,
                border: `1px solid ${LINE}`,
                background: 'transparent',
                color: 'inherit',
                outline: 'none',
              },
            }),
            suffix ? h('span', { key: 'suf', style: { fontSize: 11, color: MUTED } }, suffix) : null,
          ],
        ),
        hint ? h('span', { key: 'h', style: { fontSize: 10.5, color: MUTED, lineHeight: 1.5 } }, hint) : null,
      ])
    }

    function Row({ children }) {
      return h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap' } }, children)
    }

    /* ---------------------------------------------------------------- *
     * 面板主体
     * ---------------------------------------------------------------- */

    function Panel() {
      const [state, setState] = useState(null)
      const [config, setConfig] = useState(null)
      const [error, setError] = useState(null)
      const [saving, setSaving] = useState(false)
      const [savedAt, setSavedAt] = useState(0)
      const timer = useRef(null)
      const pending = useRef(null)

      const load = useCallback(async () => {
        try {
          const response = await fetch(`${API}/state`, { headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const data = await response.json()
          setState(data)
          setConfig(data.config)
          setError(null)
        } catch (cause) {
          setError(String((cause && cause.message) || cause))
        }
      }, [])

      useEffect(() => {
        void load()
      }, [load])

      const flush = useCallback(async () => {
        const body = pending.current
        pending.current = null
        if (!body) return
        setSaving(true)
        try {
          const response = await fetch(`${API}/apply`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const data = await response.json()
          setState(data)
          // 服务端会把越界值收敛后再回显；但若用户在这一轮请求期间又动了控件，
          // 本地已经有更新的值，不能被这个旧响应盖回去。
          if (pending.current === null) setConfig(data.config)
          setError(null)
          setSavedAt(Date.now())
        } catch (cause) {
          setError(String((cause && cause.message) || cause))
        } finally {
          setSaving(false)
        }
      }, [])

      const push = useCallback(
        (patch) => {
          setConfig((prev) => {
            const next = { ...prev, ...patch }
            pending.current = next
            return next
          })
          if (timer.current) clearTimeout(timer.current)
          timer.current = setTimeout(() => void flush(), 420)
        },
        [flush],
      )

      const pushNested = useCallback(
        (group, key, value) => {
          setConfig((prev) => {
            const next = { ...prev, [group]: { ...prev[group], [key]: value } }
            pending.current = next
            return next
          })
          if (timer.current) clearTimeout(timer.current)
          timer.current = setTimeout(() => void flush(), 420)
        },
        [flush],
      )

      const reset = useCallback(async () => {
        setSaving(true)
        try {
          const response = await fetch(`${API}/reset`, { method: 'POST' })
          const data = await response.json()
          setState(data)
          setConfig(data.config)
          setSavedAt(Date.now())
          setError(null)
        } catch (cause) {
          setError(String((cause && cause.message) || cause))
        } finally {
          setSaving(false)
        }
      }, [])

      if (error !== null && state === null) {
        return h('div', { style: { padding: 24, fontSize: 12.5, lineHeight: 1.8, color: WARN } }, [
          h('strong', { key: 't', style: { display: 'block', marginBottom: 6 } }, '拿不到宿主端状态'),
          h('code', { key: 'm', style: { fontSize: 11 } }, error),
        ])
      }

      if (state === null || config === null) {
        return h('div', { style: { padding: 24, fontSize: 12.5, color: MUTED } }, '正在读取运行时状态…')
      }

      const report = state.report || {}
      const models = Array.isArray(state.models) ? state.models : []
      const capped = models.filter((model) => model.limited === true)
      const cap = config.contextCap
      const thresholdTokens = cap > 0 ? Math.round(cap * config.compaction.thresholdRatio) : null
      const retainTokens = cap > 0 ? Math.round(cap * config.compaction.retainRatio) : null
      const needsLlm = cap > 0 || Boolean(config.reasoningDefault)
      const llmOk = report.llm === true || !needsLlm
      const presetOk = Number(report.presets || 0) > 0
      const healthy = llmOk && presetOk
      const unhealthyReason = healthy
        ? ''
        : !presetOk
          ? '压缩 / 裁剪配置尚未写入 agent 预设'
          : '模型信息拦截未安装'

      // 滑杆范围必须覆盖 normalize 允许的边界（阈值 30%–98%，保留区 0 – 阈值-2%），
      // 否则值一旦落在范围外就会被浏览器钳到端点，标签和滑块位置对不上。
      const ratioPct = Math.min(98, Math.max(30, Math.round(config.compaction.thresholdRatio * 100)))
      const retainMax = Math.max(0, ratioPct - 2)
      const retainPct = Math.min(retainMax, Math.max(0, Math.round(config.compaction.retainRatio * 100)))

      const header = h('header', { key: 'head', style: { display: 'flex', flexDirection: 'column', gap: 6 } }, [
        h('div', { key: 'row', style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } }, [
          h('h1', { key: 'h', style: { margin: 0, fontSize: 17, fontWeight: 600, letterSpacing: 0.3 } }, '上下文控制台'),
          h(
            'span',
            {
              key: 'badge',
              title: healthy ? '所有配置均已作用到运行中的实例' : unhealthyReason,
              style: {
                fontSize: 11,
                padding: '2px 9px',
                borderRadius: 999,
                border: `1px solid ${healthy ? 'rgba(76,175,80,0.5)' : LINE}`,
                color: healthy ? '#4caf50' : MUTED,
              },
            },
            healthy ? '全部生效' : '部分服务未就绪',
          ),
          saving
            ? h('span', { key: 's', style: { fontSize: 11, color: MUTED } }, '保存中…')
            : savedAt
              ? h('span', { key: 's', style: { fontSize: 11, color: MUTED } }, '已保存')
              : null,
        ]),
        h(
          'p',
          { key: 'sub', style: { margin: 0, fontSize: 11.5, color: MUTED, lineHeight: 1.7 } },
          '这里的每一项都直接作用在正在运行的服务实例上：改完立刻对「所有会话」生效，包括已经开着的窗口。无需重启。',
        ),
      ])

      const capCard = h(Card, {
        key: 'cap',
        title: '上下文上限',
        subtitle: '所有模型、所有会话统一的窗口天花板',
        badge: cap > 0 ? `生效 ${formatTokens(cap)}` : '不限制',
      }, [
        h(Row, { key: 'presets' }, CAP_PRESETS.map((preset) =>
          h(Chip, {
            key: preset.value,
            active: Number(cap) === preset.value,
            onClick: () => push({ contextCap: preset.value }),
          }, preset.label),
        )),
        h(Row, { key: 'num' }, [
          h(NumField, {
            key: 'n',
            label: '自定义上限',
            value: cap,
            min: 0,
            max: 20_000_000,
            suffix: 'tokens',
            hint: '0 = 不限制；支持 128K / 1M 写法。默认输出预算会跟着收到上限的 1/4。',
            onCommit: (value) => push({ contextCap: value }),
          }),
        ]),
        h(
          'p',
          { key: 'stat', style: { margin: 0, fontSize: 11.5, color: MUTED, lineHeight: 1.7 } },
          cap > 0
            ? `目录里 ${models.length} 个模型，其中 ${capped.length} 个会被这条上限削到` +
                (capped.length > 0
                  ? `：${capped
                      .slice(0, 4)
                      .map((m) => `${m.id} ${formatTokens(m.declared)}→${formatTokens(m.effective)}`)
                      .join('，')}${capped.length > 4 ? ' …' : ''}`
                  : '')
            : '当前不限制，各模型按目录里的原始窗口运行。',
        ),
      ])

      const thinkLevels = [
        { value: '', label: '跟随模型' },
        ...(state.levels || []).map((level) => ({ value: level, label: level === 'off' ? '关（off）' : level })),
      ]
      const reasoningCard = h(Card, {
        key: 'reasoning',
        title: '默认思考等级',
        subtitle: '只在你没手动选过档位时补默认值',
        badge: config.reasoningDefault || '跟随模型',
      }, [
        h(Row, { key: 'chips' }, thinkLevels.map((level) =>
          h(Chip, {
            key: level.value || 'auto',
            active: (config.reasoningDefault || '') === level.value,
            onClick: () => push({ reasoningDefault: level.value }),
            title: level.value ? `默认用 ${level.value} 思考` : '不干预，按模型/提供方的默认',
          }, level.label),
        )),
        h(
          'p',
          { key: 'note', style: { margin: 0, fontSize: 11.5, color: MUTED, lineHeight: 1.7 } },
          '模型不支持该档位时会自动跳过，不会让请求报错。会话里手动挑过的档位优先。',
        ),
      ])

      const compactionCard = h(Card, {
        key: 'compaction',
        title: '自动压缩',
        subtitle: '整段对话写检查点的触发点与保留区',
        badge: `${Math.round(config.compaction.thresholdRatio * 100)}%`,
      }, [
        h('div', { key: 'slider', style: { display: 'flex', flexDirection: 'column', gap: 4 } }, [
          h('div', { key: 'lab', style: { display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: MUTED } }, [
            h('span', { key: 'l' }, `触发阈值 ${Math.round(config.compaction.thresholdRatio * 100)}%`),
            h('span', { key: 'r' }, thresholdTokens ? `≈ ${formatTokens(thresholdTokens)} tokens 时开始压缩` : '按各模型窗口比例'),
          ]),
          h('input', {
            key: 'r',
            type: 'range',
            min: 30,
            max: 98,
            step: 1,
            value: ratioPct,
            onChange: (event) => pushNested('compaction', 'thresholdRatio', Number(event.target.value) / 100),
            style: { width: '100%', accentColor: ACCENT },
          }),
        ]),
        h('div', { key: 'slider2', style: { display: 'flex', flexDirection: 'column', gap: 4 } }, [
          h('div', { key: 'lab', style: { display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: MUTED } }, [
            h('span', { key: 'l' }, `尾部保留 ${Math.round(config.compaction.retainRatio * 100)}%`),
            h('span', { key: 'r' }, retainTokens ? `≈ ${formatTokens(retainTokens)} tokens 原样留着` : '按比例'),
          ]),
          h('input', {
            key: 'r',
            type: 'range',
            min: 0,
            max: retainMax,
            step: 1,
            value: retainPct,
            onChange: (event) => pushNested('compaction', 'retainRatio', Number(event.target.value) / 100),
            style: { width: '100%', accentColor: ACCENT },
          }),
        ]),
        h(Row, { key: 'num' }, [
          h(NumField, {
            key: 'head',
            label: '预留余量 headroom',
            value: config.compaction.headroomTokens,
            min: 0,
            max: 4_000_000,
            suffix: 'tokens',
            hint: '压缩后要给下一轮回复留的空间，窗口越小越该跟着调小。',
            onCommit: (value) => pushNested('compaction', 'headroomTokens', value),
          }),
        ]),
        h(
          'p',
          { key: 'note', style: { margin: 0, fontSize: 11.5, color: MUTED, lineHeight: 1.7 } },
          '已有的「按模型自适应」策略会一起对齐到同一组阈值，避免面板显示 60% 而实际还按 80% 触发。',
        ),
      ])

      const toolsCard = h(Card, {
        key: 'tools',
        title: '工具结果裁剪',
        subtitle: '旧轮次里超长的 tool/result 正文',
        badge: `${formatTokens(config.tools.thresholdChars)} 字符起`,
      }, [
        h(Row, { key: 'nums' }, [
          h(NumField, {
            key: 't',
            label: '超过即裁剪',
            value: config.tools.thresholdChars,
            min: 512,
            max: 4_000_000,
            suffix: '字符',
            onCommit: (value) => pushNested('tools', 'thresholdChars', value),
          }),
          h(NumField, {
            key: 'h',
            label: '保留开头',
            value: config.tools.headChars,
            min: 0,
            max: 4_000_000,
            suffix: '字符',
            onCommit: (value) => pushNested('tools', 'headChars', value),
          }),
          h(NumField, {
            key: 'a',
            label: '保留结尾',
            value: config.tools.tailChars,
            min: 0,
            max: 4_000_000,
            suffix: '字符',
            onCommit: (value) => pushNested('tools', 'tailChars', value),
          }),
        ]),
        h(
          'p',
          { key: 'note', style: { margin: 0, fontSize: 11.5, color: MUTED, lineHeight: 1.7 } },
          '中间被裁掉的部分换成一行标记，原文仍完整留在会话日志里。开头 + 标记 + 结尾会自动收进阈值内，不会出现「保留得比阈值还多」的无效配置。',
        ),
      ])

      const footer = h('footer', { key: 'foot', style: { display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 4 } }, [
        h('div', { key: 'row', style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } }, [
          h(Chip, { key: 'reset', onClick: () => void reset(), title: '回到默认：不限制窗口、跟随模型思考、80%/16%/64K、8192/4096/1024' }, '恢复默认'),
          h(
            'span',
            { key: 'presets', style: { fontSize: 11, color: MUTED } },
            Array.isArray(report.presetIds) && report.presetIds.length > 0
              ? `已写入 ${report.presetIds.length} 个预设：${report.presetIds.join('、')}`
              : '尚未写入预设',
          ),
        ]),
        h(
          'span',
          { key: 'path', style: { fontSize: 10.5, color: MUTED, wordBreak: 'break-all' } },
          `状态文件 ${state.stateFile || ''}`,
        ),
        h(
          'p',
          { key: 'pin', style: { margin: 0, fontSize: 10.5, color: MUTED, lineHeight: 1.7 } },
          '压缩与裁剪两组阈值写进 agent 预设（standard / ptc / minimal / cordis）。首次修改会把这几个预设的当前定义落到 profile 的 cordis.patch.yml——这与官方 Web 编辑器保存预设走的是同一条路；改前会自动留一份 .bak-console-* 备份。',
        ),
        error !== null
          ? h('p', { key: 'err', style: { margin: 0, fontSize: 11.5, color: WARN } }, `最近一次写入失败：${error}`)
          : null,
        Array.isArray(report.notes) && report.notes.length > 0
          ? h('p', { key: 'notes', style: { margin: 0, fontSize: 11, color: MUTED } }, `提示：${report.notes.join('；')}`)
          : null,
      ])

      return h(
        'div',
        {
          style: {
            minHeight: '100%',
            boxSizing: 'border-box',
            overflow: 'auto',
            padding: '20px 24px 28px',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            color: 'inherit',
          },
        },
        [header, capCard, reasoningCard, compactionCard, toolsCard, footer],
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_KEY,
              order: 26,
              label: () => '上下文控制台',
            },
            ConsoleIcon,
          ),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_KEY,
            },
            () => h(Boundary, null, h(Panel)),
          ),
        )
      },
    }
  },
})
