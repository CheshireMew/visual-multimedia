export const DAY_MS = 86400000;

export function validatePrices(prices) {
  if (!Array.isArray(prices) || prices.length < 2) throw new Error("需要至少两个真实价格点");
  let previous = -Infinity;
  for (const point of prices) {
    if (!Number.isSafeInteger(point.timestamp) || point.timestamp <= previous
      || !Number.isFinite(point.close) || point.close <= 0) {
      throw new Error("价格必须为正数，时间戳必须严格递增且不能重复");
    }
    previous = point.timestamp;
  }
  return prices;
}

export function dateLabel(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function spaceMixedText(text) {
  return text.replace(/\$[ \t\u00a0]+(?=[A-Za-z])/gu, "$")
    .replace(/(?<=\p{Script=Han})[ \t\u00a0]+(?=\p{Script=Han})/gu, "")
    .replace(/([\p{Script=Han}])[ \t\u00a0]*(\$?[A-Za-z0-9])/gu, "$1 $2")
    .replace(/([A-Za-z0-9](?:[%％])?)[ \t\u00a0]*([\p{Script=Han}])/gu, "$1 $2");
}

export function amountLabel(amount, currency = "USDT", compact = true) {
  const absolute = Math.abs(amount);
  const divisor = compact ? (absolute >= 1e8 ? 1e8 : absolute >= 1e4 ? 1e4 : 1) : 1;
  const unit = divisor === 1e8 ? "亿" : divisor === 1e4 ? "万" : "";
  const currencySpacing = unit && /^\p{Script=Han}/u.test(currency) ? "" : " ";
  return `${(amount / divisor).toLocaleString("zh-CN", {maximumFractionDigits: divisor === 1 ? 0 : 2})}${unit ? ` ${unit}` : ""}${currency ? `${currencySpacing}${currency}` : ""}`;
}

export function niceCeiling(value) {
  if (!(value > 0)) throw new Error("坐标范围必须为正数");
  const base = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / base / 0.25) * 0.25 * base;
}

export function prepareSeries(prices, principal, windowDays) {
  validatePrices(prices);
  if (!(Number.isFinite(principal) && principal > 0) || !(windowDays > 0)) {
    throw new Error("本金和窗口天数必须为正数");
  }
  const units = principal / prices[0].close;
  const values = prices.map((p) => p.close * units);
  // Causal rescaling: only candles already revealed contribute to the axis.
  const tops = [];
  let left = 0;
  let scale = principal * 1.3;
  for (let i = 0; i < prices.length; i += 1) {
    while (prices[left].timestamp < prices[i].timestamp - windowDays * DAY_MS) left += 1;
    const wanted = niceCeiling(Math.max(...values.slice(left, i + 1)) * 1.22);
    scale = Math.max(wanted, scale + (wanted - scale) * 0.04);
    tops.push(scale);
  }
  const maximum = Math.max(...values);
  return {prices, values, tops, units, principal, windowDays,
    maximum, peakIndex: values.indexOf(maximum),
    finalValue: values.at(-1), returnPct: (prices.at(-1).close / prices[0].close - 1) * 100};
}

export function frameState(series, seconds, duration, holdSeconds) {
  const hold = Math.min(Math.max(holdSeconds, 0), duration / 2);
  const motionDuration = duration - hold;
  const progress = Math.min(1, Math.max(0, seconds / motionDuration));
  const start = series.prices[0].timestamp;
  const end = series.prices.at(-1).timestamp;
  const cursor = start + progress * (end - start);
  let lo = 0, hi = series.prices.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (series.prices[mid].timestamp <= cursor + 0.01) lo = mid;
    else hi = mid - 1;
  }
  const index = lo;
  const leftTime = Math.max(start, cursor - series.windowDays * DAY_MS);
  const rightTime = Math.max(start + DAY_MS, cursor);
  let firstIndex = 0;
  while (firstIndex < index && series.prices[firstIndex + 1].timestamp < leftTime) firstIndex += 1;
  return {index, firstIndex, cursor, leftTime, rightTime,
    timestamp: series.prices[index].timestamp, close: series.prices[index].close,
    value: series.values[index], returnPct: (series.prices[index].close / series.prices[0].close - 1) * 100,
    top: series.tops[index], summaryOpacity: Math.min(1, Math.max(0, (seconds - motionDuration) / 0.8)),
    complete: progress === 1};
}
