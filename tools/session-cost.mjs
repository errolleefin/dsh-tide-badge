#!/usr/bin/env node
/**
 * session-cost.mjs —— 用会话日志里的 provider usage 复算「按价目表」的每会话花费。
 *
 * 用途：验证 dsh-tide-badge 方案 A 的价目表与归属口径（会话级 token × 价目表）
 * 能不能对上真实数据，而不依赖插件的浏览器半边。
 *
 * 用法：node tools/session-cost.mjs [--all] [--limit N] [--json]
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { isPeak } from '../lib/season.mjs'

const SESSIONS = path.join(process.env.USERPROFILE ?? '', '.dsh', 'sessions')
const scale = 1e8
// 与 lib/pricing.mjs 保持一致：元 / 百万 token
const PRICE = {
  peak: { uncachedInput: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 },
  valley: { uncachedInput: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 },
}
const units = (tokens, price) => Math.round(tokens * price * 100)

function listLogs(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listLogs(full))
    else if (entry.name === 'session.v4.jsonl.zstd') out.push(full)
  }
  return out
}

/** 会话日志每追加一次就写一个独立的 zstd frame：逐帧解码后再拼接。 */
function decompressAll(buffer) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const frames = []
  let start = buffer.indexOf(magic)
  if (start < 0) return buffer
  while (start >= 0) {
    const next = buffer.indexOf(magic, start + 4)
    frames.push(buffer.subarray(start, next < 0 ? undefined : next))
    start = next
  }
  const parts = []
  for (const frame of frames) {
    try {
      parts.push(zlib.zstdDecompressSync(frame))
    } catch {
      /* 帧边界误判：跳过该段 */
    }
  }
  return Buffer.concat(parts)
}

function readEvents(file) {
  const text = decompressAll(fs.readFileSync(file)).toString('utf8')
  const events = []
  let header = null
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (parsed.type === 'session' && parsed.id !== undefined) {
      header = parsed
      continue
    }
    const event = parsed.event ?? parsed
    if (event === null || typeof event !== 'object' || typeof event.type !== 'string') continue
    events.push({ type: event.type, time: Number(parsed.time ?? event.time ?? 0), data: event.data })
  }
  return { header, events }
}

const rows = []
for (const file of listLogs(SESSIONS)) {
  const { header, events } = readEvents(file)
  const totals = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
  const cost = { peak: 0, valley: 0 }
  let turns = 0
  let first = null
  let last = null
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const usage = event.data && event.data.usage
    if (usage === undefined || usage === null) continue
    turns += 1
    const at = event.time
    if (first === null || at < first) first = at
    if (last === null || at > last) last = at
    const peak = isPeak(new Date(at))
    const buckets = {
      uncachedInputTokens: Number(usage.inputTokens ?? 0),
      cacheReadTokens: Number(usage.cacheReadTokens ?? 0),
      cacheWriteTokens: Number(usage.cacheWriteTokens ?? 0),
      outputTokens: Number(usage.outputTokens ?? 0),
    }
    for (const key of Object.keys(totals)) totals[key] += buckets[key]
    const price = peak ? PRICE.peak : PRICE.valley
    cost[peak ? 'peak' : 'valley'] += units(buckets.uncachedInputTokens, price.uncachedInput)
      + units(buckets.cacheReadTokens, price.cacheRead)
      + units(buckets.cacheWriteTokens, price.cacheWrite)
      + units(buckets.outputTokens, price.output)
  }
  const id = header?.id ?? path.basename(path.dirname(file))
  const totalCost = (cost.peak + cost.valley) / scale
  rows.push({ id, file, turns, totals, totalCost, first, last })
}

rows.sort((a, b) => b.totalCost - a.totalCost)
const limit = process.argv.includes('--all') ? rows.length : Number(process.argv[process.argv.indexOf('--limit') + 1] || 12)
let sum = 0
for (const row of rows.slice(0, limit)) {
  sum += row.totalCost
  const span = row.first === null ? '' : new Date(row.first).toISOString().slice(5, 16) + ' → ' + new Date(row.last).toISOString().slice(5, 16)
  console.log(
    `${row.id.slice(0, 20).padEnd(21)} turns=${String(row.turns).padStart(4)}  `
    + `miss=${String(row.totals.uncachedInputTokens).padStart(9)}  `
    + `hit=${String(row.totals.cacheReadTokens).padStart(10)}  `
    + `out=${String(row.totals.outputTokens).padStart(8)}  `
    + `¥${row.totalCost.toFixed(4).padStart(9)}  ${span}`,
  )
}
console.log(`-- ${rows.length} sessions, top ${Math.min(limit, rows.length)} total ¥${sum.toFixed(4)}`)
