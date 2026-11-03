'use strict';
const crypto = require('crypto');
const config = require('../config');

/** 领奖凭证码：由 winner id + 密钥派生的稳定短码，供领奖台人工核对（防抄错为主，非加密用途） */
function claimCode(winnerId) {
  const mac = crypto.createHmac('sha256', config.COOKIE_SECRET).update('claim' + winnerId).digest('hex');
  return 'LD' + String(winnerId).toString(36).toUpperCase().padStart(3, '0') + mac.slice(0, 2).toUpperCase();
}

module.exports = { claimCode };
