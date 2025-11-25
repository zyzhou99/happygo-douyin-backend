// db.js
// 轻量持久化（JSON 文件）——先跑通；后续把这里换成 RDS/MySQL 即可。
// 仅用 Node 内置模块，无第三方依赖。
const fs = require('fs/promises');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');

// 内存镜像，进程内加速访问（进程重启会从文件恢复）
let mem = {
  orders: {},        // key: out_order_no  -> { out_order_no, douyin_order_id, status, amount_fen, product_id, user_id, created_at, updated_at }
  callbacks: [],     // 回调原始记录：[{ out_order_no, douyin_order_id, event_type, payload, ts, processed }]
  idempotency: {}    // 幂等键：{ idem_key: ts }
};

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function load() {
  try {
    await ensureDir();
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    mem = JSON.parse(raw);
  } catch (_) {
    // 文件不存在或损坏则重置
    await save();
  }
}

async function save() {
  await ensureDir();
  const tmp = JSON.stringify(mem, null, 2);
  await fs.writeFile(DATA_FILE, tmp, 'utf8');
}

// ---- 公开的最小接口：先跑通支付/核销回调 ----
async function init() {
  await load();
}

async function useIdempotency(idemKey) {
  // 返回 true 表示“已经用过”（重复）；false 表示首次并已记录
  if (!idemKey) return false;
  if (mem.idempotency[idemKey]) return true;
  mem.idempotency[idemKey] = Date.now();
  await save();
  return false;
}

async function saveCallback({ out_order_no, douyin_order_id, event_type, payload }) {
  mem.callbacks.push({
    out_order_no,
    douyin_order_id: douyin_order_id || null,
    event_type: event_type || 'pay_success',
    payload: payload || {},
    ts: Date.now(),
    processed: 0
  });
  await save();
}

async function upsertOrder(basic) {
  const now = new Date().toISOString();
  const k = basic.out_order_no;
  if (!k) return;

  if (!mem.orders[k]) {
    mem.orders[k] = {
      out_order_no: k,
      status: 'PENDING',
      created_at: now,
      updated_at: now,
      amount_fen: basic.amount_fen || 0,
      product_id: basic.product_id || null,
      user_id: basic.user_id || null,
      douyin_order_id: basic.douyin_order_id || null
    };
  } else {
    // 合并基础信息
    mem.orders[k] = {
      ...mem.orders[k],
      ...basic,
      updated_at: now
    };
  }
  await save();
}

async function markOrderPaid(out_order_no, douyin_order_id) {
  const now = new Date().toISOString();
  if (!mem.orders[out_order_no]) {
    // 若业务单不存在，先建一条再置 PAID（保证“先支付回调后下单插入”的场景不丢单）
    mem.orders[out_order_no] = {
      out_order_no,
      status: 'PAID',
      created_at: now,
      updated_at: now,
      amount_fen: 0,
      product_id: null,
      user_id: null,
      douyin_order_id: douyin_order_id || null
    };
  } else {
    mem.orders[out_order_no].status = 'PAID';
    mem.orders[out_order_no].douyin_order_id = douyin_order_id || mem.orders[out_order_no].douyin_order_id || null;
    mem.orders[out_order_no].updated_at = now;
  }
  // 将最近一条对应回调标记 processed=1（容错，不强依赖）
  for (let i = mem.callbacks.length - 1; i >= 0; i--) {
    const c = mem.callbacks[i];
    if (c.out_order_no === out_order_no && !c.processed) {
      c.processed = 1;
      break;
    }
  }
  await save();
}

async function listCallbacks(limit = 50) {
  return mem.callbacks.slice(-limit);
}

async function getOrder(out_order_no) {
  return mem.orders[out_order_no] || null;
}

module.exports = {
  init,
  useIdempotency,
  saveCallback,
  upsertOrder,
  markOrderPaid,
  listCallbacks,
  getOrder
};
