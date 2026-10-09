/**
 * 浏览器半边的行为测试（最小 DOM stub，不需要 jsdom / 真浏览器）。
 *
 * 覆盖的是真正会出问题的几条路：
 *   默认挂载 → 首帧交接 → 播放结束/点击 → 淡出 → 节点真的被移除
 *   开关为 off（以及历史遗留值 550c）时一个字都不挂
 *   遗留的 `dsh-550c-boot:mode='off'` 必须在模块求值时被清掉
 *   设置页：注册在 settings.section、开关/素材/预览三个控件的落点与重播
 *   导入自己的视频：上传（裸 body + header 带文件名）、桌面版按路径复制、失败给出人话
 *
 * client.js 是被 `window.__ModuleLoader__.load({ factory })` 包起来的浏览器 bundle，
 * 所以在 vm 里跑，喂给它一套最小 window/document。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')

const FADE_SETTLE_MS = 700
/** 设置页里的三个键：本插件开关、素材、以及老版本写下的 550C 遗留标记。 */
const SOURCE_KEY = 'dsh-boot-video:source'
const ASSET_KEY = 'dsh-boot-video:asset'
const C550_KEY = 'dsh-550c-boot:mode'
/**
 * 界面里有没有"导入自己的视频"这一块——**有**（这是本插件的主功能之一，用户 2026-10-09
 * 明确「我最重要的导入视频的功能呢」）。对应 `lib/client.js` 的 `IMPORT_ENABLED`；
 * 跟着它走，关掉时那几条界面用例会自动跳过而不是变红。
 */
const CLIENT_IMPORT_ENABLED = true

class FakeClassList {
  constructor() {
    this.set = new Set()
  }
  add(name) {
    this.set.add(name)
  }
  remove(name) {
    this.set.delete(name)
  }
  contains(name) {
    return this.set.has(name)
  }
}

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.parentNode = null
    this.dataset = {}
    this.style = {}
    this.attributes = {}
    this.listeners = new Map()
    this.classList = new FakeClassList()
    this.hidden = false
    this.textContent = ''
  }
  appendChild(child) {
    child.parentNode = this
    this.children.push(child)
    return child
  }
  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
    child.parentNode = null
    return child
  }
  remove() {
    if (this.parentNode !== null) this.parentNode.removeChild(this)
  }
  /** 把事件派发给这个节点上的监听器；冒泡（到 parentNode）是模拟的，够我们用。 */
  dispatch(type, event = {}) {
    const payload = {
      type,
      target: this,
      // 真 DOM 的事件对象一定有这两个方法：卡片和声音按钮都会调 stopPropagation。
      stopPropagation: () => {},
      preventDefault: () => {},
      ...event,
    }
    // 监听器里的 stopPropagation() 必须真的挡住冒泡：真的 DOM 里它会被调用的那一刻生效，
    // 所以这里让它写到一个共享标记上，冒泡前再检查。
    payload.stopPropagation = () => {
      payload.__stopped = true
    }
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(payload)
    if (payload.__stopped !== true && this.parentNode !== null && typeof this.parentNode.dispatch === 'function') {
      this.parentNode.dispatch(type, payload)
    }
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value)
  }
  getAttribute(name) {
    return this.attributes[name] ?? null
  }
  removeAttribute(name) {
    delete this.attributes[name]
  }
  attachShadow() {
    this.shadowRoot = new FakeElement('shadow-root')
    return this.shadowRoot
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(fn)
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type)
    if (list === undefined) return
    const index = list.indexOf(fn)
    if (index >= 0) list.splice(index, 1)
  }
  /** 递归找带某个 dataset 键的节点。 */
  find(predicate) {
    if (predicate(this)) return this
    for (const child of this.children) {
      const hit = child.find ? child.find(predicate) : null
      if (hit !== null && hit !== undefined) return hit
    }
    return null
  }
}

class FakeVideo extends FakeElement {
  constructor() {
    super('video')
    this.muted = false
    this.paused = true
    this.duration = 12.5
    this.src = ''
    this.playCalls = 0
    this.pauseCalls = 0
    this.loadCalls = 0
    /** 真机上加载完是 4；不可见的页面里会一直停在 0。 */
    this.readyState = 4
    /** 让用例决定 play() 是否被浏览器拒绝（任何情况下）。 */
    this.rejectPlay = false
    /** 模拟浏览器策略：未静音时拒绝播放（网页版的常态），静音时放行。 */
    this.rejectUnmuted = false
  }
  play() {
    this.playCalls += 1
    if (this.rejectPlay || (this.rejectUnmuted && !this.muted)) {
      const error = new Error('play() failed because the user did not interact with the document first')
      error.name = 'NotAllowedError'
      return Promise.reject(error)
    }
    this.paused = false
    return Promise.resolve()
  }
  pause() {
    this.pauseCalls += 1
    this.paused = true
  }
  load() {
    this.loadCalls += 1
  }
}

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
    _map: map,
  }
}

/**
 * 最小 React stub。
 *
 * 只返回元素树、不做 DOM 渲染——但它**真的保存状态**：设置页那几个控件的
 * 落点（写哪个键、要不要重播）都能在这儿点到。
 */
const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  useState(initial) {
    const value = typeof initial === 'function' ? initial() : initial
    return [value, () => {}]
  },
  useEffect() {},
  useRef() {
    return { current: null }
  },
}

/**
 * 带状态的 React stub：给设置页用，`useState` 的 setter 会更新值，下一次渲染就读到新的。
 *
 * 不做调和（reconciliation）——测试只关心"点了之后发生什么"：写进 localStorage 的值、
 * 覆盖层有没有被换掉、树里有没有出现新的勾选态。
 */
function makeStatefulReact() {
  const cells = []
  const refs = []
  const effects = []
  const cleanups = []
  let cursor = 0
  let refCursor = 0
  let dirty = false
  return {
    createElement: React.createElement,
    useState(initial) {
      const index = cursor
      cursor += 1
      if (cells[index] === undefined) cells[index] = typeof initial === 'function' ? initial() : initial
      return [
        cells[index],
        (next) => {
          cells[index] = typeof next === 'function' ? next(cells[index]) : next
          dirty = true
        },
      ]
    },
    /** 与 React 一样：同一位置的 ref 对象在多次渲染之间保持同一个。 */
    useRef(initial) {
      const index = refCursor
      refCursor += 1
      if (refs[index] === undefined) refs[index] = { current: initial === undefined ? null : initial }
      return refs[index]
    },
    /** 记下 effect（`[]` 依赖只跑一次）；用例可以主动触发它，模拟组件挂载。 */
    useEffect(callback) {
      effects.push(callback)
    },
    runEffects() {
      for (const callback of effects) {
        const cleanup = callback()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      }
    },
    dispose() {
      for (const cleanup of cleanups) cleanup()
    },
    /** 模拟一次重渲染：游标归零，交给调用方重新执行组件函数。 */
    beginRender() {
      cursor = 0
      refCursor = 0
      dirty = false
    },
    get dirty() {
      return dirty
    },
  }
}

/**
 * 最小 XMLHttpRequest stub：记下请求，把 responseText 摆在 `respond` 指定的地方。
 *
 * 客户端上传走 XHR 是为了**进度**（fetch 没有上传进度），所以这里也得能触发 progress。
 */
function makeXhr(options = {}) {
  const calls = []
  let current = null
  class FakeXhr {
    constructor() {
      this.upload = { listeners: new Map(), addEventListener: (type, fn) => this.upload.listeners.set(type, fn) }
      this.listeners = new Map()
      this.status = 0
      this.responseText = ''
    }
    open(method, url) {
      calls.push({ method, url, headers: {}, body: null, upload: this.upload, instance: this })
      current = calls[calls.length - 1]
    }
    setRequestHeader(name, value) {
      if (current !== null) current.headers[name] = value
    }
    addEventListener(type, fn) {
      this.listeners.set(type, fn)
    }
    send(body) {
      if (current !== null) current.body = body
      const plan =
        options.respond === undefined
          ? { status: 200, text: JSON.stringify({ ok: true, asset: { id: 'u-muoxxx-1' } }) }
          : options.respond
      const xhr = this
      queueMicrotask(() => {
        if (plan.progress !== undefined) {
          const listener = xhr.upload.listeners.get('progress')
          if (listener !== undefined) listener(plan.progress)
        }
        if (plan.fail === true) {
          const listener = xhr.listeners.get('error')
          if (listener !== undefined) listener()
          return
        }
        xhr.status = plan.status
        xhr.responseText = plan.text
        const listener = xhr.listeners.get('load')
        if (listener !== undefined) listener()
      })
    }
  }
  FakeXhr.calls = calls
  return FakeXhr
}

/**
 * 把 client.js 跑起来，返回可操作的把手。
 *
 * @param options.storage - localStorage 的初始内容
 * @param options.firstFrame - 是否预置宿主首帧句柄
 * @param options.react - 覆盖 React stub（设置页的交互测试要带状态的那个）
 * @param options.Xhr - 覆盖 XMLHttpRequest stub（上传/导入的用例要用）
 * @param options.fetch - 覆盖 fetch stub（清单、删除、按路径导入）
 * @param options.desktopBridge - 预置 `window.__DSH_HOST_PATHS__`（桌面版的路径桥）
 */
function loadClient(options = {}) {
  const storage = makeStorage(options.storage)
  // 默认把"启动延时"关掉：测试要的是"挂上就播"的即时行为；延时本身由专门那条用例覆盖。
  if (storage.getItem('dsh-boot-video:start-delay') === null) {
    storage.setItem('dsh-boot-video:start-delay', options.startDelay ?? '0')
  }
  const body = new FakeElement('body')
  const head = new FakeElement('head')
  const firstFrame = { ended: 0, end() { this.ended += 1 } }
  const react = options.react ?? React

  const documentListeners = new Map()
  const document = {
    body,
    head,
    documentElement: new FakeElement('html'),
    /** 用例可以把它设成 'hidden' 来模拟"窗口在后台"（真机上媒体根本不会加载）。 */
    visibilityState: options.visibility ?? 'visible',
    createElement(tag) {
      if (tag === 'video') {
        const video = new FakeVideo()
        video.rejectPlay = options.rejectPlay === true
        video.rejectUnmuted = options.rejectUnmuted === true
        // 默认当作"已经就绪"（真机上很快就绪）；测"启动延时"的用例要把它设成 0（还没就绪）。
        if (options.videoReadyState !== undefined) video.readyState = options.videoReadyState
        return video
      }
      return new FakeElement(tag)
    },
    getElementById(id) {
      const find = (element) => {
        if (element.id === id) return element
        for (const child of element.children) {
          const hit = find(child)
          if (hit !== null && hit !== undefined) return hit
        }
        return null
      }
      return find(head)
    },
    addEventListener(type, fn) {
      if (!documentListeners.has(type)) documentListeners.set(type, [])
      documentListeners.get(type).push(fn)
    },
    removeEventListener(type, fn) {
      const list = documentListeners.get(type)
      if (list === undefined) return
      const index = list.indexOf(fn)
      if (index >= 0) list.splice(index, 1)
    },
    dispatch(type) {
      for (const fn of documentListeners.get(type) ?? []) fn()
    },
  }

  let definition = null
  const windowListeners = new Map()
  const window = {
    localStorage: storage,
    __ModuleLoader__: {
      load(def) {
        definition = def
      },
    },
    addEventListener(type, fn) {
      if (!windowListeners.has(type)) windowListeners.set(type, [])
      windowListeners.get(type).push(fn)
    },
    removeEventListener(type, fn) {
      const list = windowListeners.get(type)
      if (list === undefined) return
      const index = list.indexOf(fn)
      if (index >= 0) list.splice(index, 1)
    },
    dispatchEvent(event) {
      for (const fn of [...(windowListeners.get(event.type) ?? [])]) fn(event)
      return true
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    // 兜底 watchdog 在真机上是一分钟；测试里缩短到 1.5 秒，
    // 免得某个用例忘了收尾就把整轮测试拖到 60 秒。
    __dshBootVideoWatchdogMs: 1500,
  }
  if (options.firstFrame !== false) window.__dshBootVideoFirstFrame = firstFrame
  if (options.desktopBridge !== undefined) window.__DSH_HOST_PATHS__ = options.desktopBridge
  // 宿主注入的"随包提供哪几段"（发布形态只有 hdd）；不传就当作"全都在"。
  if (options.assets !== undefined) window.__dshBootVideoAssets = options.assets

  const fetchCalls = []
  const fetchStub =
    options.fetch ??
    (async (url, init) => {
      fetchCalls.push({ url, init })
      return { ok: false, status: 404, json: async () => ({}) }
    })
  const XhrStub = options.Xhr ?? makeXhr({})

  const context = vm.createContext({
    window,
    document,
    console,
    setTimeout,
    clearTimeout,
    Promise,
    Symbol,
    Number,
    Error,
    fetch: fetchStub,
    XMLHttpRequest: XhrStub,
    CustomEvent: class {
      constructor(type, init) {
        this.type = type
        this.detail = init === undefined ? undefined : init.detail
      }
    },
    Event: class {
      constructor(type) {
        this.type = type
      }
    },
    require: (name) => {
      assert.equal(name, 'react')
      return react
    },
  })
  vm.runInContext(SOURCE, context, { filename: 'lib/client.js' })

  assert.ok(definition !== null, 'client.js 应该通过 __ModuleLoader__.load 注册自己')
  assert.equal(definition.id, 'dsh-boot-video')
  const exported = definition.factory(context.require)

  return { window, document, body, head, storage, firstFrame, exported, react, fetchCalls, XhrStub, context }
}

const isHost = (node) => node.tagName === 'DIV' && node.dataset.dshbvBoot === ''

/**
 * 让当前覆盖层走完退出流程。
 *
 * 必须做：覆盖层里有一个 60 秒的绝对兜底 watchdog（正常工作时不触发），
 * 用例不把它清掉的话，Node 的测试进程会一直等到它超时——实测整轮从 3 秒变成 63 秒。
 *
 * @param bodyOrRecord - body 元素（自己去里面找覆盖层），或直接给覆盖层记录
 */
async function retire(bodyOrRecord) {
  const isRecord = bodyOrRecord !== null && typeof bodyOrRecord === 'object' && 'dispose' in bodyOrRecord
  const host = isRecord ? null : bodyOrRecord.find(isHost)
  if (isRecord) bodyOrRecord.dispose()
  else if (host === null) return
  else host.dispatch('ended')
  await new Promise((resolve) => setTimeout(resolve, FADE_SETTLE_MS))
}

/** 深度优先找第一个满足条件的节点。 */
function findNode(node, predicate) {
  if (node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findNode(child, predicate)
      if (hit !== null) return hit
    }
    return null
  }
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const hit = findNode(child, predicate)
    if (hit !== null) return hit
  }
  return null
}

/** 把一个节点的文字都拼起来：元素树里的（children）和命令式 DOM 的（textContent）都要看。 */
function textOf(node) {
  if (typeof node === 'string') return node
  if (node === null || typeof node !== 'object') return ''
  const fromChildren = (node.children ?? []).map(textOf).join('')
  const own = typeof node.textContent === 'string' ? node.textContent : ''
  return `${own}${fromChildren}`
}

/** 元素树里第一个显示这段文字的 <button>。 */
function findButton(tree, text) {
  return findNode(tree, (node) => node.type === 'button' && textOf(node) === text)
}

/** 元素树里所有 <button> 的文字。 */
function buttonLabels(tree) {
  const out = []
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    if (node.type === 'button') out.push(textOf(node))
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree)
  return out
}

/**
 * 走一遍插件生命周期：apply() 把设置页注册进 settings.section，
 * 这里把注册的组件接住，返回能反复点按的把手。
 *
 * 每次点击都重新执行一次组件函数（真机上由 React 的重渲染做同一件事），
 * `tree` 永远是最新的一版。
 */
function mountSettings(loaded) {
  const registered = []
  const ctx = {
    slots: {
      inject(name, callback) {
        callback()
        registered.push(name)
      },
      register(meta, component) {
        registered.push(meta.id ?? meta.name)
        registered.push(component)
        return () => {}
      },
    },
    effect() {},
  }
  loaded.exported.apply(ctx)
  const component = registered.find((item) => typeof item === 'function')
  assert.equal(typeof component, 'function', 'settings.section 应该注册一个组件')

  const handle = {
    tree: null,
    /**
     * 模拟"组件挂载"：先渲染一次（组件在这一步才会把 effect 登记进来），再跑 effect，再渲染。
     *
     * ⚠️ 顺序不能反：先跑 effect 的话，effects 列表还是空的——真机上的顺序也是
     * "render → commit → 跑 effect →（setState 引发的）再渲染"。
     */
    setup() {
      handle.render()
      loaded.react.runEffects()
      handle.render()
      return () => loaded.react.dispose()
    },
    render() {
      loaded.react.beginRender()
      handle.tree = component({ close() {} })
      return handle.tree
    },
    /** 点一个按钮：执行 onClick，然后重新渲染（`tree` 随即是最新的）。 */
    click(text) {
      const button = findButton(handle.render(), text)
      assert.ok(button !== null, `设置页里应该有「${text}」按钮`)
      button.props.onClick()
      return handle.render()
    },
    /** 派发一个 window 事件（我们自己的清单变更 / 上传进度都是这么广播的）。 */
    emit(type, detail) {
      loaded.window.dispatchEvent({ type, detail })
      return handle.render()
    },
  }
  return handle
}

test('默认（source 缺省）挂载覆盖层，并在同一个任务里撤掉宿主首帧', async () => {
  const { body, firstFrame, window } = loadClient()
  const host = body.find(isHost)
  assert.ok(host !== null, 'body 上应该出现覆盖层')
  assert.equal(host.getAttribute('aria-hidden'), 'true')
  assert.equal(firstFrame.ended, 1, '首帧必须被撤下，否则永远是一块黑屏')
  assert.equal(window.__dshBootVideoFirstFrame, undefined)
  assert.ok(host.shadowRoot !== null, '内容挂在 shadow root 里，样式不外泄')

  const video = host.shadowRoot.children.find((child) => child.tagName === 'VIDEO')
  assert.ok(video !== undefined, 'shadow root 里应该有一条 <video>')
  assert.equal(video.muted, false, '先试带声音：桌面版能直接放声，浏览器被拒后会自动降级（见下一个用例）')
  assert.equal(video.playCalls, 1)
  assert.equal(video.getAttribute('playsinline'), '')
  assert.match(video.src, /^\/dsh-boot-video\/asset\/hdd\.mp4$/, '默认素材是 HDD')

  await retire(body)
})

test('网页版拦下未静音播放时自动降级静音，并亮出「打开声音」', async () => {
  const { body } = loadClient({ rejectUnmuted: true })
  const host = body.find(isHost)
  const video = host.shadowRoot.children.find((child) => child.tagName === 'VIDEO')
  const sound = host.shadowRoot.children.find((child) => child.tagName === 'BUTTON')

  assert.equal(video.muted, false, '第一次是带声尝试')
  assert.equal(sound.hidden, true, '还没降级，按钮先不出现')

  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(video.muted, true, '被拒之后必须降级成静音')
  assert.equal(sound.hidden, false, '降级后才亮出开声按钮')
  assert.ok(video.playCalls >= 2, '降级之后要真的再播一次')

  await retire(body)
})

test('play() 一直失败时不会立刻收场，但 watchdog 到点必须收场', async () => {
  const { body } = loadClient({ rejectPlay: true })
  const host = body.find(isHost)
  assert.ok(host !== null, '起播失败不等于收场：覆盖层先留着')

  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.ok(body.find(isHost) !== null, '几次重试之间都不该把覆盖层撤掉')

  // watchdog（用例里设成 1500ms）是最后一道闸：过了它必须收场，绝不留一块黑屏。
  // 收场还要走一段淡出（FADE_MS + 40），所以这里等够 1500 + 520 再加余量。
  await new Promise((resolve) => setTimeout(resolve, 2000))
  assert.equal(body.find(isHost), null, 'watchdog 到点必须收场')
})

test('source=off 时什么都不挂，并清掉老版本留下的 550C 标记', async () => {
  const { body, firstFrame, storage } = loadClient({
    storage: { [SOURCE_KEY]: 'off', [C550_KEY]: 'off' },
  })
  assert.equal(body.find(isHost), null, 'source=off 不该挂覆盖层')
  assert.equal(firstFrame.ended, 0, 'source=off 不该碰宿主首帧')
  assert.equal(storage._map.has(C550_KEY), false, '遗留的 550C 标记必须被清掉，否则 550C 永远不播')
})

test('source=550c 是历史值：迁移成 off（不播），且不碰用户自己在 550C 里选的档位', async () => {
  const { body, storage } = loadClient({ storage: { [SOURCE_KEY]: '550c', [C550_KEY]: 'simple' } })
  assert.equal(body.find(isHost), null, '当初选 550C 的用户不该突然改看我们的动画')
  assert.equal(storage.getItem(SOURCE_KEY), 'off', '历史值要迁移成 off，不能掉回默认的视频')
  assert.equal(storage.getItem(C550_KEY), 'simple', '用户自己在 550C 里选的值不能被我们改掉')
})

test('从未留下标记时，清理函数什么都不做', async () => {
  const { storage } = loadClient({ storage: { [C550_KEY]: 'full' } })
  assert.equal(storage.getItem(C550_KEY), 'full', '不是 off 就不是我们写的，别动')
})

test('点画面跳过：先淡出，再把节点和监听都收干净', async () => {
  const { body } = loadClient()
  const host = body.find(isHost)
  host.dispatch('click')
  assert.ok(host.classList.contains('dshbv-out'), '跳过走的是同一段淡出，不是直接消失')
  assert.equal(body.find(isHost) !== null, true, '淡出期间节点还在')
  await new Promise((resolve) => setTimeout(resolve, FADE_SETTLE_MS))
  assert.equal(body.find(isHost), null, '淡出结束后节点必须被移除')
})

test('播放到结尾（ended）同样淡出移除', async () => {
  const { body } = loadClient()
  const host = body.find(isHost)
  const video = host.shadowRoot.children.find((child) => child.tagName === 'VIDEO')
  video.dispatch('ended')
  await new Promise((resolve) => setTimeout(resolve, FADE_SETTLE_MS))
  assert.equal(body.find(isHost), null)
})

test('静音播放都被拒时不会把人锁在覆盖层里', async () => {
  const { body } = loadClient()
  const host = body.find(isHost)
  const video = host.shadowRoot.children.find((child) => child.tagName === 'VIDEO')
  video.rejectPlay = true
  // 重新触发一次 play 的失败路径：模块求值时的那次调用已经错过了标记，这里模拟 DOM 事件后重试
  video.dispatch('error')
  await new Promise((resolve) => setTimeout(resolve, FADE_SETTLE_MS))
  assert.equal(body.find(isHost), null, '视频出错也必须淡出收场')
})

test('导出契约：name / inject / apply 把设置页注册进 settings.section', async () => {
  const { body, exported } = loadClient()
  assert.equal(exported.name, 'boot-video')
  // 注意跨 realm：client.js 跑在 vm context 里，它创建的数组原型与本文件的不同，
  // deepStrictEqual 会因为原型不等而失败——所以逐项比。
  assert.equal(exported.inject.length, 1)
  assert.equal(exported.inject[0], 'slots')
  assert.equal(typeof exported.apply, 'function')

  const registered = []
  const ctx = {
    slots: {
      inject(name, callback) {
        callback()
        registered.push(name)
      },
      register(meta, component) {
        registered.push(meta.id)
        assert.equal(typeof component, 'function')
      },
    },
    effect(fn) {
      fn()
    },
  }
  exported.apply(ctx)
  assert.ok(registered.includes('settings.section'), '设置整页走 settings.section')
  assert.equal(registered.includes('settings.general.item'), false, '不该再占用「通用设置」里的那一行')
  assert.ok(registered.includes('boot-video'))

  await retire(body)
})

test('设置页：开关、素材、预览三件事都在，默认选中当前值', async () => {
  const loaded = loadClient({ react: makeStatefulReact() })
  const page = mountSettings(loaded)
  const tree = page.render()

  assert.deepEqual(buttonLabels(tree), ['我的视频', '不播放', 'HDD', '月读世界', '▶ 播放一遍'])
  assert.equal(findButton(tree, '我的视频').props.className, 'on', '默认开关是「我的视频」')
  assert.equal(findButton(tree, '不播放').props.className, '')
  assert.equal(findButton(tree, 'HDD').props.className, 'on', '默认素材是 HDD')
  assert.equal(findButton(tree, '月读世界').props.className, '')
  assert.match(JSON.stringify(tree), /开机动画/, '整页要有自己的标题')

  await retire(loaded.body)
})

test('设置页：切到「不播放」写 off 并收起正在播的覆盖层', async () => {
  const loaded = loadClient({ react: makeStatefulReact() })
  const page = mountSettings(loaded)
  page.render()
  const before = loaded.exported.__internals.readLiveOverlay()
  assert.ok(before !== null, '模块求值时已经在播')

  const tree = page.click('不播放')
  assert.equal(loaded.storage.getItem(SOURCE_KEY), 'off', '开关必须落到 localStorage')
  assert.equal(findButton(tree, '不播放').props.className, 'on')
  assert.equal(findButton(tree, '我的视频').props.className, '')
  assert.equal(loaded.exported.__internals.readLiveOverlay(), null, '关掉之后不能还在播')
  await new Promise((resolve) => setTimeout(resolve, FADE_SETTLE_MS))
  assert.equal(loaded.body.find(isHost), null, '覆盖层已经撤下')

  // 再拨回来：应当立刻重播一遍，用户不用为了看效果重启。
  const back = page.click('我的视频')
  assert.equal(loaded.storage.getItem(SOURCE_KEY), 'video')
  assert.equal(findButton(back, '我的视频').props.className, 'on')
  const live = loaded.exported.__internals.readLiveOverlay()
  assert.ok(live !== null, '拨回「我的视频」要立刻有东西在播')
  await retire(live)
})

test('设置页：换素材立刻用新素材重播，并记住选择', async () => {
  const loaded = loadClient({ react: makeStatefulReact() })
  const page = mountSettings(loaded)
  page.render()
  const before = loaded.exported.__internals.readLiveOverlay()
  const oldVideo = before.video

  const tree = page.click('月读世界')
  assert.equal(loaded.storage.getItem(ASSET_KEY), 'yuedu')
  assert.equal(findButton(tree, '月读世界').props.className, 'on')
  assert.equal(findButton(tree, 'HDD').props.className, '')

  const live = loaded.exported.__internals.readLiveOverlay()
  assert.ok(live !== null && live !== before, '必须换成新的覆盖层，而不是什么都不发生')
  assert.equal(oldVideo.pauseCalls >= 1, true, '旧的那条视频要停下来')
  assert.match(live.video.src, /\/dsh-boot-video\/asset\/yuedu\.mp4$/, '新的覆盖层播的是新素材')
  await retire(live)
})

test('设置页：预览按钮每次都从头重播', async () => {
  const loaded = loadClient({ react: makeStatefulReact() })
  const page = mountSettings(loaded)
  page.render()
  const first = loaded.exported.__internals.readLiveOverlay()

  page.click('▶ 播放一遍')
  const second = loaded.exported.__internals.readLiveOverlay()
  assert.ok(second !== null && second !== first, '在播的时候点预览也要重播一遍')

  await retire(second)
})

test('设置页：从 storage 读到 off / yuedu 时，选中态跟着它走', async () => {
  const loaded = loadClient({
    react: makeStatefulReact(),
    storage: { [SOURCE_KEY]: 'off', [ASSET_KEY]: 'yuedu' },
  })
  const page = mountSettings(loaded)
  const tree = page.render()
  assert.equal(findButton(tree, '不播放').props.className, 'on')
  assert.equal(findButton(tree, '我的视频').props.className, '')
  assert.equal(findButton(tree, '月读世界').props.className, 'on')
  assert.equal(findButton(tree, 'HDD').props.className, '')
  assert.equal(loaded.body.find(isHost), null, '开关是 off，启动时不该有覆盖层')
})

test('页面不可见时启动：watchdog 不判死，回到前台会重新挂源再播', async () => {
  const { body, document } = loadClient({ visibility: 'hidden' })
  const host = body.find(isHost)
  const video = host.shadowRoot.children.find((child) => child.tagName === 'VIDEO')

  // 真机上隐藏期间的 play() 会成功返回、却一个字节都不加载；这里验证"不会被判死"。
  await new Promise((resolve) => setTimeout(resolve, 1800))
  assert.ok(body.find(isHost) !== null, '页面一次都没露过面，watchdog 不该把覆盖层撤掉')

  // 回到前台：还停在 readyState 0，就该重新挂一次源并再播。
  document.visibilityState = 'visible'
  video.readyState = 0
  document.dispatch('visibilitychange')
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.ok(video.loadCalls >= 1, 'readyState 还是 0 时要重新挂源')
  assert.ok(video.playCalls >= 2, '并且再播一次')

  await retire(body)
})

test('视频打不开：给一块说明卡片，但**绝不能把界面锁住**（跳过按钮与自动退场都要真的生效）', async () => {
  // 这条是 2026-10-09 真机事故的回归测试：当时卡片先立了 finished 守卫再画卡片，
  // 而退场走的是 finish()，被守卫挡住 → 按钮和 6 秒计时全是空转，用户连主界面都进不去。
  const loaded = loadClient()
  const { body } = loaded
  const host = body.find(isHost)
  const video = host.shadowRoot.children.find((child) => child.tagName === 'VIDEO')
  // Chromium 解不了 HEVC 时报的就是 4（MEDIA_ERR_SRC_NOT_SUPPORTED）
  video.error = { code: 4 }
  video.dispatch('error')

  const layer = host.shadowRoot.children.find((child) => child.className === 'dshbv-break')
  assert.ok(layer !== undefined, '打不开时要出现说明卡片，而不是黑屏一闪')
  assert.match(textOf(layer), /打不开/, '卡片要说清楚发生了什么')
  const skipButton = findNode(layer, (node) => node.type === 'button')
  assert.ok(skipButton !== null, '卡片上要有一个能走的按钮')

  // 点按钮：必须真的淡出并把这层覆盖层从 body 上摘掉
  skipButton.dispatch('click')
  await new Promise((resolve) => setTimeout(resolve, FADE_SETTLE_MS))
  assert.equal(body.find(isHost), null, '点了跳过还不消失 = 把用户锁在开机画面上（事故复现）')
})

test('视频打不开：没人点按钮时也要自己退场', async () => {
  const loaded = loadClient()
  const host = loaded.body.find(isHost)
  const video = host.shadowRoot.children.find((child) => child.tagName === 'VIDEO')
  video.error = { code: 4 }
  video.dispatch('error')

  // BROKEN_CARD_MS = 6s，再加淡出（FADE_MS + 40）
  await new Promise((resolve) => setTimeout(resolve, 6000 + FADE_SETTLE_MS))
  assert.equal(loaded.body.find(isHost), null, '卡片必须自己退场，不能一直挂在屏上')
})

test('想听声音：按钮只开声，不跳过', async () => {
  const { body } = loadClient({ rejectUnmuted: true })
  const host = body.find(isHost)
  const video = host.shadowRoot.children.find((child) => child.tagName === 'VIDEO')
  const sound = host.shadowRoot.children.find(
    (child) => child.tagName === 'BUTTON' && child.classList !== undefined,
  )

  // 等降级完成（未静音被拒 → 静音重播 → 按钮出现）
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.ok(sound !== undefined && sound.hidden === false, '降级静音后才给出开声按钮')

  sound.dispatch('click')
  assert.equal(video.muted, false)
  assert.equal(sound.hidden, true)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(
    body.find(isHost) !== null,
    true,
    '点「打开声音」不能把开机动画收掉（stopPropagation 得真的挡住冒泡）',
  )

  await retire(body)
})

//#region 导入自己的视频（0.4.0）

test('导入：网页版/桌面版都走同一条上传路（裸 body + 文件名走 header，带进度）', async () => {
  const Xhr = makeXhr({
    respond: {
      status: 200,
      text: JSON.stringify({ ok: true, asset: { id: 'u-muoxxx-9', label: '我的片子.mp4', bytes: 1234, at: 1 } }),
      progress: { loaded: 500, total: 1234, lengthComputable: true },
    },
  })
  const loaded = loadClient({ Xhr: Xhr })
  const progress = []
  loaded.window.addEventListener('dsh-boot-video:import-progress', (event) => progress.push(event.detail))
  const { importFile } = loaded.exported.__internals

  const file = { name: '我的片子.mp4', size: 1234, type: 'video/mp4', lastModified: 1 }
  const asset = await importFile(file)

  assert.equal(asset.id, 'u-muoxxx-9')
  assert.equal(Xhr.calls.length, 1)
  const call = Xhr.calls[0]
  assert.equal(call.method, 'POST')
  assert.equal(call.url, 'dsh-boot-video/import', '要用相对路径：网页版打在 3080、桌面版打在 19387')
  assert.equal(call.body, file, 'body 就是 File 本身（流式，不先读进内存）')
  assert.equal(call.headers['x-dshbv-name'], encodeURIComponent('我的片子.mp4'), '非 ASCII 文件名要 encode 过')
  assert.equal(call.headers['x-dshbv-size'], '1234')
  assert.ok(progress.some((item) => item.phase === 'uploading' && item.loaded === 500), '上传进度要广播出去')
  const overlay = loaded.exported.__internals.readLiveOverlay()
  if (overlay !== null) await retire(overlay)
})

test('导入：桌面版拿到绝对路径时，交给宿主直接复制（省掉搬字节）', async () => {
  const Xhr = makeXhr({})
  const seen = []
  const desktopBridge = {
    pathFor(file) {
      seen.push(file.name)
      return 'D:\\我的视频\\片子.mp4'
    },
  }
  const fetchStub = async (url, init) => {
    seen.push(url)
    if (url === 'dsh-boot-video/import/from-path') {
      const body = JSON.parse(init.body)
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          asset: { id: 'u-muoxxx-p', label: body.name, bytes: body.size, at: 2 },
        }),
      }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  const loaded = loadClient({ Xhr: Xhr, desktopBridge: desktopBridge, fetch: fetchStub })
  const asset = await loaded.exported.__internals.importFile({
    name: '片子.mp4',
    size: 5000,
    type: 'video/mp4',
    lastModified: 42,
  })

  assert.equal(asset.id, 'u-muoxxx-p')
  assert.deepEqual(seen, ['片子.mp4', 'dsh-boot-video/import/from-path'], '走的是按路径复制这条路')
  assert.equal(Xhr.calls.length, 0, '快路成功就不该再走上传')
  const overlay = loaded.exported.__internals.readLiveOverlay()
  if (overlay !== null) await retire(overlay)
})

test('导入：桌面版拿不到路径（Electron 版本不给）时自动回退到上传', async () => {
  const Xhr = makeXhr({
    respond: { status: 200, text: JSON.stringify({ ok: true, asset: { id: 'u-muoxxx-f', bytes: 10 } }) },
  })
  const fetchStub = async () => ({ ok: false, status: 400, json: async () => ({ ok: false, error: 'stale-selection' }) })
  const loaded = loadClient({
    Xhr: Xhr,
    // pathFor 给空串（旧 Electron / 没有权限）在真机上会出现，必须能掉回上传
    desktopBridge: { pathFor: () => '' },
    fetch: fetchStub,
  })
  const asset = await loaded.exported.__internals.importFile({
    name: 'x.mp4',
    size: 10,
    type: 'video/mp4',
    lastModified: 1,
  })

  assert.equal(asset.id, 'u-muoxxx-f')
  assert.equal(Xhr.calls.length, 1, '快路不通就走上传')
  const overlay = loaded.exported.__internals.readLiveOverlay()
  if (overlay !== null) await retire(overlay)
})

test('导入：超上限、空文件、宿主报错都给出人话，而不是静默失败', async () => {
  const loaded = loadClient({
    Xhr: makeXhr({ respond: { status: 413, text: JSON.stringify({ ok: false, error: 'too-large' }) } }),
  })
  const { importFile, readLiveOverlay } = loaded.exported.__internals

  await assert.rejects(
    () => importFile({ name: 'huge.mp4', size: 600 * 1024 * 1024, type: 'video/mp4', lastModified: 1 }),
    /512/,
    '超上限要在本地就拦下，不该白传一遍',
  )
  await assert.rejects(
    () => importFile({ name: 'empty.mp4', size: 0, type: 'video/mp4', lastModified: 1 }),
    /空/,
  )
  // 只收 mp4：本地就拦，别白传几百 MB 才被宿主拒
  await assert.rejects(
    () => importFile({ name: '片子.mkv', size: 1024, type: 'video/x-matroska', lastModified: 1 }),
    /只收 mp4/,
    'mkv 之类要在本地就被挡下，不该传上去再退',
  )

  // 宿主 413（客户端没拦住时的那道闸）
  await assert.rejects(
    () => importFile({ name: 'big.mp4', size: 1024, type: 'video/mp4', lastModified: 1 }),
    /512 MB/,
    '宿主说太大时也要转成人话',
  )

  const overlay = readLiveOverlay()
  if (overlay !== null) await retire(overlay)
})

test('启动不抢资源：延时到点才起播，但视频早早准备好就提前开始', async () => {
  // 这条覆盖"启动不阻塞界面"那条优化：默认延 600ms，但就绪得早就提前播。
  const loaded = loadClient({ startDelay: '600', videoReadyState: 0 })
  const host = loaded.body.find(isHost)
  const video = host.shadowRoot.children.find((child) => child.tagName === 'VIDEO')

  // 延时还没到、视频也还没就绪：此时不该在播（真机上就是"界面先上屏"的那一小段）
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(video.playCalls, 0, '延时期间不该起播')

  // 一旦拿到数据（readyState >= 3）：应当提前开始，而不是干等满 600ms
  video.readyState = 3
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(video.playCalls >= 1, true, '就绪之后要提前开始')

  await retire(loaded.body)
})

test('启动不抢资源：延时设成 0 时立刻播（用户想一出即播就给这个值）', async () => {
  const loaded = loadClient({ startDelay: '0' })
  const host = loaded.body.find(isHost)
  const video = host.shadowRoot.children.find((child) => child.tagName === 'VIDEO')
  assert.equal(video.playCalls, 1, '延时为 0 就该跟以前一样立刻播')
  await retire(loaded.body)
})

test('选中的素材没了：悄悄换回默认素材并重播，不拿报错卡片烦用户', async () => {
  // 用户 2026-10-09 的真实处境：他选过一段导入的视频，后来那段被删了。
  const loaded = loadClient({ storage: { [ASSET_KEY]: 'u-gone-1' } })
  const host = loaded.body.find(isHost)
  const beforeVideo = host.shadowRoot.children.find((child) => child.tagName === 'VIDEO')
  assert.match(beforeVideo.src, /asset\/u-gone-1\.mp4$/, '一开始按记忆里的素材挂')

  // 宿主机回 404：Chromium 报的就是 4
  beforeVideo.error = { code: 4 }
  beforeVideo.dispatch('error')
  await new Promise((resolve) => setTimeout(resolve, 60))

  assert.equal(loaded.storage.getItem(ASSET_KEY), 'hdd', '要把坏掉的记忆改成默认素材')
  const after = loaded.body.find(isHost)
  assert.ok(after !== null, '应该还在播（换回默认素材重播）')
  const afterVideo = after.shadowRoot.children.find((child) => child.tagName === 'VIDEO')
  assert.match(afterVideo.src, /asset\/hdd\.mp4$/, '重播的是默认素材')
  assert.equal(
    after.shadowRoot.children.some((child) => child.className === 'dshbv-break'),
    false,
    '这种情况不该弹"打不开"的卡片',
  )
  await retire(after)
})

test('体检行：一次开机结果会记成一行人话（设置页不用你去翻控制台）', async () => {
  const loaded = loadClient()
  const { recordLastBoot, readLastBoot, describeLastBoot } = loaded.exported.__internals
  const { body } = loaded

  // 播完
  const host = body.find(isHost)
  const video = host.shadowRoot.children.find((child) => child.tagName === 'VIDEO')
  video.dispatch('ended')
  await new Promise((resolve) => setTimeout(resolve, FADE_SETTLE_MS))
  assert.equal(readLastBoot().outcome, 'played', '正常播完要记成 played')
  assert.match(describeLastBoot(readLastBoot()), /正常播完/)
  assert.match(describeLastBoot(readLastBoot()), /素材 hdd/)

  // 跳过
  recordLastBoot('skipped')
  assert.match(describeLastBoot(readLastBoot()), /跳过/)

  // 声音被拒
  recordLastBoot('refused')
  assert.match(describeLastBoot(readLastBoot()), /拒绝了声音/)

  // 打不开：detail 要带出来
  recordLastBoot('failed', '浏览器解不了它的编码')
  const line = describeLastBoot(readLastBoot())
  assert.match(line, /打不开/)
  assert.match(line, /浏览器解不了它的编码/, '失败原因要显示给用户')
})

test('体检行：设置页底部会写"客户端何时加载 + 上次开机结果"', async () => {
  const loaded = loadClient({ react: makeStatefulReact() })
  const page = mountSettings(loaded)
  const tree = page.render()
  const text = JSON.stringify(tree)
  assert.match(text, /客户端半边加载于/, '要能一眼看出页面是什么时候加载的（判断有没有真重开）')
  assert.match(text, /上次开机/, '要有上次开机的结果行')
  assert.match(text, /还没有记录/, '还没播过时要说"还没有记录"')

  const overlay = loaded.exported.__internals.readLiveOverlay()
  if (overlay !== null) await retire(overlay)
})

test('防打架：550C 开着时设置页给出提示，点一次「我的视频」就把它关掉', async () => {
  const loaded = loadClient({ react: makeStatefulReact(), storage: { 'dsh-550c-boot:mode': 'simple' } })
  const page = mountSettings(loaded)
  const tree = page.render()
  assert.match(JSON.stringify(tree), /550C 开机动画也开着/, '两个片头都开着时要提醒')
  assert.match(JSON.stringify(tree), /简易/, '要显示它的档位')

  // 点一次「我的视频」：应当把 550C 写成 off，并刷新提示
  const after = page.click('我的视频')
  assert.equal(loaded.storage.getItem('dsh-550c-boot:mode'), 'off', '开启本插件时把 550C 关掉')
  assert.equal(JSON.stringify(after).includes('550C 开机动画也开着'), false, '关掉之后提示要消失')

  const live = loaded.exported.__internals.readLiveOverlay()
  if (live !== null) await retire(live)
})

test('HDD 已授权、月读世界没有：宿主不出那段时，客户端连按钮都不画', async () => {
  // 发布形态：宿主注入 __dshBootVideoAssets = ['hdd']
  const loaded = loadClient({ react: makeStatefulReact(), assets: ['hdd'], storage: { [ASSET_KEY]: 'yuedu' } })
  const page = mountSettings(loaded)
  const tree = page.render()
  assert.ok(findButton(tree, 'HDD') !== null, 'HDD 要在')
  assert.equal(findButton(tree, '月读世界'), null, '没提供的那段不该画出来')
  assert.equal(loaded.exported.__internals.readAsset(), 'hdd', '以前存过没提供的素材要回落')

  const live = loaded.exported.__internals.readLiveOverlay()
  if (live !== null) await retire(live)
})

test('转码岔路：编码解不了时给出"自动转换"，点了会去下载 ffmpeg 再转，转完自动收下', async () => {
  // 上传被拒（422 + salvageable + id）——像用户导 HEVC 那次
  const Xhr = makeXhr({
    respond: {
      status: 422,
      text: JSON.stringify({
        ok: false,
        error: '这个 mp4 里是 HEVC / H.265 编码，Chromium（桌面版就是它）解不了，播出来只有黑屏。',
        code: 'codec-unsupported',
        codec: 'hevc',
        message: '这个 mp4 里是 HEVC / H.265 编码，Chromium（桌面版就是它）解不了，播出来只有黑屏。',
        salvageable: true,
        id: 'u-keepme-0',
      }),
    },
  })
  const calls = []
  const fetchStub = async (url, init) => {
    calls.push(url)
    if (url === 'dsh-boot-video/import/convert-status') {
      return { ok: true, status: 200, json: async () => ({ ok: true, ffmpegReady: false, fetching: null, converting: null }) }
    }
    if (url === 'dsh-boot-video/import/convert') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          asset: { id: 'u-keepme-0', label: '原版.mp4', bytes: 2048, at: 2 },
          converted: { fromBytes: 4096, toBytes: 2048, durationSeconds: 24 },
          imported: [{ id: 'u-keepme-0', label: '原版.mp4', bytes: 2048, at: 2 }],
        }),
      }
    }
    if (url === 'dsh-boot-video/imported.json') {
      return { ok: true, status: 200, json: async () => ({ ok: true, imported: [] }) }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }
  const loaded = loadClient({ react: makeStatefulReact(), Xhr: Xhr, fetch: fetchStub })
  const page = mountSettings(loaded)
  const stop = page.setup()

  page.render()
  const input = findNode(page.render(), (node) => node.type === 'input')
  input.props.onChange({
    target: {
      files: [{ name: '原版.mp4', size: 4096, type: 'video/mp4', lastModified: 1 }],
      value: 'C:\\fakepath\\原版.mp4',
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 30))

  // ① 界面要说明白"为什么不能导"，并且给一条出路
  let tree = page.render()
  const text = JSON.stringify(tree)
  assert.match(text, /浏览器解不了它的编码|暂时不能当片头/, '要说清原因')
  assert.ok(findButton(tree, '自动转换') !== null, '要给出「自动转换」这个选项')
  assert.ok(findButton(tree, '不用了') !== null, '也要允许拒绝')

  // ② 点「自动转换」：先下 ffmpeg（没有的话），再转到 convert 接口
  tree = page.click('自动转换')
  await new Promise((resolve) => setTimeout(resolve, 30))
  const converted = calls.filter((url) => url.includes('convert'))
  assert.ok(converted.some((url) => url === 'dsh-boot-video/import/convert'), '要打到转码接口')
  const staged = Xhr.calls.filter((call) => call.url === 'dsh-boot-video/import')
  assert.equal(staged.length, 1, '被拒那段不该重新上传一遍')

  // ③ 转完要像正常导入一样收下：选中它、播一遍、弹起名窗
  await new Promise((resolve) => setTimeout(resolve, 30))
  tree = page.render()
  assert.equal(loaded.storage.getItem(ASSET_KEY), 'u-keepme-0', '转完要自动选中')
  assert.ok(
    findNode(tree, (node) => node.type === 'input' && node.props?.maxLength === 40) !== null,
    '转完也要弹起名窗口',
  )

  stop()
  const overlay = loaded.exported.__internals.readLiveOverlay()
  if (overlay !== null) await retire(overlay)
})

test('导入界面：清单在挂载时拉一次，列表里给出文件名与大小', { skip: !CLIENT_IMPORT_ENABLED && '界面不带导入（发布版只有内置两段），见 client.js 的 IMPORT_ENABLED' }, async () => {
  const imported = [{ id: 'u-muoxxx-1', label: '猫片.mp4', bytes: 2048, at: 1 }]
  const fetchStub = async (url) => ({
    ok: url === 'dsh-boot-video/imported.json',
    status: 200,
    json: async () => ({ ok: true, imported: imported }),
  })
  const loaded = loadClient({ react: makeStatefulReact(), fetch: fetchStub })
  const page = mountSettings(loaded)
  const stop = page.setup()

  // effect 里的 fetch 是异步的，等一拍再渲染
  await new Promise((resolve) => setTimeout(resolve, 30))
  const tree = page.render()
  assert.match(JSON.stringify(tree), /猫片\.mp4/, '导入过的视频要出现在列表里')
  assert.match(JSON.stringify(tree), /2\.00 KB/, '列表上要带大小')
  assert.ok(findButton(tree, '删除') !== null, '每一条都要有删除按钮')

  stop()
  const overlay = loaded.exported.__internals.readLiveOverlay()
  if (overlay !== null) await retire(overlay)
})

test('导入界面：挑完文件就导进去、选上它、并播一遍', { skip: !CLIENT_IMPORT_ENABLED && '界面不带导入（发布版只有内置两段），见 client.js 的 IMPORT_ENABLED' }, async () => {
  const Xhr = makeXhr({
    respond: {
      status: 200,
      text: JSON.stringify({ ok: true, asset: { id: 'u-muoxxx-0', label: '新片子.mp4', bytes: 300, at: 3 } }),
    },
  })
  const fetchStub = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, imported: [] }) })
  const loaded = loadClient({ react: makeStatefulReact(), Xhr: Xhr, fetch: fetchStub })
  const page = mountSettings(loaded)
  const stop = page.setup()

  // 先渲染一次把 ref 挂上（真机上 React 也是"渲染 → commit → 才能点"）
  page.render()
  const input = findNode(page.render(), (node) => node.type === 'input')
  assert.ok(input !== null, '要有一个藏起来的 file input')
  assert.equal(input.props.accept, '.mp4,video/mp4', '选择器只让挑 mp4')

  const before = loaded.exported.__internals.readLiveOverlay()
  input.props.onChange({
    target: {
      files: [{ name: '新片子.mp4', size: 300, type: 'video/mp4', lastModified: 1 }],
      value: 'C:\\fakepath\\x.mp4',
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const tree = page.render()

  assert.equal(loaded.storage.getItem(ASSET_KEY), 'u-muoxxx-0', '导入完要自动选中新素材')
  assert.match(JSON.stringify(tree), /导入完成/, '要有成功提示')
  assert.match(JSON.stringify(tree), /新片子\.mp4/)

  // 用户 2026-10-09 的要求：导入完**立刻弹出自命名弹窗**
  const modal = findNode(tree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('dshbv-modal'))
  assert.ok(modal !== null, '导入完要当场弹出起名窗口')
  const nameInput = findNode(modal, (node) => node.type === 'input')
  assert.ok(nameInput !== null, '弹窗里要有输入框')
  assert.equal(nameInput.props.value, '新片子.mp4', '草稿预填原始文件名')
  assert.ok(findButton(modal, '就这么定') !== null, '要有确认按钮')
  assert.ok(findButton(modal, '先用原名') !== null, '要有跳过按钮')

  const live = loaded.exported.__internals.readLiveOverlay()
  assert.ok(live !== null && live !== before, '导入完要立刻用新素材播一遍')
  assert.match(live.video.src, /asset\/u-muoxxx-0\.mp4$/)
  await retire(live)
  stop()
})

test('导入界面：导入按钮就在「片头素材」那一行，导入的素材直接进那条素材带', { skip: !CLIENT_IMPORT_ENABLED && '界面不带导入（发布版只有内置两段），见 client.js 的 IMPORT_ENABLED' }, async () => {
  const imported = [{ id: 'u-muoxxx-c', label: '我的开场.mp4', bytes: 4096, at: 1 }]
  const fetchStub = async (url) => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, imported: url === 'dsh-boot-video/imported.json' ? imported : imported }),
  })
  const loaded = loadClient({ react: makeStatefulReact(), fetch: fetchStub })
  const page = mountSettings(loaded)
  const stop = page.setup()
  await new Promise((resolve) => setTimeout(resolve, 30))
  const tree = page.render()

  // 内置两段 + 导入的一段，同一条按钮带里都能点
  assert.deepEqual(buttonLabels(tree).slice(0, 4), ['我的视频', '不播放', 'HDD', '月读世界'])
  assert.ok(findButton(tree, '我的开场.mp4') !== null, '导入的素材要出现在素材带里（名字可能被截断，这里用短名字）')
  const importLabel = findNode(tree, (node) => node.type === 'label' && textOf(node).includes('导入视频'))
  assert.ok(importLabel !== null, '导入按钮就在这一行')
  assert.ok(findButton(tree, '▶ 播放一遍') !== null, '播放按钮和导入按钮并排')

  // 两条 CTRL 容器都要在同一行里：素材带里应当是 2 内置 + 1 导入
  const strip = findNode(tree, (node) => node.props?.className === 'dshbv-set-seg dshbv-set-asset')
  assert.ok(strip !== null, '素材带还在')
  const stripButtons = []
  const collect = (node) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(collect)
    if (node.type === 'button') stripButtons.push(textOf(node))
    for (const child of node.children ?? []) collect(child)
  }
  collect(strip)
  assert.deepEqual(stripButtons.slice(0, 3), ['HDD', '月读世界', '我的开场.mp4'], '内置两段 + 导入的一段都在素材带里')
  assert.ok(stripButtons.includes('×'), '导入的那段旁边有小「×」可以删')

  stop()
  const overlay = loaded.exported.__internals.readLiveOverlay()
  if (overlay !== null) await retire(overlay)
})

test('导入界面：删掉正在用的那段，就退回默认素材（不留一个指向空文件的选中态）', { skip: !CLIENT_IMPORT_ENABLED && '界面不带导入（发布版只有内置两段），见 client.js 的 IMPORT_ENABLED' }, async () => {
  const imported = [{ id: 'u-muoxxx-u', label: '要删的.mp4', bytes: 100, at: 1 }]
  const fetchStub = async (url) => ({
    ok: true,
    status: 200,
    json: async () =>
      url === 'dsh-boot-video/imported.json' ? { ok: true, imported: imported } : { ok: true, imported: [] },
  })
  const loaded = loadClient({
    react: makeStatefulReact(),
    storage: { [ASSET_KEY]: 'u-muoxxx-u' },
    fetch: fetchStub,
  })
  const page = mountSettings(loaded)
  const stop = page.setup()
  await new Promise((resolve) => setTimeout(resolve, 30))

  page.click('删除')
  await new Promise((resolve) => setTimeout(resolve, 30))

  assert.equal(loaded.storage.getItem(ASSET_KEY), 'hdd', '删掉当前素材后要退回默认的 HDD')
  assert.equal(findButton(page.render(), '要删的.mp4'), null, '删掉的那条不该还在素材带里')
  assert.equal(
    findNode(page.render(), (node) => node.props?.className === 'dshbv-set-err'),
    null,
    '删除成功就不该出现错误提示',
  )

  // 选了「我的视频」时退回默认会顺手重播一遍（和换素材同一个逻辑），收尾一下。
  const overlay = loaded.exported.__internals.readLiveOverlay()
  if (overlay !== null) {
    assert.match(overlay.video.src, /asset\/hdd\.mp4$/, '退回之后播的是默认素材')
    await retire(overlay)
  }
  stop()
})

test('导入界面：改名走"只改显示名"这条路，改完原地刷新', { skip: !CLIENT_IMPORT_ENABLED && '界面不带导入（发布版只有内置两段），见 client.js 的 IMPORT_ENABLED' }, async () => {
  const imported = [{ id: 'u-muoxxx-r', label: '原文件名.mp4', bytes: 100, at: 1 }]
  const renamed = [{ id: 'u-muoxxx-r', label: '我的开场', bytes: 100, at: 1, custom: true }]
  const seen = []
  const fetchStub = async (url, init) => {
    seen.push({ url, body: init === undefined ? null : init.body })
    if (url === 'dsh-boot-video/import/rename') return { ok: true, status: 200, json: async () => ({ ok: true, imported: renamed }) }
    return { ok: true, status: 200, json: async () => ({ ok: true, imported: imported }) }
  }
  const loaded = loadClient({ react: makeStatefulReact(), fetch: fetchStub })
  const page = mountSettings(loaded)
  const stop = page.setup()
  await new Promise((resolve) => setTimeout(resolve, 30))

  // 点「改名」→ 弹出起名窗口，草稿预填当前名字
  let tree = page.click('改名')
  const modal = findNode(tree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('dshbv-modal'))
  assert.ok(modal !== null, '改名时要弹起名窗口')
  const input = findNode(modal, (node) => node.type === 'input')
  assert.ok(input !== null, '窗口里要有输入框')
  assert.equal(input.props.value, '原文件名.mp4', '草稿预填当前显示名')
  assert.ok(findButton(modal, '就这么定') !== null, '要有确认')
  assert.ok(findButton(modal, '先用原名') !== null, '要有跳过')

  // 改名、确认 → 打到 rename 接口，素材带与列表都换成新名字
  input.props.onChange({ target: { value: '我的开场' } })
  tree = page.click('就这么定')
  await new Promise((resolve) => setTimeout(resolve, 30))
  tree = page.render()

  const call = seen.find((item) => item.url === 'dsh-boot-video/import/rename')
  assert.ok(call !== undefined, '要打到改名接口')
  assert.deepEqual(JSON.parse(call.body), { id: 'u-muoxxx-r', label: '我的开场' })
  assert.match(JSON.stringify(tree), /我的开场/, '列表里要显示新名字')
  assert.ok(findButton(tree, '我的开场') !== null, '素材带里也换成新名字')
  assert.equal(findButton(tree, '改名') !== null, true, '改完还能继续改')

  // 跳过（先用原名）：弹窗关掉，不动本地数据
  page.click('改名')
  page.click('先用原名')
  assert.equal(
    findNode(page.render(), (node) => typeof node.props?.className === 'string' && node.props.className.includes('dshbv-modal')),
    null,
    '跳过之后弹窗要收起',
  )

  stop()
  const overlay = loaded.exported.__internals.readLiveOverlay()
  if (overlay !== null) await retire(overlay)
})

//#endregion
