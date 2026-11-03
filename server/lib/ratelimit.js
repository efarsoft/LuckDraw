'use strict';

/** 极简内存滑动窗口限流（单实例足够；活动场景无需分布式） */
function createRateLimiter(max, windowMs) {
  const hits = new Map(); // ip -> [timestamps]
  // 周期清理，防内存膨胀
  const cleaner = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, arr] of hits) {
      while (arr.length && arr[0] < cutoff) arr.shift();
      if (arr.length === 0) hits.delete(ip);
    }
  }, Math.min(windowMs, 60_000));
  cleaner.unref?.();

  return function rateLimit(req, res, next) {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
    const now = Date.now();
    const cutoff = now - windowMs;
    let arr = hits.get(ip);
    if (!arr) {
      arr = [];
      hits.set(ip, arr);
    }
    while (arr.length && arr[0] < cutoff) arr.shift();
    if (arr.length >= max) {
      return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    }
    arr.push(now);
    next();
  };
}

module.exports = { createRateLimiter };
