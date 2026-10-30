/**
 * pricing.mjs —— deepseek-flash 官方价目表（本插件里「钱」的唯一定义）
 *
 * 为什么要单独一个文件：方案 A 放弃「余额差值」，改成
 *   本次花费 = Σ(每个用量桶的增量 × 当时档位的单价)
 * 于是单价成了唯一的可错点。它和 holidays.mjs 一样属于**低频维护、必须准确**
 * 的数据，所以放在一处，由 build.mjs 内联进客户端半边（与 season.mjs 同款做法），
 * 前端不必自己抄一份。
 *
 * 口径（官方定价页，元 / 百万 token）：
 *   缓存命中输入：谷 0.02 / 峰 0.04
 *   缓存未命中输入：谷 1 / 峰 2
 *   输出：谷 4 / 峰 8
 *   峰价为谷价的两倍；峰谷时段见 season.mjs（北京时间工作日 9-12、14-18 为峰）。
 *
 * 缓存写入（cacheWriteTokens）：DeepSeek 的 usage 不单列缓存写入费用，写缓存
 * 的成本已含在「未命中」里；这里按未命中同价兜底，若某天 provider 真的单列，
 * 也不会把这一桶记成免费。
 *
 * ⚠️ 维护提示：价目表变动时只改 PRICE_PER_MILLION。改完跑 `npm test`，
 *    再用 tools/session-cost.mjs 拿真实会话日志对一遍量级。
 *
 * @module pricing
 */

/** 本价目表对应的模型（面板与 README 里展示用）。 */
export const PRICING_MODEL = 'deepseek-flash'

/**
 * 每百万 token 的人民币单价，按档位分组。
 * 键名与 `tokenUsage` 投影的四个桶一一对应。
 * @type {{ valley: Record<string, number>, peak: Record<string, number> }}
 */
export const PRICE_PER_MILLION = {
  valley: { uncachedInput: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 },
  peak: { uncachedInput: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 },
}

/** `tokenUsage` 投影的四个用量桶。 */
export const TOKEN_BUCKETS = [
  'uncachedInputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'outputTokens',
]

/** 金额以 1e8 个整数单位表示 1 元，累加零浮点误差。 */
export const MONEY_SCALE = 1e8

/**
 * 「桶名 → 单价键名」：投影的字段名与价目表用词不同，映射只写一次。
 * @type {Record<string, string>}
 */
const PRICE_KEY_OF_BUCKET = {
  uncachedInputTokens: 'uncachedInput',
  cacheReadTokens: 'cacheRead',
  cacheWriteTokens: 'cacheWrite',
  outputTokens: 'output',
}

/**
 * 每个 token 的价格，单位是「1e8 分之 1 元」的整数。
 *
 * 推导：1 token 花费 `price / 1e6` 元，乘以 MONEY_SCALE 得 `price * 100`。
 * 现有价目（0.02 / 0.04 / 1 / 2 / 4 / 8）乘出来全是整数，所以**单 token 计价
 * 本身没有舍入**，账本只需要在每次增量上取整一次。
 *
 * @param {keyof PRICE_PER_MILLION} phase
 * @returns {{ uncachedInputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, outputTokens: number }}
 */
export function tokenUnits(phase) {
  const price = PRICE_PER_MILLION[phase]
  const out = {}
  for (const bucket of TOKEN_BUCKETS) {
    out[bucket] = price[PRICE_KEY_OF_BUCKET[bucket]] * 100
  }
  return out
}

/** 两档每 token 单价，算一次就够。 */
export const TOKEN_UNITS = {
  valley: tokenUnits('valley'),
  peak: tokenUnits('peak'),
}

/**
 * 把任意投影值归一成四个非负整数桶。
 *
 * 形状不对（null / 非对象）返回 null —— 调用方据此判定「投影还没到」，
 * 而不是把一次坏读当成 0 用量记进账本。
 *
 * @param {unknown} value
 * @returns {{ uncachedInputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, outputTokens: number } | null}
 */
export function normaliseBuckets(value) {
  if (value === null || typeof value !== 'object') return null
  const out = {}
  for (const bucket of TOKEN_BUCKETS) {
    const n = Number(value[bucket])
    out[bucket] = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  }
  return out
}

/**
 * 逐桶增量。任一桶比旧值小（换分支、账本比投影新、投影被重置）时返回 null，
 * 由调用方整体重算，绝不写负数。
 *
 * @param {Record<string, number>} next
 * @param {Record<string, number>} previous
 * @returns {{ uncachedInputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, outputTokens: number } | null}
 */
export function deltaBuckets(next, previous) {
  const out = {}
  for (const bucket of TOKEN_BUCKETS) {
    const n = Number(next[bucket])
    const p = Number(previous[bucket])
    if (!Number.isFinite(n) || !Number.isFinite(p) || n < p) return null
    out[bucket] = n - p
  }
  return out
}

/**
 * 一批用量按档位折成「1e8 单位的金额」。
 *
 * @param {Record<string, number>} buckets
 * @param {boolean} peak 是否峰价
 * @returns {number} 整数金额单位
 */
export function unitsForBuckets(buckets, peak) {
  const price = peak ? TOKEN_UNITS.peak : TOKEN_UNITS.valley
  let units = 0
  for (const bucket of TOKEN_BUCKETS) {
    const tokens = Number(buckets[bucket])
    if (!Number.isFinite(tokens) || tokens <= 0) continue
    units += tokens * price[bucket]
  }
  return units
}

/** 该批用量是否一个 token 都没有（用来跳过无意义写入）。 */
export function isEmptyBuckets(buckets) {
  return TOKEN_BUCKETS.every((bucket) => !(Number(buckets[bucket]) > 0))
}

/**
 * 用一次新的用量快照推进一行账本。
 *
 * 这一行只描述**一个会话**：调用方按 sessionId 各存一行，所以别的对话、别的
 * API Key、手机 App 的消耗进不来 —— 「同一笔钱被记多遍」在结构上就不可能。
 *
 * 三种情况：
 *   · 没有旧行 → 把累计用量整体按当前档位计价（「本次」= 会话总花费）；
 *   · 正常增长 → 只把**增量**按当前档位计价后累加（历史轮次的价格不会被改写）；
 *   · 用量回退 → 整体重算，绝不写负数（换分支、投影重放都可能让累计值变小）。
 *
 * @param {{buckets: Record<string, number>, costUnits: number} | null} row 旧行
 * @param {Record<string, number>} buckets 已归一化的四桶累计值
 * @param {boolean} peak 观察时刻是否峰价
 * @returns {{buckets: Record<string, number>, costUnits: number}} 新行
 */
export function nextCostRow(row, buckets, peak) {
  if (row === null || row === undefined) {
    return { buckets, costUnits: unitsForBuckets(buckets, peak) }
  }
  const previous = normaliseBuckets(row.buckets)
  const delta = previous === null ? null : deltaBuckets(buckets, previous)
  if (delta === null) {
    return { buckets, costUnits: unitsForBuckets(buckets, peak) }
  }
  if (isEmptyBuckets(delta)) return { buckets, costUnits: row.costUnits }
  return { buckets, costUnits: row.costUnits + unitsForBuckets(delta, peak) }
}

/**
 * 面板脚注第 1 行：**当前档位**的单价。
 *
 * 只列此刻适用的三个价格（谷 1 / 0.02 / 4，峰 2 / 0.04 / 8），不再摊
 * 「谷→峰」区间：面板要回答的是"这一轮按什么价扣"，给区间反而要人去心算，
 * 也让这一行在 12px 的面板里折成三行。
 *
 * @param {boolean} peak
 * @returns {string}
 */
export function pricingHint(peak) {
  const price = peak ? PRICE_PER_MILLION.peak : PRICE_PER_MILLION.valley
  return `${PRICING_MODEL} 价目（元/百万 token）：`
    + `未命中 ${price.uncachedInput} · 缓存命中 ${price.cacheRead} · 输出 ${price.output}`
}

/**
 * 面板脚注第 2 行：当前按哪一档计，以及统计口径。
 *
 * 与上一行分开的理由：档位会变、单价随档位变，两件事分两行，扫一眼就能对上；
 * 「不含子代理会话」是口径说明，放这里比塞进价目行更不容易被当成价格的一部分。
 *
 * @param {boolean} peak
 * @returns {string}
 */
export function pricingPhaseHint(peak) {
  return `当前按${peak ? '峰价' : '谷价'}计 · 不含子代理会话`
}
