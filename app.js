// app.js (replace everything with this)
const express = require('express');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const db = require('./db');

const APPID = process.env.DOUYIN_APPID;
const SECRET = process.env.DOUYIN_SECRET;
const ACCOUNT_ID = process.env.DOUYIN_ACCOUNT_ID; // 服务商应用常用
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
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

// —— 把商品节点拍平，给前端更好用 —— //
function mapProduct (item) {
  const p = item?.product || {};
  // 1) image_list
  let cover = Array.isArray(p.image_list) && p.image_list.length > 0
    ? p.image_list[0]?.url
    : null;

  // 2) dishes_image_list in product root (some goods put pics here)
  if (!cover && Array.isArray(p.dishes_image_list) && p.dishes_image_list.length > 0) {
    // 有的接口是对象数组，有的接口是 JSON 字符串数组，尽量兜底
    const first = p.dishes_image_list[0];
    cover = typeof first === 'string' ? first : first?.url || null;
  }

  // 3) attr_key_value_map.dishes_image_list (经常是字符串化的 JSON)
  if (!cover && p.attr_key_value_map && p.attr_key_value_map.dishes_image_list) {
    try {
      const arr = JSON.parse(p.attr_key_value_map.dishes_image_list);
      if (Array.isArray(arr) && arr.length > 0) {
        const first = arr[0];
        cover = typeof first === 'string' ? first : first?.url || null;
      }
    } catch (e) { /* ignore */ }
  }

  // 4) 兜底：environment_image_list
  if (!cover && Array.isArray(p.environment_image_list) && p.environment_image_list.length > 0) {
    const first = p.environment_image_list[0];
    cover = typeof first === 'string' ? first : first?.url || null;
  }

  // return the flattened contract
  const poiIds = Array.isArray(p.pois) ? p.pois.map(x => x.poi_id).filter(Boolean) : [];
  return {
    id: p.product_id || null,
    title: p.product_name || '',
    cover, // ✅ now robust
    status: item?.online_status ?? null,
    categoryName: p.category_full_name || '',
    soldStartAt: p.sold_start_time || null,
    soldEndAt: p.sold_end_time || null,
    poiIds,
    bizLine: item?.biz_line ?? null,
    updateTime: p.update_time || null
  };
}

// —— 健康检查 —— //
app.get('/healthz', (req, res) => res.status(200).send('ok'));

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
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ ok:0, message:'missing code' });

  // 1) 用小程序 code 换 openid/unionid/session_key
  // 注意：抖音有对应换取接口（等价于微信的 jscode2session）
  // 伪代码：
  // const r = await axios.get('https://open.douyin.com/.../jscode2session', { params:{ appid, secret, code }})
  // const { openid, unionid } = r.data;

  const openid = 'mock-openid-for-dev'; // 先本地联调可打桩，后续接真接口
  // 2) 查/建本地用户，颁发你自己的 JWT
  // const user = await upsertUserByOpenid(openid)
  const token = signJwt({ openid }); // 你项目里的 JWT 方法

  res.json({ ok:1, token, openid });
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

app.get('/api/shows', async (req, res) => {
  try {
    const page = req.query.page || 1;
    const size = req.query.size || 20;
    const keyword = (req.query.keyword || '').trim();
    const data = await fetchOnlineList({ page, size, keyword });
    handleListResponse(res, data, page, size);
  } catch (err) {
    const detail = err?.response?.data || err.message;
    console.error('❌ /api/shows 失败：', detail);
    res.status(500).json({ ok: false, code: 'INTERNAL', message: '拉取商品失败', detail });
  }
});

// —— 详情：/api/shows/:id —— //
app.get('/api/shows/:id', async (req, res) => {
  try {
    const token = await getClientToken();
    const id = req.params.id;
    const url = `${OPEN_BASE}/goodlife/v1/goods/product/online/get/`;

    // 尝试两种参数风格（不同账号/文档版本可能差异）
    const mkParams = (key) => {
      const p = { [key]: id };
      if (ACCOUNT_ID) p.account_id = ACCOUNT_ID;
      return p;
    };

    let { data } = await axios.get(url, {
      headers: { 'access-token': token, 'Content-Type': 'application/json' },
      params: mkParams('product_id'),
      timeout: 15000
    });

    const okA = (data?.data?.error_code === 0) || (data?.err_no === 0);
    if (!okA) {
      const resp2 = await axios.get(url, {
        headers: { 'access-token': token, 'Content-Type': 'application/json' },
        params: mkParams('product_ids'), // 有的接口用数组参数名
        timeout: 15000
      });
      data = resp2.data;
    }

    const ok = (data?.data?.error_code === 0) || (data?.err_no === 0);
    if (!ok) {
      return res.status(502).json({
        ok: false,
        code: data?.data?.error_code ?? data?.err_no ?? 'UPSTREAM_ERROR',
        message: data?.data?.description ?? data?.err_msg ?? 'upstream error',
        raw: data
      });
    }

    const productNode =
      data?.data?.product ||
      (Array.isArray(data?.data?.products) ? data.data.products[0] : null);

    if (!productNode) return res.json({ ok: true, data: null });
    return res.json({ ok: true, data: mapProduct(productNode) });
  } catch (err) {
    const detail = err?.response?.data || err.message;
    console.error('❌ /api/shows/:id 失败：', detail);
    res.status(500).json({ ok: false, code: 'INTERNAL', message: '获取商品详情失败', detail });
  }
});

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
