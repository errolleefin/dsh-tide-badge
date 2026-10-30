/**
 * pricing.test.mjs —— 价目表与记账规则的单元测试
 *
 * 单元测试在这里格外重要：算错钱不会抛错，只会静默给错数字。所以
 *   1. 价目表本身钉死（峰价 = 谷价 ×2、每 token 单价精确到 1e8 单位）；
 *   2. 逐桶折算用真实会话的用量对一遍（会话 A 的日志复算 = ¥0.2921）；
 *   3. 记账推进（nextCostRow）证明「同一笔钱不会记两遍」「回退不写负数」。
 *
 * 用法：node --test lib/pricing.test.mjs   （或直接 node lib/pricing.test.mjs）
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const LIB = path.dirname(fileURLToPath(import.meta.url))
const pricing = await import(pathToFileURL(path.join(LIB, 'pricing.mjs')).href)
const {
  PRICE_PER_MILLION,
  TOKEN_BUCKETS,
  TOKEN_UNITS,
  MONEY_SCALE,
  normaliseBuckets,
  deltaBuckets,
  unitsForBuckets,
  isEmptyBuckets,
  nextCostRow,
  pricingHint,
  pricingPhaseHint,
} = pricing
const { tokenUnits } = pricing

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    fn()
    passed++
    console.log('  ✓ ' + name)
  } catch (err) {
    failed++
    console.log('  ✗ ' + name)
    console.log('      ' + String(err.message).split('\n').join('\n      '))
  }
}

/** 构造四桶。 */
const buckets = (uncachedInputTokens = 0, cacheReadTokens = 0, outputTokens = 0, cacheWriteTokens = 0) => ({
  uncachedInputTokens,
  cacheReadTokens,
  cacheWriteTokens,
  outputTokens,
})

/** 1e8 单位 → 元。 */
const yuan = (units) => units / MONEY_SCALE

console.log('\n=== 价目表形状 ===')

check('四个用量桶都有单价', () => {
  for (const phase of ['valley', 'peak']) {
    for (const key of ['uncachedInput', 'cacheRead', 'cacheWrite', 'output']) {
      assert.equal(typeof PRICE_PER_MILLION[phase][key], 'number')
      assert.ok(PRICE_PER_MILLION[phase][key] > 0)
    }
  }
})

check('峰价恒为谷价的两倍', () => {
  for (const key of ['uncachedInput', 'cacheRead', 'cacheWrite', 'output']) {
    assert.equal(PRICE_PER_MILLION.peak[key], PRICE_PER_MILLION.valley[key] * 2, key)
  }
})

check('缓存写入与未命中同价（DeepSeek 不单列写入费）', () => {
  for (const phase of ['valley', 'peak']) {
    assert.equal(PRICE_PER_MILLION[phase].cacheWrite, PRICE_PER_MILLION[phase].uncachedInput)
  }
})

console.log('\n=== 每 token 单价（1e8 单位的整数） ===')

check('谷价：未命中 1 元/M、缓存命中 0.02 元/M、输出 4 元/M', () => {
  assert.equal(TOKEN_UNITS.valley.uncachedInputTokens, 100)
  assert.equal(TOKEN_UNITS.valley.cacheReadTokens, 2)
  assert.equal(TOKEN_UNITS.valley.cacheWriteTokens, 100)
  assert.equal(TOKEN_UNITS.valley.outputTokens, 400)
})

check('峰价：未命中 2 元/M、缓存命中 0.04 元/M、输出 8 元/M', () => {
  assert.equal(TOKEN_UNITS.peak.uncachedInputTokens, 200)
  assert.equal(TOKEN_UNITS.peak.cacheReadTokens, 4)
  assert.equal(TOKEN_UNITS.peak.cacheWriteTokens, 200)
  assert.equal(TOKEN_UNITS.peak.outputTokens, 800)
})

check('单价都是整数（记账零舍入）', () => {
  for (const phase of ['valley', 'peak']) {
    for (const key of TOKEN_BUCKETS) {
      assert.ok(Number.isInteger(TOKEN_UNITS[phase][key]), phase + '.' + key)
    }
  }
  assert.deepEqual(tokenUnits('valley'), TOKEN_UNITS.valley)
})

console.log('\n=== 逐桶折算 ===')

check('100 万未命中输入：谷 ¥1、峰 ¥2', () => {
  assert.equal(yuan(unitsForBuckets(buckets(1_000_000), false)), 1)
  assert.equal(yuan(unitsForBuckets(buckets(1_000_000), true)), 2)
})

check('100 万缓存命中：谷 ¥0.02、峰 ¥0.04', () => {
  assert.equal(yuan(unitsForBuckets(buckets(0, 1_000_000), false)), 0.02)
  assert.equal(yuan(unitsForBuckets(buckets(0, 1_000_000), true)), 0.04)
})

check('100 万输出：谷 ¥4、峰 ¥8', () => {
  assert.equal(yuan(unitsForBuckets(buckets(0, 0, 1_000_000), false)), 4)
  assert.equal(yuan(unitsForBuckets(buckets(0, 0, 1_000_000), true)), 8)
})

check('空桶折 0', () => {
  assert.equal(unitsForBuckets(buckets(), false), 0)
  assert.equal(unitsForBuckets(buckets(), true), 0)
})

// 会话 A（62 轮，2026-10-24 13:10–13:15，全程谷价）的日志实测累计值：
//   未命中 98,732 / 缓存命中 4,139,008 / 输出 27,649
// issue 里按官方价目表逐轮估算是 ¥0.2921，这里必须复算出同一个数。
check('真实会话 A 的累计用量复算 = ¥0.2921（回归）', () => {
  const usage = buckets(98_732, 4_139_008, 27_649)
  assert.equal(yuan(unitsForBuckets(usage, false)).toFixed(4), '0.2921')
})

console.log('\n=== 归一化 ===')

check('null / 非对象 → null（表示投影还没到，不当作 0 记账）', () => {
  assert.equal(normaliseBuckets(null), null)
  assert.equal(normaliseBuckets(undefined), null)
  assert.equal(normaliseBuckets(42), null)
  assert.equal(normaliseBuckets('x'), null)
})

check('负数与小数被夹平，缺字段补 0', () => {
  assert.deepEqual(normaliseBuckets({ uncachedInputTokens: -5, cacheReadTokens: 3.9 }), buckets(0, 3))
  assert.deepEqual(normaliseBuckets({}), buckets())
})

console.log('\n=== 增量 ===')

check('正常增长逐桶求差', () => {
  assert.deepEqual(deltaBuckets(buckets(10, 20, 30), buckets(4, 20, 10)), buckets(6, 0, 20))
})

check('任一桶回退 → null（调用方整体重算，不写负数）', () => {
  assert.equal(deltaBuckets(buckets(5, 5, 5), buckets(5, 6, 5)), null)
  assert.equal(deltaBuckets(buckets(), buckets(1)), null)
})

check('isEmptyBuckets 只认全零', () => {
  assert.equal(isEmptyBuckets(buckets()), true)
  assert.equal(isEmptyBuckets(buckets(0, 0, 0, 1)), false)
})

console.log('\n=== 记账推进（nextCostRow） ===')

check('首次见到：累计用量整体按当前档位计价', () => {
  const row = nextCostRow(null, buckets(0, 1_000_000), false)
  assert.equal(yuan(row.costUnits), 0.02)
  assert.deepEqual(row.buckets, buckets(0, 1_000_000))
})

check('峰→谷：历史轮次不被重新定价，增量按新档位', () => {
  // 峰价烧掉 100 万缓存命中 = ¥0.04
  let row = nextCostRow(null, buckets(0, 1_000_000), true)
  assert.equal(yuan(row.costUnits), 0.04)
  // 谷价再加 100 万缓存命中 = +¥0.02
  row = nextCostRow(row, buckets(0, 2_000_000), false)
  assert.equal(yuan(row.costUnits), 0.06)
})

check('用量回退（换分支 / 投影重放）整体重算，不出现负数', () => {
  let row = nextCostRow(null, buckets(0, 2_000_000), true)
  assert.equal(yuan(row.costUnits), 0.08)
  row = nextCostRow(row, buckets(0, 1_000_000), false)
  assert.equal(yuan(row.costUnits), 0.02)
  assert.ok(row.costUnits >= 0)
})

check('没有新用量时不改写已有金额', () => {
  const row = nextCostRow(null, buckets(0, 1_000_000), true)
  const same = nextCostRow(row, buckets(0, 1_000_000), false)
  assert.equal(same.costUnits, row.costUnits)
})

check('两个会话各记一行：同一段余额下降不会串账', () => {
  // 会话 A 花 ¥0.02，会话 B 花 ¥0.04；账本各自独立。
  let a = nextCostRow(null, buckets(0, 1_000_000), false)
  let b = nextCostRow(null, buckets(0, 1_000_000), true)
  a = nextCostRow(a, buckets(0, 1_500_000), false)
  b = nextCostRow(b, buckets(0, 1_000_000), true)
  assert.equal(yuan(a.costUnits).toFixed(4), '0.0300')
  assert.equal(yuan(b.costUnits).toFixed(4), '0.0400')
  // 旧差值法的复现：B 的增量若被 A 再吃一次，A 会变成 ¥0.05 —— 这里必须没有。
  assert.notEqual(yuan(a.costUnits).toFixed(4), '0.0500')
})

console.log('\n=== 面板文案 ===')

check('价目行只给当前档位的三个单价', () => {
  assert.equal(
    pricingHint(false),
    'deepseek-flash 价目（元/百万 token）：未命中 1 · 缓存命中 0.02 · 输出 4',
  )
  assert.equal(
    pricingHint(true),
    'deepseek-flash 价目（元/百万 token）：未命中 2 · 缓存命中 0.04 · 输出 8',
  )
})

check('价目行不再出现「谷→峰」区间', () => {
  for (const peak of [true, false]) {
    assert.equal(pricingHint(peak).includes('→'), false, pricingHint(peak))
  }
})

check('档位行给出当前档位与统计口径', () => {
  assert.equal(pricingPhaseHint(false), '当前按谷价计 · 不含子代理会话')
  assert.equal(pricingPhaseHint(true), '当前按峰价计 · 不含子代理会话')
})

console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败\n')
process.exit(failed === 0 ? 0 : 1)
