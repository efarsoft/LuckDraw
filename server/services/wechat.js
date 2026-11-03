'use strict';
const crypto = require('crypto');
const config = require('../config');

// ---- Mock 身份生成 ----
const SURNAMES = '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦许何吕施张孔曹严金魏陶姜谢邹柏水窦章云苏潘葛范彭郎鲁韦昌马苗凤花俞袁柳唐罗薛雷贺倪汤滕殷黎乔谭';
const GIVEN = ['伟芳娜秀英敏静丽强磊军洋勇艳杰娟涛明超霞平刚桂荣华梅鑫欣怡晨宇浩然子轩雨萱梦琪思远嘉懿天佑文昊',];

function randomMockName() {
  const s = SURNAMES[crypto.randomInt(SURNAMES.length)];
  const g = GIVEN[0];
  const len = crypto.randomInt(2) + 1;
  let name = s;
  for (let i = 0; i < len; i++) name += g[crypto.randomInt(g.length)];
  return name;
}

/** 微信服务号网页授权适配层：Mock / 真实双实现，.env 一键切换 */
module.exports = {
  isMock() {
    return config.USE_MOCK || !config.WECHAT_APP_ID || !config.WECHAT_APP_SECRET;
  },
  randomMockName,

  /** 真实模式：跳转微信授权页（snsapi_userinfo 可取昵称头像） */
  authorizeUrl(redirectUri, stateVal) {
    return (
      `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${config.WECHAT_APP_ID}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=snsapi_userinfo` +
      `&state=${encodeURIComponent(stateVal)}#wechat_redirect`
    );
  },

  /**
   * code 换取用户信息 → { openid, nickname, avatarUrl }
   * Mock 模式直接生成随机身份（开发/彩排/断网兜底演示用）
   */
  async exchangeUser(code) {
    if (this.isMock()) {
      const n = crypto.randomBytes(6).toString('hex');
      return { openid: `mock_${n}`, nickname: randomMockName(), avatarUrl: null };
    }
    const tokenResp = await fetch(
      `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${config.WECHAT_APP_ID}` +
        `&secret=${config.WECHAT_APP_SECRET}&code=${encodeURIComponent(code)}&grant_type=authorization_code`
    );
    const token = await tokenResp.json();
    if (token.errcode) {
      const err = new Error(`微信授权失败(${token.errcode}): ${token.errmsg || ''}`);
      err.status = 502;
      throw err;
    }
    const infoResp = await fetch(
      `https://api.weixin.qq.com/sns/userinfo?access_token=${token.access_token}` +
        `&openid=${token.openid}&lang=zh_CN`
    );
    const info = await infoResp.json();
    if (info.errcode) {
      const err = new Error(`获取用户信息失败(${info.errcode}): ${info.errmsg || ''}`);
      err.status = 502;
      throw err;
    }
    return {
      openid: info.openid,
      nickname: decodeNickname(info.nickname) || '微信用户',
      avatarUrl: info.headimgurl || null,
    };
  },
};

/** 修复微信 userinfo 昵称的编码问题（历史 mojibake：latin1 误读的 UTF-8） */
function decodeNickname(nickname) {
  if (typeof nickname !== 'string') return nickname;
  try {
    const buf = Buffer.from(nickname, 'latin1');
    const re = buf.toString('utf8');
    // 重新解码后若不再含替换符且含 CJK，则认为修复成功
    if (!re.includes('\uFFFD') && /[\u4e00-\u9fa5]/.test(re)) return re;
  } catch {
    /* ignore */
  }
  return nickname.includes('\uFFFD') ? nickname.replace(/\uFFFD/g, '') : nickname;
}
