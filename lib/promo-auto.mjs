/**
 * 活动福利「自动签到」的当日闸门（纯判据，不碰磁盘与网络）。
 *
 * ## 设计来源
 *
 * 参照 anye-99/dsh-codearts-auth 的 auto-checkin 模块（实测有效的成熟方案）。核心洞见：
 *
 * 1. **「打开 DSH 就签」比「每天固定钟点签」可靠**：定时器只在本进程存活期间有效，
 *    DSH 不是常驻服务。若做成「每天 10:05 跑」，实际会退化成「恰好 10:05 开着才签」——
 *    更不可靠，却让用户以为它准时。所以触发点是「插件装配完成」，低频 timer 只是兜底。
 * 2. **必须自己记住「今天签过了」**：一天开关十几次不能签十几次 → UTC+8 当日闸门。
 * 3. **失败次日再试，当天最多 N 次**：凭据失效的账号不该每开一次 DSH 就发一轮必然失败的请求。
 *
 * ## 「成功」的判定
 *
 * `succeeded` 为 true 才挡住当天后续运行。判据是「本次 claimAll 没有失败」——注意
 * `claimedCount === 0`（今日无可领 / 今日已领）**也算成功**：服务端对重复领取幂等，
 * 而把「暂无活动」当成失败会导致同一天反复运行。只有真正抛错（cookie 过期 / 网络失败）
 * 才算失败，留到下次打开 DSH 重试。
 *
 * @module dsh-huawei-connect/promo-auto
 */

/** 服务端账期时区 UTC+8（写死，不取本机时区——出差 / 改时区会算错日界）。 */
export const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000

/** 同一自然日内最多自动尝试次数（失败兜底，防止对坏凭据反复发请求）。 */
export const MAX_ATTEMPTS_PER_DAY = 3

/** 合法日键：YYYY-MM-DD，且月/日必须在真实范围内（脏数据不能绕过闸门）。 */
const DAY_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

/** 取某时刻所属的 UTC+8 自然日键。用算术偏移 + getUTC*，不用本地时区 API。 */
export function utc8DayKey(ms) {
  const shifted = new Date(ms + UTC8_OFFSET_MS)
  const year = shifted.getUTCFullYear()
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  return year + '-' + month + '-' + day
}

/** 新装用户的默认状态：默认开启（主打能力，不该让用户先去面板找开关）。 */
export function defaultAutoState() {
  return { enabled: true, day: null, attempts: 0, succeeded: false, lastRunAt: null, lastAutoClaim: undefined }
}

function nonNegativeInt(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

/** 逐字段保守归一化磁盘状态（文档可能被手工编辑 / 残留旧版本格式）。 */
export function sanitizeAutoState(raw) {
  const fallback = defaultAutoState()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fallback
  return {
    // 只有显式 false 才关闭，缺省 / 脏值都按开启。
    enabled: raw.enabled !== false,
    day: typeof raw.day === 'string' && DAY_KEY_PATTERN.test(raw.day) ? raw.day : null,
    attempts: nonNegativeInt(raw.attempts, 0),
    succeeded: raw.succeeded === true,
    lastRunAt: Number.isFinite(raw.lastRunAt) && raw.lastRunAt > 0 ? raw.lastRunAt : null,
    lastAutoClaim:
      raw.lastAutoClaim !== null && typeof raw.lastAutoClaim === 'object' && !Array.isArray(raw.lastAutoClaim)
        ? raw.lastAutoClaim
        : undefined,
  }
}

/**
 * 判定本次要不要跑。纯函数，不产生副作用。
 *
 * @returns {{ run: boolean, reason?: string, day: string, attemptsToday: number }}
 */
export function decideAutoRun(state, now, maxAttempts = MAX_ATTEMPTS_PER_DAY) {
  const day = utc8DayKey(now)
  if (!state.enabled) return { run: false, reason: 'disabled', day, attemptsToday: state.attempts }
  // 新的一天：计数归零（旧 state 的 attempts / succeeded 都属于昨天）。
  if (state.day !== day) return { run: true, day, attemptsToday: 0 }
  if (state.succeeded) return { run: false, reason: 'done', day, attemptsToday: state.attempts }
  if (state.attempts >= maxAttempts) return { run: false, reason: 'exhausted', day, attemptsToday: state.attempts }
  return { run: true, day, attemptsToday: state.attempts }
}

/** 跳过原因的用户可读文案（日志 / 卡片共用）。 */
export function skipReasonText(reason) {
  switch (reason) {
    case 'done': return '今天已签到，跳过'
    case 'exhausted': return '今天已达尝试上限，下次打开再试'
    case 'disabled': return '自动领取已关闭'
    case 'no-cookie': return '尚未配置会话 cookie'
    case 'running': return '上次签到仍在进行'
    default: return '跳过'
  }
}
