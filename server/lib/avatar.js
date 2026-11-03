'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

const AVATAR_DIR = path.join(config.DATA_DIR, 'avatars');

const PALETTE = [
  ['#c0392b', '#f1c40f'], ['#8e44ad', '#f39c12'], ['#16a085', '#f1c40f'],
  ['#d35400', '#ffeaa7'], ['#b71540', '#fdcb6e'], ['#0b486b', '#f9ca24'],
  ['#ae2015', '#ffd60a'], ['#6a040f', '#e0a458'], ['#9d0208', '#faa307'],
  ['#7f1d1d', '#fbbf24'],
];

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

/** 生成首字母头像 SVG（无网络依赖，Mock/兜底用） */
function generateInitialAvatar(nickname) {
  const ch = (nickname || '客').trim().charAt(0) || '客';
  const [c1, c2] = PALETTE[crypto.randomInt(PALETTE.length)];
  const rnd = crypto.randomBytes(4).toString('hex');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="132" height="132" viewBox="0 0 132 132">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>` +
    `<rect width="132" height="132" rx="16" fill="url(#g)"/>` +
    `<text x="66" y="66" font-size="64" text-anchor="middle" dominant-baseline="central" fill="#fff" ` +
    `font-family="'Microsoft YaHei','PingFang SC',sans-serif" font-weight="bold">${escapeXml(ch)}</text></svg>`;
  const file = `a${Date.now()}_${rnd}.svg`;
  fs.writeFileSync(path.join(AVATAR_DIR, file), svg);
  return file;
}

/** 下载远程头像（微信 CDN），失败返回 null（调用方落回 SVG 头像） */
async function downloadAvatar(url, key) {
  if (!url || !/^https?:\/\//.test(url)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return null;
    const type = resp.headers.get('content-type') || '';
    if (!type.startsWith('image/')) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length === 0 || buf.length > 2 * 1024 * 1024) return null;
    const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
    const file = `u${key}_${Date.now().toString(36)}.${ext}`;
    fs.writeFileSync(path.join(AVATAR_DIR, file), buf);
    return file;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 读取头像文件内容（同步端点用）；防路径穿越 */
function readAvatarFile(file) {
  if (!/^[\w.-]+$/.test(file)) return null;
  const p = path.join(AVATAR_DIR, file);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p);
}

module.exports = { AVATAR_DIR, generateInitialAvatar, downloadAvatar, readAvatarFile };
