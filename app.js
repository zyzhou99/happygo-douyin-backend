const fs = require('fs');
const path = require('path');
const forge = require('node-forge');
const showConfig = require('./data/show-config.json'); 

const crypto = require('crypto');
const { getMockSessions } = require('./mock-sessions');
// app.js (replace everything with this)
const express = require('express');
const axios = require('axios');
require('dotenv').config();

const db = require('./db');

const APPID = process.env.DOUYIN_APPID;
const SECRET = process.env.DOUYIN_SECRET;
const ACCOUNT_ID = process.env.DOUYIN_ACCOUNT_ID; // 服务商应用常用
const MINI_APPID = process.env.DOUYIN_MINI_APPID;
const MINI_SECRET = process.env.DOUYIN_MINI_SECRET;
const MINI_APP_PRIVATE_KEY = process.env.DOUYIN_MINIAPP_APP_PRIVATE_KEY
  ? process.env.DOUYIN_MINIAPP_APP_PRIVATE_KEY.replace(/\\n/g, '\n')
  : null;

if (!MINI_APPID || !MINI_SECRET) {
  console.warn('⚠️ 未配置 DOUYIN_MINIAPP_APPID / DOUYIN_MINIAPP_SECRET，小程序登录/手机号接口将不可用');
}
if (!MINI_APP_PRIVATE_KEY) {
  console.warn('⚠️ 未配置 DOUYIN_MINIAPP_APP_PRIVATE_KEY，将无法解密手机号');
}
const PORT = process.env.PORT || process.env.BYTEFAAS_HTTP_PORT || 8000;
const HOST = '0.0.0.0';
const OPEN_BASE = 'https://open.douyin.com';

if (!APPID || !SECRET) {
  console.error('❌ 请在 .env 配置 DOUYIN_APPID / DOUYIN_SECRET（开放平台“应用”的 client_key/secret）');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '2mb' }));

app.use('/static', express.static(path.join(__dirname, 'public')));
app.get('/api/header', (req, res) => {
  // Build absolute URL based on current host (works for localhost too)
  const base = `${req.protocol}://${req.get('host')}`;
  // Single image example:
  const images = [
    `${base}/static/header.jpg`,   // ← your file in /public
  ];

  // If you want clickable links, return objects like: {src, link}
  res.json({ ok: true, images });
});

// —— client_token 简单缓存 —— //
let tokenCache = { token: null, exp: 0 };
async function getClientToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.exp - 5 * 60 * 1000) {
    return tokenCache.token;
  }
  const url = `${OPEN_BASE}/oauth/client_token/`;
  const body = {
    client_key: APPID,
    client_secret: SECRET,
    grant_type: 'client_credential'
  };
  const { data } = await axios.post(url, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000
  });
  const accessToken = data?.data?.access_token;
  const ttlSec = data?.data?.expires_in || 7200;
  if (!accessToken) throw new Error('获取 client_token 失败：' + JSON.stringify(data));
  tokenCache = { token: accessToken, exp: Date.now() + ttlSec * 1000 };
  return accessToken;
}

let miniTokenCache = { token: null, exp: 0 };

async function getMiniAppAccessToken() {
  const now = Date.now();
  if (miniTokenCache.token && now < miniTokenCache.exp - 5 * 60 * 1000) {
    return miniTokenCache.token;
  }

  if (!MINI_APPID || !MINI_SECRET) {
    throw new Error('未配置小程序 MINI_APPID / MINI_SECRET');
  }

  const url = `${OPEN_BASE}/oauth/client_token/`;
  const body = {
    client_key: MINI_APPID,
    client_secret: MINI_SECRET,
    grant_type: 'client_credential',
  };

  const { data } = await axios.post(url, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000,
  });

  const accessToken = data?.data?.access_token;
  const ttlSec = data?.data?.expires_in || 7200;

  if (!accessToken) {
    throw new Error('获取小程序 client_token 失败：' + JSON.stringify(data));
  }

  miniTokenCache = {
    token: accessToken,
    exp: Date.now() + ttlSec * 1000,
  };

  return accessToken;
}

function normalizeMiniAppPrivateKey(rawKey) {
  if (!rawKey) return null;

  const trimmed = rawKey.trim();

  // 已经是完整 PEM（包含 BEGIN/END），直接返回
  if (trimmed.includes('BEGIN PRIVATE KEY') || trimmed.includes('BEGIN RSA PRIVATE KEY')) {
    return trimmed;
  }

  // 否则认为只是纯 base64，把它包一层头尾
  const wrapped = trimmed.replace(/\s+/g, '');
  const chunks = wrapped.match(/.{1,64}/g) || [wrapped];

  return [
    '-----BEGIN PRIVATE KEY-----',
    ...chunks,
    '-----END PRIVATE KEY-----'
  ].join('\n');
}

// 使用 node-forge 解密抖音手机号密文
function decryptDouyinPhone(cipherText) {
  if (!cipherText) return null;

  if (!MINI_APP_PRIVATE_KEY) {
    throw new Error('未配置 DOUYIN_MINI_APP_PRIVATE_KEY（MINI_APP_PRIVATE_KEY），无法解密手机号');
  }

  try {
    const pem = normalizeMiniAppPrivateKey(MINI_APP_PRIVATE_KEY);

    // 1) 解析私钥
    const privateKey = forge.pki.privateKeyFromPem(pem);

    // 2) base64 解码抖音返回的 data（密文）
    const encryptedBytes = forge.util.decode64(cipherText);

    // 3) 用 RSAES-PKCS1-v1_5 解密（对应文档里「RSA/ECB/PKCS1Padding」）
    const decrypted = privateKey.decrypt(
      encryptedBytes,
      'RSAES-PKCS1-V1_5'
    );

    // 4) 解出的是 JSON 字符串
    console.log('[decryptDouyinPhone] decrypted JSON:', decrypted);

    let parsed;
    try {
      parsed = JSON.parse(decrypted);
    } catch (e) {
      console.error('手机号明文 JSON 解析失败：', decrypted);
      return { raw: decrypted };
    }

    const phoneInfo = parsed.phone_info || parsed;

    const phoneNumber =
      phoneInfo.phoneNumber ||
      phoneInfo.phone ||
      phoneInfo.mobile ||
      null;

    const purePhoneNumber =
      phoneInfo.purePhoneNumber ||
      phoneInfo.pure_phone ||
      phoneNumber ||
      null;

    const countryCode =
      phoneInfo.countryCode ||
      phoneInfo.country_code ||
      '86';

    return {
      phoneNumber,
      purePhoneNumber,
      countryCode,
      raw: parsed, // 方便你调试，上线可以去掉
    };
  } catch (err) {
    console.error('RSA 解密手机号失败（forge）:', err);
    throw err;
  }
}

// —— 把商品节点拍平，给前端更好用 —— //
// —— 把商品节点拍平，给前端更好用 —— //
function mapProduct(item) {
  // item 一般是 online.query 返回的 product_online 里那一条
  const p = item?.product || item || {};

  // 0) 先拿到 attr_key_value_map（各种扩展字段都在这里）
  const attr = p.attr_key_value_map || {};

  // 0.1 解析 description_rich_text -> singerDescription（给“项目介绍/演出介绍”用）
  let singerDescription = '';
  if (attr.description_rich_text) {
    try {
      const arr = JSON.parse(attr.description_rich_text);
      if (Array.isArray(arr)) {
        singerDescription = arr
          .map(seg => (seg && seg.content ? String(seg.content) : ''))
          .filter(Boolean)
          .join('\n\n');   // 多段内容用空行隔开
      }
    } catch (e) {
      console.warn('parse description_rich_text failed:', e?.message || e);
    }
  }

  // 0.2 解析 tickets_rule -> ticketRuleText / ticketRuleRaw（给“购票须知”用）
  let ticketRuleRaw = null;
  let ticketRuleText = '';
  if (attr.tickets_rule) {
    try {
      const ruleObj = JSON.parse(attr.tickets_rule);
      ticketRuleRaw = ruleObj;

      // 这里先取出“取票地点 + 文案”，这个字段本身就是一大段中文说明
      const addr = ruleObj?.ticket_collection_info?.ticket_collection_address;
      if (addr) {
        // 把 \n 转成真换行，前端直接展示会好看一些
        ticketRuleText = String(addr).replace(/\\n/g, '\n');
      }
    } catch (e) {
      console.warn('parse tickets_rule failed:', e?.message || e);
    }
  }

  // 1) 封面兜底
  let cover = Array.isArray(p.image_list) && p.image_list.length > 0
    ? p.image_list[0]?.url
    : null;

  if (!cover && Array.isArray(p.dishes_image_list) && p.dishes_image_list.length > 0) {
    const first = p.dishes_image_list[0];
    cover = typeof first === 'string' ? first : first?.url || null;
  }

  if (!cover && attr.dishes_image_list) {
    try {
      const arr = JSON.parse(attr.dishes_image_list);
      if (Array.isArray(arr) && arr.length > 0) {
        const first = arr[0];
        cover = typeof first === 'string' ? first : first?.url || null;
      }
    } catch (e) { /* ignore */ }
  }

  if (!cover && Array.isArray(p.environment_image_list) && p.environment_image_list.length > 0) {
    const first = p.environment_image_list[0];
    cover = typeof first === 'string' ? first : first?.url || null;
  }

  const poiIds = Array.isArray(p.pois) ? p.pois.map(x => x.poi_id).filter(Boolean) : [];

  // 2) 解析价格：先从 item.extra 这个 JSON 字符串里的 display_price 拿
  let rawHigh = null;
  let rawLow = null;

  const takeDisplayPrice = (src) => {
    if (!src) return;
    const dp = src.display_price || src.displayPrice || {};
    if (dp.high_price != null && rawHigh == null) rawHigh = dp.high_price;
    if (dp.low_price != null && rawLow == null) rawLow = dp.low_price;
  };

  // 2.1 item.extra（有些账号会把 display_price 放在这里）
  if (item && item.extra) {
    try {
      const ext = typeof item.extra === 'string' ? JSON.parse(item.extra) : item.extra;
      takeDisplayPrice(ext);
    } catch (e) { /* ignore */ }
  }

  // 2.2 product.extra（你现在的账号就是这里）
  if (p.extra) {
    try {
      const ext = typeof p.extra === 'string' ? JSON.parse(p.extra) : p.extra;
      takeDisplayPrice(ext);
    } catch (e) { /* ignore */ }
  }

  // 2.3 兜一层 product_ext（有的账号会放在这里）
  if (p.product_ext) {
    takeDisplayPrice(p.product_ext);
  }

  // 2.4 再兜一层 p 自己（极端情况）
  takeDisplayPrice(p);

  // 把“分”转成人民币元（98800 -> 988）
  const normalizeAmount = (v) => {
    if (typeof v !== 'number') return null;
    return Math.round(v / 100);
  };

  const priceHigh = normalizeAmount(rawHigh);
  const priceLow = normalizeAmount(rawLow);

  return {
    id: p.product_id || null,
    title: p.product_name || '',
    cover,
    status: item?.online_status ?? item?.status ?? null,
    categoryName: p.category_full_name || '',
    soldStartAt: p.sold_start_time || null,
    soldEndAt: p.sold_end_time || null,
    poiIds,
    bizLine: item?.biz_line ?? null,
    updateTime: p.update_time || null,
    priceHigh,
    priceLow,

    // ✅ 新增给详情页用的字段：
    singerDescription,   // 来自 description_rich_text
    ticketRuleText,      // 已整理好、可直接展示的中文说明
    ticketRuleRaw,       // 原始结构，后面如果想做更细致的展示可以用
  };
}

/**
 * 从 goodlife/v1/goods/product/online/get 的返回里提取“场次票品”信息
 * 结构会根据你账号的实际数据尽量兜底：
 * [
 *   {
 *     skuId: string|null,
 *     session: '2025-12-31 20:00',
 *     area: 'A区',
 *     price: 92900,          // 原始整数，不做单位换算
 *     remainStock: 7,
 *     totalStock: 7,
 *     raw: {...}             // 调试用，后期可以删掉
 *   },
 *   ...
 * ]
 */
function extractSessionsFromOnline(upstream) {
  // 找到 online.get 里真正商品节点（不同文档版本字段名略有差异）
  const online =
    upstream?.data?.product_onlines?.[0] ||
    upstream?.data?.products?.[0] ||
    upstream?.data?.product ||
    null;

  if (!online) return [];

  const product = online.product || online;

  // 把所有可能的 skus 字段合并兜底
  const skus =
    product.skus ||
    product.sku_list ||
    online.skus ||
    online.sku_list ||
    [];

  if (!Array.isArray(skus)) return [];

  return skus.map((sku) => {
    const stockNode = sku.stock || sku.stock_info || {};
    const priceNode = sku.price_info || {};

    const price =
      sku.actual_amount ??
      priceNode.actual_amount ??
      sku.price ??
      priceNode.price ??
      null;

    const totalStock =
      stockNode.stock_qty ??
      stockNode.total_qty ??
      sku.stock_qty ??
      sku.total_stock ??
      null;

    const remainStock =
      stockNode.avail_qty ??
      stockNode.left_qty ??
      sku.left_stock ??
      sku.remain_stock ??
      null;

    // 场次名称（日期+时间），根据不同字段名兜底
    const sessionLabel =
      sku.session_name ||
      sku.show_time ||
      sku.perform_time ||
      sku.date ||
      sku.valid_date ||
      '';

    // 票档名称（A区/B区…），常见字段名兜底
    const area =
      sku.ticket_area_name ||
      sku.area_name ||
      sku.zone_name ||
      sku.ticket_name ||
      sku.sku_name ||
      '';

    return {
      skuId: sku.sku_id || sku.id || null,
      session: sessionLabel,
      area,
      price,
      remainStock,
      totalStock,
      // 为了方便你调试，对照「场次票品」页面，先把原始 sku 带回去
      raw: sku,
    };
  });
}

// 把单个 sku -> 场次票品结构
function mapSkuToSession(sku) {
  const stock = sku.stock || {};
  const attr = sku.attr_key_value_map || {};

  // 价格：优先用 actual_amount，其次 origin_amount
  const price = sku.actual_amount ?? sku.origin_amount ?? null;
  const originPrice = sku.origin_amount ?? null;

  // 场次（演出日期时间）和票档名：根据常见字段名兜底
  const sessionLabel =
    attr.session ||
    attr.perform_time ||
    attr.show_time ||
    attr.date ||
    ''; // 实在没有就先留空，前端可以直接用 sku_name

  const area =
    attr.area ||
    attr.zone ||
    attr.ticket_area ||
    attr.seat_area ||
    ''; // 同上，具体 key 看你真实数据

  return {
    skuId: sku.sku_id || null,
    name: sku.sku_name || '',      // 完整 sku 名称，比如可能是「2025-12-31 20:00 A区」
    session: sessionLabel,         // 尽量拆出的“演出时间”
    area,                          // 尽量拆出的“票品/区域名称”
    price,                         // 原始整数金额（是否需要 /100 等之后再定）
    originPrice,
    remainStock: stock.avail_qty ?? null,
    totalStock: stock.stock_qty ?? null,
    raw: sku                       // 调试用：你可以在前端 / Postman 里看完整结构
  };
}

async function exchangeCodeForSession(code, anonymousCode) {
  if (!code) {
    throw new Error('missing code');
  }

  // 👉 这里填官方文档里的 “code2session / jscode2session” 接口地址
  const JSCODE2SESSION_URL = 'https://open.douyin.com/api/apps/v2/jscode2session'; // 按官方文档改

  const params = {
    appid: MINI_APPID,          // 或 client_key，看文档要求
    secret: MINI_SECRET,
    code,
    anonymous_code: anonymousCode || '',
    grant_type: 'authorization_code',
  };

  const { data } = await axios.get(JSCODE2SESSION_URL, {
    params,
    timeout: 10000,
  });

  // Douyin 小程序登录接口通常类似：
  // { err_no: 0, err_tips: '', data: { openid, session_key, unionid } }
  if (data.err_no !== 0) {
    throw new Error(data.err_tips || 'code2session failed');
  }

  const info = data.data || {};
  if (!info.openid) {
    throw new Error('no openid in response');
  }

  return info; // { openid, session_key, unionid? }
}

// —— 健康检查 —— //
app.get('/healthz', (req, res) => res.status(200).send('ok'));

async function fetchPriceForProductId(productId) {
  if (!productId) {
    return { priceHigh: null, priceLow: null };
  }

  try {
    const token = await getClientToken();
    const url = `${OPEN_BASE}/goodlife/v1/goods/product/online/get/`;

    const params = {
      product_ids: JSON.stringify([productId]),
    };
    if (ACCOUNT_ID) params.account_id = ACCOUNT_ID;

    const { data } = await axios.get(url, {
      headers: {
        'access-token': token,
        'Content-Type': 'application/json',
      },
      params,
      timeout: 15000,
    });

    const ok =
      (data?.data?.error_code === 0 || typeof data?.data?.error_code === 'undefined') &&
      (data?.err_no === 0 || typeof data?.err_no === 'undefined');

    if (!ok) {
      console.warn('fetchPriceForProductId upstream error', productId, data);
      return { priceHigh: null, priceLow: null };
    }

    // 🔴 关键：直接拿“商品本体” product 这一层
    const productNode =
      data?.data?.product_onlines?.[0]?.product ||
      data?.data?.product ||
      data?.data?.products?.[0]?.product ||
      null;

    if (!productNode || !productNode.extra) {
      console.warn('fetchPriceForProductId: no product.extra for', productId);
      return { priceHigh: null, priceLow: null };
    }

    let ext;
    try {
      ext = typeof productNode.extra === 'string'
        ? JSON.parse(productNode.extra)
        : productNode.extra;
    } catch (e) {
      console.warn('fetchPriceForProductId: parse product.extra failed for', productId, e);
      return { priceHigh: null, priceLow: null };
    }

    // 从 extra.display_price 里拿价格
    const dp = ext.display_price || ext.displayPrice || {};
    const rawHigh =
      typeof dp.high_price === 'number'
        ? dp.high_price
        : typeof dp.highPrice === 'number'
        ? dp.highPrice
        : null;
    const rawLow =
      typeof dp.low_price === 'number'
        ? dp.low_price
        : typeof dp.lowPrice === 'number'
        ? dp.lowPrice
        : null;

    const normalize = (v) => {
      if (typeof v !== 'number') return null;
      // 98800 -> 988（如果发现单位不对再调整）
      return Math.round(v / 100);
    };

    const priceHigh = normalize(rawHigh);
    const priceLow = normalize(rawLow);

    // 调试用，可以先保留一阵子
    console.log('fetchPriceForProductId OK', {
      productId,
      rawHigh,
      rawLow,
      priceHigh,
      priceLow,
    });

    return { priceHigh, priceLow };
  } catch (err) {
    console.error('fetchPriceForProductId error', productId, err?.message || err);
    return { priceHigh: null, priceLow: null };
  }
}

app.get('/api/debug/price/:id', async (req, res) => {
  const productId = req.params.id;
  const info = await fetchPriceForProductId(productId);
  res.json({
    ok: true,
    productId,
    ...info,
  });
});

// —— 拉取某个商品的 SKU 列表（goodlife/v1/goods/sku/get/） —— //
async function fetchSkuListByProductId(productId) {
  const token = await getClientToken();
  const url = `${OPEN_BASE}/goodlife/v1/goods/sku/get/`;

  const params = {
    product_id: productId,
    // 文档里还写了 product_out_id / sku_ids / out_sku_ids
    // 但对于你现在这种“来客后台创建”的商品，我们通常只有 product_id
  };
  if (ACCOUNT_ID) params.account_id = ACCOUNT_ID;

  const { data } = await axios.get(url, {
    headers: {
      'access-token': token,
      'Content-Type': 'application/json'
    },
    params,
    timeout: 15000
  });

  // ⭐ 在这里拿 logid（不同接口有可能字段名略不一样，兜底一下）
  const logid = data?.extra?.logid || data?.log_id || data?.data?.logid || null;
  console.log('[Douyin] sku.get logid =', logid, 'product_id =', productId);

  return data;
}

// —— 列表：你原来用的是 /shows，这里保留；同时加 /api/shows 便于前端切换 —— //
async function fetchOnlineList({ page = 1, size = 20, keyword = '' } = {}) {
  const token = await getClientToken();
  const url = `${OPEN_BASE}/goodlife/v1/goods/product/online/query/`;
  const params = { page, size };
  if (ACCOUNT_ID) params.account_id = ACCOUNT_ID;
  if (keyword) params.keyword = keyword; // 接口支持时生效

  const { data } = await axios.get(url, {
    headers: { 'access-token': token, 'Content-Type': 'application/json' },
    params,
    timeout: 15000
  });
  return data;
}

// 根据 productId，从 online.query 里查一条商品并附带价格
async function fetchSingleProductWithPrice(productId) {
  // 你这边商品不多，直接查第一页 size=50 就够用了
  const data = await fetchOnlineList({ page: 1, size: 50 });

  const ok =
    (data?.data?.error_code === 0 || typeof data?.data?.error_code === 'undefined') &&
    (data?.err_no === 0 || typeof data?.err_no === 'undefined');

  if (!ok) {
    console.warn('fetchSingleProductWithPrice upstream error', productId, data);
    return null;
  }

  const products = data?.data?.products || data?.data?.list || [];
  if (!Array.isArray(products) || products.length === 0) {
    return null;
  }

  // 在列表里找到对应的那一条 product_online
  const item = products.find((it) => {
    const p = it.product || it;
    return String(p.product_id) === String(productId);
  });

  if (!item) {
    // 没找到这条商品
    return null;
  }

  // 先用你现有的 mapProduct 拍平基础字段
  const base = mapProduct(item);

  // 再用我们之前已经验证过的 online.get + extra 方式拿价格
  const priceInfo = await fetchPriceForProductId(base.id);

  if (priceInfo) {
    base.priceHigh = priceInfo.priceHigh;
    base.priceLow = priceInfo.priceLow;
  }

  return base;
}

function handleListResponse(res, data, page, size) {
  const ok = (data?.data?.error_code === 0) || (data?.err_no === 0);
  if (!ok) {
    return res.status(502).json({
      ok: false,
      code: data?.data?.error_code ?? data?.err_no ?? 'UPSTREAM_ERROR',
      message: data?.data?.description ?? data?.err_msg ?? 'upstream error',
      raw: data
    });
  }
  const products = data?.data?.products || data?.data?.list || [];
  const nextCursor = data?.data?.next_cursor ?? null;
  return res.json({
    ok: true,
    page: Number(page),
    size: Number(size),
    nextCursor,
    list: products.map(mapProduct)
  });
}

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { code, userInfo } = req.body || {};

    if (!code) {
      return res.status(400).json({ ok: 0, message: 'missing code' });
    }

    // 1) 先别调抖音，直接用 code 伪造一个 openid
    const openid = 'mock-' + String(code).slice(0, 16);

    // 2) 造一个“假 token”——只是为了前端能有东西存
    const token = 'dev-token-' + openid;

    // 3) 组一个用户信息对象，字段名跟前端 custom-login.js 里用到的保持兼容
    const profile = {
      openid,
      nickName: userInfo?.nickName || '抖音用户',
      avatarUrl: userInfo?.avatarUrl || '',
      gender: userInfo?.gender ?? 0,
      viewer_count: 0,
      order_count: 0,
    };

    // ⭐ 返回结构要兼容 loginWithCode / continueLoginProcess 里解析的格式
    return res.json({
      ok: 1,
      data: {
        token,
        userInfo: profile,
      },
    });
  } catch (e) {
    console.error('/api/auth/login error:', e);
    return res.status(500).json({ ok: 0, message: 'internal error' });
  }
});

// —— 小程序：根据 getPhoneNumber 返回的 code 换手机号 —— //
app.post('/api/verify/decrypt-phone', async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) {
      return res.status(400).json({
        success: false,
        message: '缺少 code（请从 getPhoneNumber 组件 e.detail.code 传过来）',
      });
    }

    const accessToken = await getMiniAppAccessToken();
    const url = 'https://open.douyin.com/api/apps/v1/get_phonenumber_info/';

    const { data } = await axios.post(
      url,
      { code },
      {
        headers: {
          'access-token': accessToken,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );

    // 打印 log_id，方便给客服
    console.log('[get_phonenumber_info] upstream:', JSON.stringify(data));

    const ok = data?.err_no === 0 && typeof data?.data === 'string';
    if (!ok) {
      return res.status(502).json({
        success: false,
        code: data?.err_no ?? 'UPSTREAM_ERROR',
        message:
          data?.err_msg ||
          data?.err_tips ||
          'get_phonenumber_info 调用失败',
        raw: data,
      });
    }

    // data.data 是密文字符串（需要用应用私钥解密）
    const cipherText = data.data;

    let phoneInfo;
    try {
      phoneInfo = decryptDouyinPhone(cipherText);
    } catch (e) {
      console.error('decryptDouyinPhone 调用失败:', e);
      return res.status(500).json({
        success: false,
        message: '手机号解密失败（后端）',
      });
    }

    return res.json({
      success: true,
      data: phoneInfo,
    });
  } catch (err) {
    console.error('[/api/verify/decrypt-phone] error:', err);
    return res.status(500).json({
      success: false,
      message: '服务端获取手机号失败',
    });
  }
});


app.get('/shows', async (req, res) => {
  try {
    const page = req.query.page || 1;
    const size = req.query.size || 20;
    const keyword = (req.query.keyword || '').trim();
    const data = await fetchOnlineList({ page, size, keyword });
    handleListResponse(res, data, page, size);
  } catch (err) {
    const detail = err?.response?.data || err.message;
    console.error('❌ /shows 失败：', detail);
    res.status(500).json({ ok: false, code: 'INTERNAL', message: '拉取商品失败', detail });
  }
});

// —— 列表：/api/shows —— //
app.get('/api/shows', async (req, res) => {
  try {
    const page = req.query.page || 1;
    const size = req.query.size || 20;
    const keyword = (req.query.keyword || '').trim();

    const data = await fetchOnlineList({ page, size, keyword });

    const ok = (data?.data?.error_code === 0) || (data?.err_no === 0);
    if (!ok) {
      return res.status(502).json({
        ok: false,
        code: data?.data?.error_code ?? data?.err_no ?? 'UPSTREAM_ERROR',
        message: data?.data?.description ?? data?.err_msg ?? 'upstream error',
        raw: data
      });
    }

    const products = data?.data?.products || data?.data?.list || [];
    const nextCursor = data?.data?.next_cursor ?? null;

    // ✅ 关键：对每一个商品，单独去调一次 online.get，把价格查出来
    const mappedList = [];
    for (const item of products) {
      const base = mapProduct(item);     // 先拍平基础字段（id/title/cover等）
      const productId = base.id;

      const priceInfo = await fetchPriceForProductId(productId);
      base.priceHigh = priceInfo.priceHigh;
      base.priceLow = priceInfo.priceLow;

      mappedList.push(base);
    }

    return res.json({
      ok: true,
      page: Number(page),
      size: Number(size),
      nextCursor,
      list: mappedList
    });
  } catch (err) {
    const detail = err?.response?.data || err.message;
    console.error('❌ /api/shows 失败：', detail);
    res.status(500).json({
      ok: false,
      code: 'INTERNAL',
      message: '拉取商品失败',
      detail
    });
  }
});

// —— 详情：/api/shows/:id —— //
app.get('/api/shows/:id', async (req, res) => {
  try {
    const productId = req.params.id;

    const product = await fetchSingleProductWithPrice(productId);

    // 和列表接口风格保持一致：ok + data
    return res.json({
      ok: true,
      data: product,   // 找不到就返回 null，前端自己处理
    });
  } catch (err) {
    const detail = err?.response?.data || err.message;
    console.error('❌ /api/shows/:id 失败：', detail);
    res.status(500).json({
      ok: false,
      code: 'INTERNAL',
      message: '获取商品详情失败',
      detail,
    });
  }
});

// 调试：拉商品 online.get 的原始返回
app.get('/api/debug/shows/:id/online', async (req, res) => {
  try {
    const token = await getClientToken();
    const id = req.params.id;
    const url = `${OPEN_BASE}/goodlife/v1/goods/product/online/get/`;

    const params = {
      product_ids: JSON.stringify([id])
    };
    if (ACCOUNT_ID) params.account_id = ACCOUNT_ID;

    const { data } = await axios.get(url, {
      headers: {
        'access-token': token,
        'Content-Type': 'application/json'
      },
      params,
      timeout: 15000
    });

    // 这里不做 mapProduct，直接把 data 丢给你看
    res.json(data);
  } catch (err) {
    const detail = err?.response?.data || err.message;
    console.error('❌ /api/debug/shows/:id/online 失败：', detail);
    res.status(500).json({
      ok: false,
      code: 'INTERNAL',
      message: '调试获取商品线上数据失败',
      detail
    });
  }
});

// —— 场次票品：/api/shows/:id/sessions —— //
app.get('/api/shows/:id/sessions', async (req, res) => {
  try {
    const productId = req.params.id;

    // 1) 调用 批量查询 sku 接口（goodlife/v1/goods/sku/get/）
    const data = await fetchSkuListByProductId(productId);

    // 2) 从返回里取 logid，方便你发给客服
    const logid =
      data?.extra?.logid ||
      data?.log_id ||
      data?.data?.logid ||
      null;

    console.log(
      '[Douyin] /api/shows/:id/sessions upstream logid =',
      logid,
      'product_id =',
      productId
    );

    // 3) 处理 BaseResp 通用错误
    const statusCode = data?.BaseResp?.StatusCode ?? 0;
    if (statusCode && statusCode !== 0) {
      return res.status(502).json({
        ok: false,
        code: statusCode,
        message: data?.BaseResp?.StatusMessage || 'upstream error',
        upstreamLogid: logid,
        raw: data
      });
    }

    // 4) 处理 data.error_code / err_no
    const ok =
      (typeof data?.data?.error_code === 'undefined' || data.data.error_code === 0) &&
      (typeof data?.err_no === 'undefined' || data.err_no === 0);

    if (!ok) {
      return res.status(502).json({
        ok: false,
        code: data?.data?.error_code ?? data?.err_no ?? 'UPSTREAM_ERROR',
        message: data?.data?.description ?? data?.err_msg ?? 'upstream error',
        upstreamLogid: logid,
        raw: data
      });
    }

    // 5) 把 sku 列表映射成“场次票品”
    const skuList = Array.isArray(data?.data?.skus) ? data.data.skus : [];
    const sessions = skuList.map(mapSkuToSession);

    // ⭐ 我这里把 logid 一起返回给你，方便用 curl 直接看到
    return res.json({
      ok: true,
      productId,
      upstreamLogid: logid,
      sessions
    });
  } catch (err) {
    const detail = err?.response?.data || err.message;
    console.error('❌ /api/shows/:id/sessions 失败：', detail);
    res.status(500).json({
      ok: false,
      code: 'INTERNAL',
      message: '获取场次票品失败',
      detail
    });
  }
});



app.get('/api/shows-tickets/:productId', (req, res) => {
  const productId = req.params.productId;

  const products = (showConfig && showConfig.products) ? showConfig.products : [];

  const product = products.find(p => String(p.productId) === String(productId));

  if (!product) {
    console.warn('在配置中未找到对应的 productId：', productId);
    return res.json({
      success: false,
      message: '配置中未找到 productId=' + productId
    });
  }

  console.log('找到的 product：', product);
  console.log('这个 product 的 max-quantity =', product['max-quantity']);

  return res.json({
    success: true,
    data: product
  });
});

// // —— 场次票品（假数据版）：/api/shows/:id/sessions —— //
// app.get('/api/shows/:id/sessions', async (req, res) => {
//   try {
//     const productId = req.params.id;

//     const sessions = getMockSessions(productId);

//     return res.json({
//       ok: true,
//       productId,
//       sessions,
//     });
//   } catch (err) {
//     const detail = err?.response?.data || err.message;
//     console.error('❌ /api/shows/:id/sessions 失败：', detail);
//     res.status(500).json({
//       ok: false,
//       code: 'INTERNAL',
//       message: '获取场次票品失败',
//       detail,
//     });
//   }
// });

// ===========================
// ✅ NEW: 支付/核销回调（最小可用版）
// 抖音来客回调示例字段可能包含：out_order_no / order_id / event_type / notify_id 等
// ===========================
app.post('/api/pay/notify', async (req, res) => {
  try {
    const body = req.body || {};
    // 兼容多种字段名
    const outOrderNo = body.out_order_no || body.out_order_id || body.merchant_order_no;
    const douyinOrderId = body.order_id || body.douyin_order_id;
    const eventType = body.event_type || 'pay_success';
    const notifyId = body.notify_id || `${outOrderNo || 'unknown'}:${eventType}:${body.event_time || Date.now()}`;

    if (!outOrderNo) {
      // 回调里至少要能确定唯一业务单号
      return res.status(400).json({ ok: 0, message: 'missing out_order_no' });
    }

    // 幂等：重复回调直接返回成功（避免多次更新）
    const duplicated = await db.useIdempotency(notifyId);
    if (duplicated) {
      return res.json({ ok: 1, message: 'duplicate' });
    }

    // 原始回调入库（用于排查/对账/重放）
    await db.saveCallback({
      out_order_no: outOrderNo,
      douyin_order_id: douyinOrderId || null,
      event_type: eventType,
      payload: body
    });

    // 业务状态更新：先 upsert（确保订单存在），再置 PAID（或根据 eventType 分支）
    await db.upsertOrder({
      out_order_no: outOrderNo,
      douyin_order_id: douyinOrderId || null,
      status: eventType === 'pay_success' ? 'PAID' : 'PENDING'
    });

    if (eventType === 'pay_success' || eventType === 'verify_success') {
      await db.markOrderPaid(outOrderNo, douyinOrderId || null);
    }

    // 按回调协议返回 200/JSON
    return res.json({ ok: 1 });
  } catch (e) {
    console.error('[/api/pay/notify] error:', e);
    return res.status(500).json({ ok: 0 });
  }
});

// ✅（可选）调试用：查看最近回调
app.get('/api/debug/callbacks', async (req, res) => {
  const list = await db.listCallbacks(100);
  res.json({ ok: 1, list });
});

(async () => {
  try {
    await db.init();
    app.listen(PORT, () => {
      console.log(`✅ 服务已启动：${HOST}:${PORT}`);
      console.log('   健康检查：GET /healthz');
      console.log('   支付回调：POST /api/pay/notify');
      console.log('   回调查看：GET  /api/debug/callbacks');
    });
  } catch (e) {
    console.error('服务启动失败：', e);
    process.exit(1);
  }
})();
