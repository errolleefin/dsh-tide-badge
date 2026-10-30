#!/usr/bin/env node
/**
 * client-smoke.mjs —— 在 Node 里跑真实构建产物 lib/client.js 的无头冒烟测试。
 *
 * 为什么需要它：客户端半边是注入浏览器的普通脚本，改完只能靠人刷新页面看。
 * 这里用最小 DOM/React/localStorage 桩把它跑起来，验证三件最容易错、错了也
 * 只是静默算错钱的事：
 *   1. 芯片挂载后能用「会话 id + tokenUsage 四桶」算出「本次」；
 *   2. 切到另一个会话再切回来，旧会话的金额不被重算、不被另一会话吃掉；
 *   3. 账本按 sessionId 分行写进 localStorage，且旧差值法账本被清掉。
 *
 * 用法：node tools/client-smoke.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
const source = fs.readFileSync(CLIENT, 'utf8')

/**
 * 固定时钟：2026-10-28 22:19 北京时间（周三晚，谷价）。
 *
 * 价格依赖峰/谷档位，用真实时钟跑测试会在工作日上午变红 —— 这不是被测代码的
 * 问题，而是测试自己不稳定，所以把 Date 钉死。
 */
const FIXED_NOW = Date.UTC(2026, 9, 28, 14, 19, 0)
class FixedDate extends Date {
  constructor(...args) {
    super(...(args.length === 0 ? [FIXED_NOW] : args))
  }
  static now() { return FIXED_NOW }
}

/* ---------- 最小 DOM ---------- */

function element(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    handlers: {},
    style: {},
    dataset: {},
    attributes: {},
    className: '',
    textContent: '',
    innerHTML: '',
    hidden: false,
    offsetWidth: 320,
    offsetHeight: 200,
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute(name, value) { this.attributes[name] = String(value) },
    getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null },
    append(...nodes) { this.children.push(...nodes) },
    appendChild(child) { this.children.push(child); child.parentNode = this; return child },
    replaceChildren() { this.children.length = 0 },
    remove() {
      const parent = this.parentNode
      if (parent) parent.children = parent.children.filter((child) => child !== this)
    },
    contains(child) { return child === this || this.children.includes(child) },
    // 面板里的 .dsh-tide-rows / .dsh-tide-note / .dsh-tide-pricing 用选择器取：
    // 同一个选择器必须返回同一个节点，否则 fillPanel 每次都会往新节点里写。
    querySelector(selector) {
      this.queried ??= new Map()
      if (!this.queried.has(selector)) this.queried.set(selector, element('div'))
      return this.queried.get(selector)
    },
    querySelectorAll() { return [] },
    addEventListener(name, fn) { (this.handlers[name] ??= []).push(fn) },
    removeEventListener() {},
    fire(name, event) { for (const fn of this.handlers[name] ?? []) fn(event ?? {}) },
    getBoundingClientRect() { return { top: 0, bottom: 24, left: 0, right: 100, width: 100, height: 24 } },
  }
  return node
}

let chip = null
const row = element('div')
const originalAppend = row.appendChild.bind(row)
row.appendChild = (node) => {
  const out = originalAppend(node)
  if (node.className === 'dsh-tide-badge') {
    chip = node
    node.parentNode = row
  }
  return out
}

const document = {
  head: element('head'),
  body: element('body'),
  hidden: false,
  createElement: (tag) => element(tag),
  querySelector(selector) {
    if (selector === '[data-composer-stats="true"]') return row
    if (selector === '.dsh-tide-badge') return chip
    return null
  },
  querySelectorAll() { return [] },
  addEventListener() {},
  removeEventListener() {},
}

/* ---------- localStorage / window / fetch ---------- */

const store = new Map()
const localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(String(key), String(value)) },
  removeItem: (key) => { store.delete(String(key)) },
}
store.set('dsh-tide-badge/session-cost', '{"default":{"baseUnits":1,"costUnits":1}}')

let loaded = null
const window = {
  __ModuleLoader__: { load: (definition) => { loaded = definition } },
  localStorage,
  document,
  innerWidth: 1200,
  innerHeight: 800,
  setInterval: () => 1,
  clearInterval: () => {},
  setTimeout: () => 1,
  clearTimeout: () => {},
  requestAnimationFrame: (fn) => { fn(0); return 1 },
  matchMedia: () => ({ matches: false }),
  addEventListener() {},
  removeEventListener() {},
}

class MutationObserver {
  observe() {}
  disconnect() {}
}

const fetch = async () => ({ ok: false, status: 503, json: async () => ({}) })

/* ---------- React 桩：手跑 useEffect ---------- */

let hookSlots = []
function renderComponent(component, props) {
  hookSlots = []
  component(props)
  const slots = hookSlots
  for (const slot of slots) {
    if (slot.previous !== undefined && sameDeps(slot.previous, slot.deps)) continue
    const cleanup = slot.fn()
    if (typeof cleanup === 'function') slot.cleanup = cleanup
  }
  for (const slot of slots) slot.previous = slot.deps
}
function sameDeps(a, b) {
  if (a === undefined || b === undefined) return false
  if (a.length !== b.length) return false
  return a.every((item, index) => Object.is(item, b[index]))
}
const react = {
  useEffect(fn, deps) { hookSlots.push({ fn, deps }) },
  useMemo(fn) { return fn() },
  useRef(value) { return { current: value } },
  useState(value) { return [value, () => {}] },
  createElement() { return null },
}

/* ---------- 装配 ---------- */

const context = vm.createContext({
  window,
  document,
  localStorage,
  MutationObserver,
  fetch,
  console,
  Intl,
  Date: FixedDate,
  setTimeout,
  clearTimeout,
})
vm.runInContext(source, context, { filename: 'client.js' })
assert.ok(loaded !== null, 'client.js 应该调用 window.__ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-tide-badge')

const mod = loaded.factory(() => react)
const ctx = {
  get: () => undefined,
  on() {},
  effect(fn) { fn() },
  slots: {
    inject(_key, cb) { cb() },
    register(_options, component) { ctx.component = component; return () => {} },
  },
}
mod.apply(ctx)
assert.equal(typeof ctx.component, 'function', '应该注册 conversation.composer.dock 的芯片组件')

/* ---------- 断言 ---------- */

let passed = 0
function ok(name, fn) {
  fn()
  passed += 1
  console.log('  ✓ ' + name)
}

const costSpan = () => chip.children[4]
const amount = (text) => text.replace(/^·\s*本次\s*/, '')
const buckets = (miss, hit, out) => ({
  uncachedInputTokens: miss,
  cacheReadTokens: hit,
  cacheWriteTokens: 0,
  outputTokens: out,
})

console.log('\n=== 挂载与会话 A ===')

let usage = buckets(100_000, 4_000_000, 30_000)
renderComponent(ctx.component, { sessionId: 'session-A', useProjection: () => usage })
assert.ok(chip !== null, '芯片应挂到统计行上')

ok('会话 A 的「本次」= 累计用量 × 谷价 = 0.2921¥', () => {
  usage = buckets(98_732, 4_139_008, 27_649)
  renderComponent(ctx.component, { sessionId: 'session-A', useProjection: () => usage })
  assert.equal(amount(costSpan().textContent), '0.2921¥')
})

ok('旧差值法账本被清掉，新账本按 sessionId 分行', () => {
  assert.equal(localStorage.getItem('dsh-tide-badge/session-cost'), null)
  const ledger = JSON.parse(localStorage.getItem('dsh-tide-badge/session-cost/v2'))
  assert.equal(ledger.v, 2)
  assert.deepEqual(Object.keys(ledger.sessions), ['session-A'])
  assert.equal(ledger.sessions['session-A'].costUnits, 29_210_816)
})

console.log('\n=== 切到会话 B，再切回 A ===')

ok('会话 B 显示自己的花费（不继承 A）', () => {
  usage = buckets(0, 1_000_000, 0)
  renderComponent(ctx.component, { sessionId: 'session-B', useProjection: () => usage })
  assert.equal(amount(costSpan().textContent), '0.02¥')
})

ok('切回 A：金额不变，也没有吃下 B 的增量', () => {
  usage = buckets(98_732, 4_139_008, 27_649)
  renderComponent(ctx.component, { sessionId: 'session-A', useProjection: () => usage })
  assert.equal(amount(costSpan().textContent), '0.2921¥')
  const ledger = JSON.parse(localStorage.getItem('dsh-tide-badge/session-cost/v2'))
  assert.equal(ledger.sessions['session-A'].costUnits, 29_210_816)
  assert.equal(ledger.sessions['session-B'].costUnits, 2_000_000)
})

ok('A 继续消耗：只把增量按当时档位加上去', () => {
  // 再烧 100 万缓存命中（固定时钟 22:19，谷价）= +¥0.02
  usage = buckets(98_732, 5_139_008, 27_649)
  renderComponent(ctx.component, { sessionId: 'session-A', useProjection: () => usage })
  const ledger = JSON.parse(localStorage.getItem('dsh-tide-badge/session-cost/v2'))
  assert.equal(ledger.sessions['session-A'].costUnits, 29_210_816 + 2_000_000)
  assert.equal(amount(costSpan().textContent), '0.3121¥')
})

ok('同一份快照重复到达不重复记账', () => {
  const before = JSON.parse(localStorage.getItem('dsh-tide-badge/session-cost/v2'))
  renderComponent(ctx.component, { sessionId: 'session-A', useProjection: () => usage })
  const after = JSON.parse(localStorage.getItem('dsh-tide-badge/session-cost/v2'))
  assert.deepEqual(after.sessions['session-A'], before.sessions['session-A'])
})

console.log('\n=== 面板 ===')

/** 面板里 dt/dd 的纯文本对。 */
function panelPairs() {
  const panel = document.body.children.find((node) => node.className === 'dsh-tide-panel')
  assert.ok(panel !== undefined, '点药丸应挂出面板')
  const rows = panel.querySelector('.dsh-tide-rows').children
  const pairs = []
  for (let i = 0; i + 1 < rows.length; i += 2) pairs.push([rows[i].textContent, rows[i + 1].textContent])
  return { panel, pairs }
}

ok('点开面板：本次花费、逐桶用量都在', () => {
  chip.fire('click')
  const { pairs } = panelPairs()
  const map = new Map(pairs)
  assert.equal(map.get('本次花费'), '0.3121¥（按价目表估算）')
  assert.equal(map.get('未命中输入'), '98,732')
  assert.equal(map.get('缓存命中输入'), '5,139,008')
  assert.equal(map.get('输出'), '27,649')
  assert.equal(map.has('缓存写入'), false)
  assert.ok(map.has('计费时段'), '既有时段行应保留')
})

ok('面板脚注：只列当前档位单价，另起一行给档位与口径', () => {
  const { panel } = panelPairs()
  const prices = panel.querySelector('.dsh-tide-prices').textContent
  const phase = panel.querySelector('.dsh-tide-phase').textContent
  assert.equal(prices, 'deepseek-flash 价目（元/百万 token）：未命中 1 · 缓存命中 0.02 · 输出 4')
  assert.equal(phase, '当前按谷价计 · 不含子代理会话')
  assert.equal(prices.includes('→'), false, '价目行不应再出现谷→峰区间')
})

console.log('\n=== 没有用量投影时 ===')

ok('投影缺失：显示 0¥ 而不是崩掉，也不写坏账本', () => {
  renderComponent(ctx.component, { sessionId: 'session-C', useProjection: () => undefined })
  assert.equal(amount(costSpan().textContent), '0¥')
  const ledger = JSON.parse(localStorage.getItem('dsh-tide-badge/session-cost/v2'))
  assert.equal(ledger.sessions['session-C'], undefined)
})

console.log('\n结果: ' + passed + ' 通过\n')
