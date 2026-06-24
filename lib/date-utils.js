// ============ 北京时间工具函数（共享） ============
// 由 ai-daily.js / society-daily.js / tools/apply-chronicle-entry.js 复用，
// 消除三处复制粘贴的时区逻辑，避免签名漂移。
//
// 优先级：
//   1. 环境变量 BJ_DATE（CI 注入，最权威，跨时区 runner 也正确）
//   2. 回退：用 Intl 以 Asia/Shanghai 解析当前 Date，与机器本地时区无关
//      （修正原来手动 +8h 在非 UTC 机器上偏移错误的问题）

function beijingNow() {
  if (process.env.BJ_DATE) {
    const [y, m, d] = process.env.BJ_DATE.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  }

  // 回退：任意时区机器都用 Intl 取 Asia/Shanghai 的年月日，
  // 构造一个代表「北京时间当天正午（UTC 视角）」的 Date，
  // 下游统一用 getUTC* 取值即可得到正确的北京日期。
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const y = Number(parts.find((p) => p.type === 'year').value);
  const m = Number(parts.find((p) => p.type === 'month').value);
  const d = Number(parts.find((p) => p.type === 'day').value);

  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

function getBeijingDateParts(d = beijingNow()) {
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

function beijingDateISO(d = beijingNow()) {
  const p = getBeijingDateParts(d);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function beijingDateCN(d = beijingNow()) {
  const p = getBeijingDateParts(d);
  return `${p.year}年${p.month}月${p.day}日`;
}

module.exports = {
  beijingNow,
  getBeijingDateParts,
  beijingDateISO,
  beijingDateCN,
};
