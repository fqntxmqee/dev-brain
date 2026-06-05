/**
 * v0.9.0: 长文本分片（CAP-GW-06 / T-93）
 *
 * 飞书单条 text 限制 16KB (MAX_REPLY_TEXT_BYTES)。
 * 当 Gateway 收到 /status / 汇总 / 错误 等长文本时,splitTextIntoChunks
 * 把它们切成 ≤ limitBytes 的 N 段,逐条 send。
 *
 * 切分策略(对每段,贪心填充直到接近 limit):
 *  1. 逐 code point 累加到 current
 *  2. 累加会超限时,在 current 末尾找最近的软切点(\n 空格 \t)
 *  3. 没软切点找硬切点(。!?！?)
 *  4. 都没就硬切(但始终在 code point 边界,不会切碎汉字/emoji)
 *
 * 性能: O(N),N 为输入字符数;典型 16KB 输入 < 1ms。
 */

const SOFT_BREAKS = new Set<string>(["\n", " ", "\t"]);
const HARD_BREAKS = new Set<string>(["。", "!", "?", "！", "?", ";"]);

export interface SplitOptions {
  /** 单段字节上限;默认 16 * 1024 */
  readonly limitBytes?: number;
}

export function splitTextIntoChunks(
  text: string,
  options: SplitOptions = {},
): ReadonlyArray<string> {
  const limit = options.limitBytes ?? 16 * 1024;
  if (text.length === 0) return [""];
  if (Buffer.byteLength(text, "utf8") <= limit) return [text];

  const chunks: string[] = [];
  const chars = Array.from(text);
  let current = "";
  let currentBytes = 0;

  for (const ch of chars) {
    const chBytes = Buffer.byteLength(ch, "utf8");

    // 单字符 > limit 的极端情况(理论上不会发生,4 字节上限 < 16KB)
    if (chBytes > limit) {
      if (current.length > 0) chunks.push(current);
      chunks.push(ch);
      current = "";
      currentBytes = 0;
      continue;
    }

    if (currentBytes + chBytes <= limit) {
      current += ch;
      currentBytes += chBytes;
      continue;
    }

    // 累加会超限 → 在 current 末尾找软切点
    const splitAt = current.length > 0 ? findSplitPoint(current) : 0;
    if (splitAt > 0 && splitAt < current.length) {
      // 切点在中间:前段 push,后段保留
      chunks.push(current.slice(0, splitAt));
      current = current.slice(splitAt);
      currentBytes = Buffer.byteLength(current, "utf8");
    } else if (splitAt === current.length) {
      // 切点在末尾(刚好是 \n 等):前段 push,后段空
      chunks.push(current);
      current = "";
      currentBytes = 0;
    } else {
      // 没找到切点(整段是连续字符):硬切 current
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }

    // 把当前字符加到切后 current
    if (currentBytes + chBytes <= limit) {
      current += ch;
      currentBytes += chBytes;
    } else {
      // current 已经接近 limit 但 ch 还是塞不下 — 单独成段
      if (current.length > 0) chunks.push(current);
      current = ch;
      currentBytes = chBytes;
    }
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * 在 current 末尾找切点:从后向前扫描,优先 \n / space / tab,次选 。!? 等。
 * 返回切点(切点前的字符保留为一段,切点后的留到下段);找不到返 0(无法优化,硬切)。
 */
function findSplitPoint(current: string): number {
  for (let i = current.length; i > 0; i -= 1) {
    const c = current[i - 1];
    if (c === undefined) continue;
    if (SOFT_BREAKS.has(c)) return i;
  }
  for (let i = current.length; i > 0; i -= 1) {
    const c = current[i - 1];
    if (c === undefined) continue;
    if (HARD_BREAKS.has(c)) return i;
  }
  return 0;
}
