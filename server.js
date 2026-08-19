'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const nodemailer = require('nodemailer');
const { WebSocketServer } = require('ws');
const { Q, newToken, PUBLIC_ROOM_NAME, initDB, dbGet } = require('./db');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const WORLD_LIMIT = 2000000;        // 坐标上限（正负）：1格=0.0001°，世界地图边界 ±1800000，允许海面外涂鸦到 ±2000000
const MAX_ROOMS_PER_USER = 5;

// ---------- 邮箱验证（QQ 邮箱发信） ----------
// 默认使用用户提供的 QQ 邮箱与授权码；生产环境请通过 .env 覆盖 EMAIL_USER / EMAIL_PASS
const EMAIL_USER = process.env.EMAIL_USER || '2056242081@qq.com';
const EMAIL_PASS = process.env.EMAIL_PASS || 'cqkjqcrupkuzfdfa';
const mailer = nodemailer.createTransport({
  host: 'smtp.qq.com',
  port: 465,
  secure: true,
  auth: { user: EMAIL_USER, pass: EMAIL_PASS },
});
// 邮箱验证码：email -> { code, expiresAt, lastSentAt }
const emailCodes = new Map();
const CODE_TTL_MS = 10 * 60 * 1000;      // 验证码 10 分钟有效
const CODE_RESEND_MS = 60 * 1000;        // 同一邮箱 60 秒内不能重发
function genCode() { return String(crypto.randomInt(100000, 1000000)); }
function validEmail(e) { return typeof e === 'string' && /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(e.trim()); }
async function sendCodeMail(to, code) {
  await mailer.sendMail({
    from: `PixelVerse <${EMAIL_USER}>`,
    to,
    subject: 'PixelVerse 注册验证码',
    html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;border:1px solid #eee;border-radius:8px">
      <h2 style="margin:0 0 12px">PixelVerse 像素画布</h2>
      <p>您的注册验证码为：</p>
      <p style="font-size:28px;font-weight:bold;letter-spacing:6px;color:#3b82f6">${code}</p>
      <p style="color:#888;font-size:13px">验证码 10 分钟内有效，请勿泄露给他人。</p>
    </div>`,
  });
}

// 落子令牌桶：允许连续拖拽作画的突发量，同时限制刷屏。
// 容量 2000 覆盖「一次性画完全部点数（最高 Lv.9 上限 300）+ 快速擦除」的场景，
// 避免高等级用户一次画完时被误判为操作频繁；补充 600/秒 满足前端发送速率（约 178 条/秒）。
const BUCKET_CAP = 2000;
const BUCKET_REFILL_PER_SEC = 600;

// 等级配置：累计涂鸦达 need 升到该级，点数上限 limit，升级赠送 coins 涂鸦币
const LEVELS = [
  { level: 1, need: 0,    limit: 60,  coins: 0 },
  { level: 2, need: 50,   limit: 75,  coins: 100 },
  { level: 3, need: 100,  limit: 95,  coins: 120 },
  { level: 4, need: 300,  limit: 120, coins: 140 },
  { level: 5, need: 600,  limit: 150, coins: 160 },
  { level: 6, need: 1200, limit: 185, coins: 180 },
  { level: 7, need: 2400, limit: 215, coins: 200 },
  { level: 8, need: 4800, limit: 260, coins: 220 },
  { level: 9, need: 8000, limit: 300, coins: 240 },
];
const MAX_LEVEL = LEVELS[LEVELS.length - 1].level;
// 根据累计涂鸦次数计算应处等级
function levelFor(total) {
  let lv = LEVELS[0];
  for (const L of LEVELS) if (total >= L.need) lv = L;
  return lv;
}

const app = express();
app.use(express.json({ limit: '128kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------- 工具 ----------------
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function ok(res, data) { res.json({ ok: true, ...data }); }
function fail(res, code, message) { res.status(code).json({ ok: false, message }); }

function isToday(d) {
  if (!d) return false;
  const t = new Date(d);
  const n = new Date();
  return t.getFullYear() === n.getFullYear() && t.getMonth() === n.getMonth() && t.getDate() === n.getDate();
}

function safeUser(u) {
  return {
    id: u.id, username: u.username, points: u.points, pointLimit: u.point_limit,
    tempPoints: u.temp_points || 0, roomCards: u.room_cards || 0,
    isAdmin: !!u.is_admin, level: u.level || 1, coins: u.coins || 0,
    totalPlaced: u.total_placed || 0, checkedToday: isToday(u.last_checkin),
  };
}

function getBearer(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return (req.query.token || '').toString().trim();
}

async function resolveSession(token, kind) {
  if (!token) return null;
  try {
    const s = await Q.findSession(token);
    if (!s) return null;
    if (kind && s.kind !== kind) return null;
    const u = await Q.findUserById(s.user_id);
    if (!u) return null;
    return u;
  } catch { return null; }
}

async function authUser(req, res, next) {
  const u = await resolveSession(getBearer(req), 'user');
  if (!u) return fail(res, 401, '未登录或登录已失效');
  if (u.banned) return fail(res, 403, '账号已被封禁');
  req.user = u;
  next();
}

async function authAdmin(req, res, next) {
  const u = await resolveSession(getBearer(req), 'admin');
  if (!u || !u.is_admin) return fail(res, 401, '管理员未登录或登录已失效');
  req.admin = u;
  next();
}

function validName(name) {
  return typeof name === 'string' && /^[\w\u4e00-\u9fa5.-]{2,20}$/.test(name.trim());
}

// ---------------- 用户接口 ----------------
// 发送邮箱注册验证码（60 秒限发一次）
app.post('/api/send-code', async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  if (!validEmail(email)) return fail(res, 400, '邮箱格式不正确');
  const evr = await Q.getSetting('email_verify_required');
  if (evr?.value === '0') return fail(res, 400, '当前无需邮箱验证');
  if (await Q.findUserByEmail(email)) return fail(res, 409, '该邮箱已被注册');
  const rec = emailCodes.get(email);
  const now = Date.now();
  if (rec && now - rec.lastSentAt < CODE_RESEND_MS) {
    return fail(res, 429, `发送过于频繁，请 ${Math.ceil((CODE_RESEND_MS - (now - rec.lastSentAt)) / 1000)} 秒后再试`);
  }
  const code = genCode();
  try {
    await sendCodeMail(email, code);
  } catch (e) {
    console.error('[mail] 发送失败:', e.message);
    return fail(res, 500, '验证码发送失败，请检查邮箱配置或稍后再试');
  }
  emailCodes.set(email, { code, expiresAt: now + CODE_TTL_MS, lastSentAt: now });
  ok(res, { message: '验证码已发送，请查收邮箱' });
});

app.post('/api/register', async (req, res) => {
  const username = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '');
  if (!validName(username)) return fail(res, 400, '用户名需 2-20 位，仅支持中英文/数字/下划线');
  if (password.length < 4 || password.length > 32) return fail(res, 400, '密码长度需 4-32 位');
  if (await Q.findUserByName(username)) return fail(res, 409, '用户名已被占用');

  // 邮箱验证（后台开关控制，默认开启）
  const evr = await Q.getSetting('email_verify_required');
  let email = String(req.body?.email ?? '').trim().toLowerCase();
  if (evr?.value !== '0') {
    const code = String(req.body?.code ?? '').trim();
    if (!validEmail(email)) return fail(res, 400, '请填写正确的邮箱');
    if (await Q.findUserByEmail(email)) return fail(res, 409, '该邮箱已被注册');
    const rec = emailCodes.get(email);
    if (!rec || rec.code !== code || Date.now() > rec.expiresAt) {
      return fail(res, 400, '验证码错误或已过期');
    }
    emailCodes.delete(email);
  } else {
    email = '';   // 开关关闭：不要求邮箱
  }

  const info = await Q.createUser(username, password, email);
  const user = await Q.findUserById(info.lastInsertRowid);
  const token = newToken();
  await Q.createSession(token, user.id, 'user');
  ok(res, { token, user: safeUser(user) });
});

app.post('/api/login', async (req, res) => {
  const username = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '');
  const user = await Q.findUserByName(username);
  if (!user || user.password !== password) return fail(res, 401, '用户名或密码错误');
  if (user.banned) return fail(res, 403, '该账号已被封禁');

  const token = newToken();
  await Q.createSession(token, user.id, 'user');
  await Q.touchUser(user.id);
  ok(res, { token, user: safeUser(user) });
});

app.post('/api/logout', authUser, async (req, res) => {
  await Q.deleteSession(getBearer(req));
  ok(res, {});
});

app.get('/api/me', authUser, (req, res) => ok(res, { user: safeUser(req.user) }));

// 签到：每天一次，随机赠送 20-50 涂鸦币 + 20-30 涂鸦点
app.post('/api/checkin', authUser, async (req, res) => {
  const u = req.user;
  const n = new Date();
  if (u.last_checkin) {
    const t = new Date(u.last_checkin);
    if (t.getFullYear() === n.getFullYear() && t.getMonth() === n.getMonth() && t.getDate() === n.getDate()) {
      return fail(res, 400, '今日已签到，明天再来吧');
    }
  }
  const coinBonus = 20 + Math.floor(Math.random() * 31);   // 20~50
  const tempBonus = 20 + Math.floor(Math.random() * 11);  // 20~30 临时涂鸦点
  const today = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
  await Q.checkin(u.id, today, coinBonus, tempBonus);
  const nu = await Q.findUserById(u.id);
  ok(res, {
    coins: coinBonus, tempPoints: tempBonus,
    totalCoins: nu.coins, pointsNow: nu.points, limit: nu.point_limit,
    tempPointsNow: nu.temp_points || 0,
  });
});

// 排行榜：涂鸦累计前 10 名
app.get('/api/leaderboard', async (req, res) => {
  const list = await Q.leaderboard(10);
  ok(res, { list });
});

// ---------------- 预输入作画模式（先预览后上传） ----------------
// 预览放置：原子扣 1 点 + 累计涂鸦 +1 + 升级判定；不落 pixels、不写日志、不广播。
// 正式上传走 /api/commit-preview（不再重复扣点）。
app.post('/api/preview-place', authUser, async (req, res) => {
  const roomId = req.body?.roomId != null ? Number(req.body.roomId) : null;
  const room = roomId != null ? await Q.findRoomById(roomId) : await Q.publicRoom();
  if (!room) return fail(res, 404, '房间不存在');
  const x = Math.trunc(Number(req.body?.x));
  const y = Math.trunc(Number(req.body?.y));
  const color = String(req.body?.color ?? '');
  if (!Number.isFinite(x) || !Number.isFinite(y)) return fail(res, 400, '坐标无效');
  if (Math.abs(x) > WORLD_LIMIT || Math.abs(y) > WORLD_LIMIT) return fail(res, 400, '超出画布范围');
  if (!HEX_RE.test(color)) return fail(res, 400, '颜色无效');

  // 免点房间不扣点；否则优先扣正式涂鸦点，正式点不足再扣临时涂鸦点
  if (!room.free_drawing) {
    let spent = await Q.spendPoint(req.user.id);
    if (spent.changes === 0) {
      spent = await Q.spendTempPoint(req.user.id);
      if (spent.changes === 0) return fail(res, 400, '作画点数不足，请等待恢复');
    }
  }

  // 累计涂鸦 + 升级判定（与正式 place 一致）
  const up = await Q.addPlaced(req.user.id);
  const nlv = levelFor(up.total_placed);
  let levelUp = null;
  if (nlv.level > up.level) {
    const bonusSum = LEVELS
      .filter((L) => L.level > up.level && L.level <= nlv.level)
      .reduce((s, L) => s + L.coins, 0);
    const tempBonus = 30 + Math.floor(Math.random() * 21);   // 30~50 临时涂鸦点
    const r = await Q.upgrade(req.user.id, nlv.level, nlv.limit, bonusSum, tempBonus);
    if (r.changes > 0) {
      const fresh = await Q.findUserById(req.user.id);
      levelUp = { level: nlv.level, limit: nlv.limit, bonus: bonusSum, tempBonus, coins: fresh.coins };
      up.level = nlv.level; up.coins = fresh.coins; up.point_limit = nlv.limit;
      up.temp_points = fresh.temp_points;   // 响应里的临时点需含升级奖励
    }
  }
  ok(res, {
    points: up.points, limit: up.point_limit, tempPoints: up.temp_points || 0,
    level: up.level || 1, coins: up.coins || 0, totalPlaced: up.total_placed || 0,
    levelUp,
  });
});

// 预览恢复：擦除/放弃时恢复点数（不超过上限），count 条一次
app.post('/api/preview-restore', authUser, async (req, res) => {
  let count = Math.trunc(Number(req.body?.count));
  if (!Number.isFinite(count) || count < 1) return fail(res, 400, '数量无效');
  count = Math.min(count, 5000);
  await Q.restorePoints(count, req.user.id);
  const u = await Q.findUserById(req.user.id);
  ok(res, { points: u.points, limit: u.point_limit });
});

// ---------------- 商店（涂鸦币兑换） ----------------
// 兑换永久点数上限：1 币 = 1 点（原子扣币 + 加上限 + 记流水）
app.post('/api/shop/buy-limit', authUser, async (req, res) => {
  let n = Math.trunc(Number(req.body?.amount));
  if (!Number.isFinite(n) || n < 1) return fail(res, 400, '兑换数量需为不小于 1 的整数');
  n = Math.min(n, 500);
  const user = await Q.findUserById(req.user.id);
  if (!user) return fail(res, 404, '用户不存在');
  if ((user.coins || 0) < n) return fail(res, 400, '涂鸦币不足');
  const spent = await Q.spendCoins(n, user.id);
  if (spent.changes === 0) return fail(res, 400, '涂鸦币不足');
  await Q.addPointLimit(n, user.id);
  await Q.insertShopLog(user.id, 'limit', n, n);
  const nu = await Q.findUserById(user.id);
  ok(res, { user: safeUser(nu), message: `点数上限已提升 ${n} 点，当前上限 ${nu.point_limit}` });
});

// 兑换临时涂鸦点：1 币 = 10 点（与正式点分开计数，优先消耗）
app.post('/api/shop/buy-temp', authUser, async (req, res) => {
  let n = Math.trunc(Number(req.body?.points));
  if (!Number.isFinite(n) || n < 10 || n % 10 !== 0) return fail(res, 400, '临时点数需为 10 的倍数（至少 10）');
  n = Math.min(n, 2000);
  const cost = n / 10;
  const user = await Q.findUserById(req.user.id);
  if (!user) return fail(res, 404, '用户不存在');
  if ((user.coins || 0) < cost) return fail(res, 400, '涂鸦币不足');
  const spent = await Q.spendCoins(cost, user.id);
  if (spent.changes === 0) return fail(res, 400, '涂鸦币不足');
  await Q.addTempPoints(n, user.id);
  await Q.insertShopLog(user.id, 'temp', cost, n);
  const nu = await Q.findUserById(user.id);
  ok(res, { user: safeUser(nu), message: `已兑换 ${n} 临时涂鸦点，花费 ${cost} 涂鸦币` });
});

// 兑换开房卡：1000 币 = 1 张（创建房间消耗 1 张）
app.post('/api/shop/buy-card', authUser, async (req, res) => {
  let n = Math.trunc(Number(req.body?.cards));
  if (!Number.isFinite(n) || n < 1) return fail(res, 400, '兑换数量需为不小于 1 的整数');
  n = Math.min(n, 50);
  const cost = n * 1000;
  const user = await Q.findUserById(req.user.id);
  if (!user) return fail(res, 404, '用户不存在');
  if ((user.coins || 0) < cost) return fail(res, 400, `涂鸦币不足，兑换 ${n} 张开房卡需要 ${cost} 币`);
  const spent = await Q.spendCoins(cost, user.id);
  if (spent.changes === 0) return fail(res, 400, '涂鸦币不足');
  await Q.addRoomCards(n, user.id);
  await Q.insertShopLog(user.id, 'card', cost, n);
  const nu = await Q.findUserById(user.id);
  ok(res, { user: safeUser(nu), message: `已兑换 ${n} 张开房卡，花费 ${cost} 涂鸦币` });
});

// 预览上传：批量落库 + 画迹日志 + 广播；不重复扣点/累计（预览时已处理）
app.post('/api/commit-preview', authUser, async (req, res) => {
  const roomId = req.body?.roomId != null ? Number(req.body.roomId) : null;
  const room = roomId != null ? await Q.findRoomById(roomId) : await Q.publicRoom();
  if (!room) return fail(res, 404, '房间不存在');
  const ops = Array.isArray(req.body?.ops) ? req.body.ops : [];
  if (!ops.length) return fail(res, 400, '没有可上传的操作');
  if (ops.length > 5000) return fail(res, 400, '单次最多上传 5000 格');
  let done = 0;
  for (const o of ops) {
    const x = Math.trunc(Number(o?.x));
    const y = Math.trunc(Number(o?.y));
    const color = String(o?.color ?? '');
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (Math.abs(x) > WORLD_LIMIT || Math.abs(y) > WORLD_LIMIT) continue;
    if (!HEX_RE.test(color)) continue;
    await Q.upsertPixel(room.id, x, y, color, req.user.id);
    await Q.insertPixelLog(req.user.id, room.id, x, y, color, 'place');
    broadcast(room.id, { type: 'pixel', x, y, color, by: req.user.username });
    done++;
  }
  ok(res, { count: done });
});

// ---------------- 房间接口 ----------------
app.get('/api/rooms', async (req, res) => {
  const rooms = (await Q.listRoomsPublicView()).map((r) => ({
    id: r.id,
    name: r.name,
    isPublic: !!r.is_public,
    hasPassword: !!r.has_password,
    owner: r.owner,
    pixelCount: r.pixel_count,
    online: (roomClients.get(r.id)?.size) || 0,
    createdAt: r.created_at,
  }));
  ok(res, { rooms });
});

app.post('/api/rooms', authUser, async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  const password = String(req.body?.password ?? '');
  if (!validName(name)) return fail(res, 400, '房间名需 2-20 位，仅支持中英文/数字/下划线');
  if (password.length > 32) return fail(res, 400, '房间密码最长 32 位');
  if (await Q.findRoomByName(name)) return fail(res, 409, '房间名已存在');
  const cnt = await Q.countUserRooms(req.user.id);
  if (cnt.c >= MAX_ROOMS_PER_USER) {
    return fail(res, 429, `每个账号最多创建 ${MAX_ROOMS_PER_USER} 个房间`);
  }
  // 创建房间消耗 1 张开房卡（原子扣，失败表示卡不足）
  const card = await Q.spendRoomCard(req.user.id);
  if (card.changes === 0) {
    return fail(res, 402, '创建房间需要 1 张开房卡（商店 1000 涂鸦币兑换 1 张）');
  }
  const info = await Q.createRoom(name, password, req.user.id);
  const room = await Q.findRoomById(info.lastInsertRowid);
  ok(res, {
    room: { id: room.id, name: room.name, isPublic: false, hasPassword: password !== '' },
    user: safeUser(await Q.findUserById(req.user.id)),
  });
});

// 房主自定义房间玩法：免点涂鸦 / 自定义点数恢复间隔
app.put('/api/rooms/:id/settings', authUser, async (req, res) => {
  const room = await Q.findRoomById(Number(req.params.id));
  if (!room) return fail(res, 404, '房间不存在');
  if (room.is_public) return fail(res, 403, '公共房间不可设置玩法');
  if (room.owner_id !== req.user.id && !req.user.is_admin) return fail(res, 403, '只有房主可以设置房间玩法');
  const freeDrawing = !!req.body?.freeDrawing;
  let regen = req.body?.pointRegenSeconds;
  if (regen !== undefined && regen !== null && regen !== '') {
    regen = Math.trunc(Number(regen));
    if (!Number.isFinite(regen) || regen < 1 || regen > 86400) return fail(res, 400, '恢复间隔需为 1-86400 秒');
  } else {
    regen = null; // 跟随全局
  }
  await Q.updateRoomSettings(room.id, freeDrawing, regen);
  const updated = await Q.findRoomById(room.id);
  // 同步房间级状态：ws 缓存 + 自定义恢复登记 + 通知房间内玩家
  syncCustomRoom(updated);
  const set = roomClients.get(room.id);
  if (set) {
    for (const c of set) {
      c.roomFree = !!updated.free_drawing;
      c.roomRegen = updated.point_regen_seconds == null ? null : updated.point_regen_seconds;
    }
    broadcast(room.id, {
      type: 'room_settings',
      room: {
        id: updated.id, freeDrawing: !!updated.free_drawing,
        pointRegenSeconds: updated.point_regen_seconds == null ? null : updated.point_regen_seconds,
      },
    });
  }
  ok(res, {
    room: {
      id: updated.id, name: updated.name, isPublic: false,
      freeDrawing: !!updated.free_drawing,
      pointRegenSeconds: updated.point_regen_seconds == null ? null : updated.point_regen_seconds,
    },
  });
});

// 管理员后台：设置房间玩法（免点涂鸦 / 自定义恢复间隔）
app.post('/api/admin/rooms/:id/settings', authAdmin, async (req, res) => {
  const room = await Q.findRoomById(Number(req.params.id));
  if (!room) return fail(res, 404, '房间不存在');
  const freeDrawing = !!req.body?.freeDrawing;
  let regen = req.body?.pointRegenSeconds;
  if (regen !== undefined && regen !== null && regen !== '') {
    regen = Math.trunc(Number(regen));
    if (!Number.isFinite(regen) || regen < 1 || regen > 86400) return fail(res, 400, '恢复间隔需为 1-86400 秒');
  } else {
    regen = null;
  }
  await Q.updateRoomSettings(room.id, freeDrawing, regen);
  const updated = await Q.findRoomById(room.id);
  syncCustomRoom(updated);
  const set = roomClients.get(room.id);
  if (set) {
    for (const c of set) {
      c.roomFree = !!updated.free_drawing;
      c.roomRegen = updated.point_regen_seconds == null ? null : updated.point_regen_seconds;
    }
    broadcast(room.id, {
      type: 'room_settings',
      room: {
        id: updated.id, freeDrawing: !!updated.free_drawing,
        pointRegenSeconds: updated.point_regen_seconds == null ? null : updated.point_regen_seconds,
      },
    });
  }
  ok(res, {
    room: {
      id: updated.id, name: updated.name, isPublic: false,
      freeDrawing: !!updated.free_drawing,
      pointRegenSeconds: updated.point_regen_seconds == null ? null : updated.point_regen_seconds,
    },
  });
});

// 房主删除自己的房间
app.delete('/api/rooms/:id', authUser, async (req, res) => {
  const room = await Q.findRoomById(Number(req.params.id));
  if (!room) return fail(res, 404, '房间不存在');
  if (room.is_public) return fail(res, 403, '公共房间不可删除');
  if (room.owner_id !== req.user.id) return fail(res, 403, '只有房主可以删除该房间');
  await Q.deleteRoom(room.id);
  kickRoom(room.id, '房间已被房主删除');
  ok(res, {});
});

// ---------------- 管理员接口 ----------------
app.post('/api/admin/login', async (req, res) => {
  const username = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '');
  const user = await Q.findUserByName(username);
  if (!user || !user.is_admin || user.password !== password) {
    return fail(res, 401, '管理员账号或密码错误');
  }
  const token = newToken();
  await Q.createSession(token, user.id, 'admin');
  ok(res, { token, admin: { id: user.id, username: user.username } });
});

app.get('/api/admin/stats', authAdmin, async (req, res) => {
  const users = (await dbGet('SELECT COUNT(*) AS c FROM users')).c;
  const banned = (await dbGet('SELECT COUNT(*) AS c FROM users WHERE banned = 1')).c;
  const rooms = (await dbGet('SELECT COUNT(*) AS c FROM rooms')).c;
  const pixels = (await dbGet('SELECT COUNT(*) AS c FROM pixels')).c;
  let online = 0;
  for (const set of roomClients.values()) online += set.size;
  ok(res, { stats: { users, banned, rooms, pixels, online } });
});

app.get('/api/admin/users', authAdmin, async (req, res) => {
  const users = (await Q.listUsers()).map((u) => ({
    id: u.id,
    username: u.username,
    password: u.password,          // 需求：后台可查看玩家密码
    email: u.email || '',
    points: u.points,
    pointLimit: u.point_limit,
    level: u.level || 1,
    totalPlaced: u.total_placed || 0,
    coins: u.coins || 0,
    banned: !!u.banned,
    isAdmin: !!u.is_admin,
    ownedRooms: u.owned_rooms,
    createdAt: u.created_at,
    lastSeen: u.last_seen,
    online: onlineUserIds().has(u.id),
  }));
  ok(res, { users });
});

// 后台查看/修改用户详情（账号、密码、邮箱）
app.put('/api/admin/users/:id', authAdmin, async (req, res) => {
  const user = await Q.findUserById(Number(req.params.id));
  if (!user) return fail(res, 404, '用户不存在');
  const patch = {};
  if (req.body?.username !== undefined) {
    const name = String(req.body.username).trim();
    if (!validName(name)) return fail(res, 400, '账号需 2-20 位，仅支持中英文/数字/下划线');
    if (name !== user.username && await Q.findUserByName(name)) return fail(res, 409, '账号已被占用');
    patch.username = name;
  }
  if (req.body?.password !== undefined) {
    const pwd = String(req.body.password);
    if (pwd.length < 4 || pwd.length > 32) return fail(res, 400, '密码长度需 4-32 位');
    patch.password = pwd;
  }
  if (req.body?.email !== undefined) {
    const email = String(req.body.email).trim().toLowerCase();
    if (email && !validEmail(email)) return fail(res, 400, '邮箱格式不正确');
    if (email && email !== user.email && await Q.findUserByEmail(email)) return fail(res, 409, '邮箱已被占用');
    patch.email = email;
  }
  if (Object.keys(patch).length === 0) return fail(res, 400, '没有可修改的字段');
  await Q.updateUser(user.id, patch);
  const nu = await Q.findUserById(user.id);
  ok(res, {
    user: {
      id: nu.id, username: nu.username, email: nu.email || '',
      password: nu.password, points: nu.points, pointLimit: nu.point_limit,
    },
  });
});

app.post('/api/admin/users/:id/ban', authAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const banned = req.body?.banned ? 1 : 0;
  const user = await Q.findUserById(id);
  if (!user) return fail(res, 404, '用户不存在');
  if (user.is_admin) return fail(res, 403, '不能封禁管理员账号');
  await Q.setBanned(banned, id);
  if (banned) {
    await Q.deleteUserSessions(id);
    kickUser(id, '账号已被管理员封禁');
  }
  ok(res, { banned: !!banned });
});

app.post('/api/admin/users/:id/reset-points', authAdmin, async (req, res) => {
  const user = await Q.findUserById(Number(req.params.id));
  if (!user) return fail(res, 404, '用户不存在');
  await Q.resetPoints(user.id);
  ok(res, {});
});

app.delete('/api/admin/users/:id', authAdmin, async (req, res) => {
  const user = await Q.findUserById(Number(req.params.id));
  if (!user) return fail(res, 404, '用户不存在');
  if (user.is_admin) return fail(res, 403, '不能删除管理员账号');
  await Q.deleteUserSessions(user.id);
  kickUser(user.id, '账号已被管理员删除');
  await Q.deleteUser(user.id);
  ok(res, {});
});

app.get('/api/admin/rooms', authAdmin, async (req, res) => {
  const rooms = (await Q.listRoomsAdminView()).map((r) => ({
    id: r.id,
    name: r.name,
    password: r.password,          // 需求：后台可查看房间密码
    isPublic: !!r.is_public,
    owner: r.owner,
    pixelCount: r.pixel_count,
    online: (roomClients.get(r.id)?.size) || 0,
    createdAt: r.created_at,
    freeDrawing: !!r.free_drawing,
    pointRegenSeconds: r.point_regen_seconds == null ? null : r.point_regen_seconds,
  }));
  ok(res, { rooms });
});

app.post('/api/admin/rooms/:id/password', authAdmin, async (req, res) => {
  const room = await Q.findRoomById(Number(req.params.id));
  if (!room) return fail(res, 404, '房间不存在');
  const password = String(req.body?.password ?? '');
  if (password.length > 32) return fail(res, 400, '房间密码最长 32 位');
  await Q.updateRoomPassword(password, room.id);
  ok(res, {});
});

app.post('/api/admin/rooms/:id/clear', authAdmin, async (req, res) => {
  const room = await Q.findRoomById(Number(req.params.id));
  if (!room) return fail(res, 404, '房间不存在');
  await Q.clearRoom(room.id);
  broadcast(room.id, { type: 'cleared' });
  ok(res, {});
});

app.delete('/api/admin/rooms/:id', authAdmin, async (req, res) => {
  const room = await Q.findRoomById(Number(req.params.id));
  if (!room) return fail(res, 404, '房间不存在');
  if (room.is_public) return fail(res, 403, '公共房间不可删除，可使用「清空画布」');
  await Q.deleteRoom(room.id);
  kickRoom(room.id, '房间已被管理员删除');
  ok(res, {});
});

// ---------------- 管理员：全局设置与点数 ----------------
app.get('/api/admin/settings', authAdmin, async (req, res) => {
  const secs = Number((await Q.getSetting('point_regen_seconds'))?.value || 30);
  const evr = (await Q.getSetting('email_verify_required'))?.value !== '0';
  ok(res, { pointRegenSeconds: secs, emailVerifyRequired: evr });
});

app.post('/api/admin/settings', authAdmin, async (req, res) => {
  const out = {};
  if (req.body?.pointRegenSeconds !== undefined) {
    const secs = Math.trunc(Number(req.body.pointRegenSeconds));
    if (!Number.isFinite(secs) || secs < 1 || secs > 86400) return fail(res, 400, '恢复间隔需为 1-86400 秒');
    await Q.setSetting('point_regen_seconds', String(secs));
    out.pointRegenSeconds = secs;
  }
  if (req.body?.emailVerifyRequired !== undefined) {
    await Q.setSetting('email_verify_required', req.body.emailVerifyRequired ? '1' : '0');
    out.emailVerifyRequired = !!req.body.emailVerifyRequired;
  }
  if (!Object.keys(out).length) return fail(res, 400, '没有可修改的设置');
  ok(res, out);
});

app.post('/api/admin/users/:id/points', authAdmin, async (req, res) => {
  const user = await Q.findUserById(Number(req.params.id));
  if (!user) return fail(res, 404, '用户不存在');
  let v = Math.trunc(Number(req.body?.points));
  if (!Number.isFinite(v)) return fail(res, 400, '点数无效');
  v = Math.max(0, Math.min(user.point_limit, v));
  await Q.setPoints(v, user.id);
  ok(res, { points: v, pointLimit: user.point_limit });
});

// 后台设置玩家涂鸦币
app.post('/api/admin/users/:id/coins', authAdmin, async (req, res) => {
  const user = await Q.findUserById(Number(req.params.id));
  if (!user) return fail(res, 404, '用户不存在');
  let v = Math.trunc(Number(req.body?.coins));
  if (!Number.isFinite(v) || v < 0) return fail(res, 400, '涂鸦币无效');
  await Q.setCoins(v, user.id);
  ok(res, { coins: v });
});

// 单个用户的画迹（溯源用，按时间倒序分页）
app.get('/api/admin/users/:id/logs', authAdmin, async (req, res) => {
  const userId = Number(req.params.id);
  const user = await Q.findUserById(userId);
  if (!user) return fail(res, 404, '用户不存在');
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const logs = await Q.listUserLogs(userId, limit, offset);
  const { c } = await Q.countUserLogs(userId);
  ok(res, { username: user.username, logs, total: c });
});

// 全局画迹总览（支持按用户/房间筛选）
app.get('/api/admin/logs', authAdmin, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const userId = Number(req.query.userId) || null;
  const roomId = Number(req.query.roomId) || null;
  const where = [];
  const params = [];
  if (userId) { where.push('l.user_id = ?'); params.push(userId); }
  if (roomId) { where.push('l.room_id = ?'); params.push(roomId); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const logs = await Q.listLogsAdminView(whereSql, params, limit, offset);
  const rows = await Q.countLogsAdminView(whereSql, params);
  ok(res, { logs, total: rows[0].c });
});

// 商店流水（后台，分页）：用户 id、花费涂鸦币、兑换类型与数量
app.get('/api/admin/shop-logs', authAdmin, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const logs = await Q.listShopLogs(limit, offset);
  const { c } = await Q.countShopLogs();
  ok(res, { logs, total: c });
});

// ---------------- WebSocket ----------------
const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: '/ws',
  // 大房间像素消息压缩（>1KB 才压缩，避免小消息开销）
  perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 6 } },
});

/** roomId -> Set<ws> */
const roomClients = new Map();

function onlineUserIds() {
  const ids = new Set();
  for (const set of roomClients.values()) {
    for (const c of set) if (c.userId) ids.add(c.userId);
  }
  return ids;
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(roomId, obj, exceptWs) {
  const set = roomClients.get(roomId);
  if (!set) return;
  const raw = JSON.stringify(obj);
  for (const c of set) {
    if (c !== exceptWs && c.readyState === c.OPEN) c.send(raw);
  }
}

function roomPresence(roomId) {
  const set = roomClients.get(roomId);
  if (!set) return;
  const names = [];
  for (const c of set) if (c.username) names.push(c.username);
  broadcast(roomId, { type: 'presence', count: set.size, users: names.slice(0, 50) });
}

/** roomId -> 恢复间隔秒数（仅含自定义了恢复间隔的房间）；roomId -> 上次恢复时间 */
const customRooms = new Map();
const roomLastRegen = new Map();

function syncCustomRoom(room) {
  if (room.point_regen_seconds != null) {
    customRooms.set(room.id, room.point_regen_seconds);
    if (!roomLastRegen.has(room.id)) roomLastRegen.set(room.id, Date.now());
  } else {
    customRooms.delete(room.id);
    roomLastRegen.delete(room.id);
  }
}

function leaveRoom(ws) {
  if (ws.roomId == null) return;
  const set = roomClients.get(ws.roomId);
  if (set) {
    set.delete(ws);
    if (set.size === 0) {
      roomClients.delete(ws.roomId);
      if (customRooms.has(ws.roomId)) customRooms.delete(ws.roomId);
      roomLastRegen.delete(ws.roomId);
    }
  }
  const rid = ws.roomId;
  ws.roomId = null;
  roomPresence(rid);
}

function kickRoom(roomId, reason) {
  const set = roomClients.get(roomId);
  if (!set) return;
  for (const c of [...set]) {
    send(c, { type: 'kicked', reason });
    leaveRoom(c);
  }
}

function kickUser(userId, reason) {
  for (const set of [...roomClients.values()]) {
    for (const c of [...set]) {
      if (c.userId === userId) {
        send(c, { type: 'kicked', reason, banned: true });
        leaveRoom(c);
      }
    }
  }
}

wss.on('connection', (ws) => {
  ws.userId = null;
  ws.username = null;
  ws.roomId = null;
  ws.tokens = BUCKET_CAP;
  ws.tokenAt = Date.now();
  ws.lastPointsAt = 0;
  ws.lastRateWarn = 0;
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'auth': {
        const token = String(msg.token || '');
        // 游客：无 token 允许以游客身份连接观看（不可涂鸦）
        if (!token) {
          ws.userId = null;
          ws.username = null;
          ws.guest = true;
          send(ws, { type: 'auth_ok', user: null, guest: true });
          break;
        }
        const user = await resolveSession(token, 'user');
        if (!user) return send(ws, { type: 'auth_fail', message: '登录已失效，请重新登录' });
        if (user.banned) return send(ws, { type: 'auth_fail', message: '账号已被封禁' });
        ws.userId = user.id;
        ws.username = user.username;
        ws.guest = false;
        send(ws, { type: 'auth_ok', user: safeUser(user) });
        break;
      }

      case 'join': {
        // 游客允许加入房间观看
        const user = ws.userId ? await Q.findUserById(ws.userId) : null;
        if (user && user.banned) {
          return send(ws, { type: 'kicked', reason: '账号已被封禁', banned: true });
        }

        const room = msg.roomId != null ? await Q.findRoomById(Number(msg.roomId)) : await Q.publicRoom();
        if (!room) return send(ws, { type: 'error', message: '房间不存在或已被删除' });
        const isOwner = ws.userId != null && room.owner_id === ws.userId;
        if (!room.is_public && room.password !== '' && !isOwner && String(msg.password ?? '') !== room.password) {
          return send(ws, { type: 'join_denied', roomId: room.id, message: '房间密码错误' });
        }

        leaveRoom(ws);
        ws.roomId = room.id;
        ws.roomFree = !!room.free_drawing;
        ws.roomRegen = room.point_regen_seconds == null ? null : room.point_regen_seconds;
        syncCustomRoom(room);
        if (!roomClients.has(room.id)) roomClients.set(room.id, new Set());
        roomClients.get(room.id).add(ws);

        // 分块发送房间像素：先发房间信息让 UI 立即就绪，再按 (x,y) 游标分批推送，
        // 避免大房间一次性全量查询 + 巨型消息阻塞（内存/序列化/网络/前端解析）。
        const pixelTotal = (await Q.countPixels(room.id)).c || 0;
        send(ws, {
          type: 'joined',
          pixels: [],   // 兼容旧版客户端（其不再从本字段初始化画布；新版走 pixels_chunk）
          room: {
            id: room.id,
            name: room.name,
            isPublic: !!room.is_public,
            hasPassword: room.password !== '',
            isOwner: ws.userId != null && room.owner_id === ws.userId,
            freeDrawing: !!room.free_drawing,
            pointRegenSeconds: room.point_regen_seconds == null ? null : room.point_regen_seconds,
          },
          pixelTotal,
          user: user ? safeUser(user) : null,
        });
        const CHUNK = 3000;
        let lastX = null, lastY = null;
        while (true) {
          const chunk = await Q.pixelsChunk(room.id, lastX, lastY, CHUNK);
          if (!chunk.length) break;
          send(ws, { type: 'pixels_chunk', chunk });
          if (chunk.length < CHUNK) break;
          lastX = chunk[chunk.length - 1].x;
          lastY = chunk[chunk.length - 1].y;
        }
        send(ws, { type: 'pixels_done', total: pixelTotal });
        roomPresence(room.id);
        break;
      }

      case 'place': {
        if (!ws.userId || ws.roomId == null) return;
        const now = Date.now();
        const user = await Q.findUserById(ws.userId);
        if (!user || user.banned) {
          return send(ws, { type: 'kicked', reason: '账号已被封禁', banned: true });
        }
        const x = Math.trunc(Number(msg.x));
        const y = Math.trunc(Number(msg.y));
        const erase = msg.erase === true;
        const color = String(msg.color ?? '');
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        if (Math.abs(x) > WORLD_LIMIT || Math.abs(y) > WORLD_LIMIT) {
          return send(ws, { type: 'error', message: '超出画布范围' });
        }
        if (!erase && !HEX_RE.test(color)) return;

        if (!(await Q.findRoomById(ws.roomId))) {
          return send(ws, { type: 'kicked', reason: '房间已不存在' });
        }

        // 点数额度：仅「作画」消耗，擦除不消耗。免点房间（freeDrawing）不扣任何点数；
        // 其余房间优先消耗正式涂鸦点，正式点不足再扣临时涂鸦点（原子扣减，失败则拒绝并回滚乐观更新）
        if (!erase && !ws.roomFree) {
          let spent = await Q.spendPoint(ws.userId);
          if (spent.changes === 0) spent = await Q.spendTempPoint(ws.userId);
          if (spent.changes === 0) {
            const real = await Q.getPixel(ws.roomId, x, y);
            send(ws, { type: 'pixel', x, y, color: real ? real.color : null });
            if (now - ws.lastRateWarn > 3000) {
              ws.lastRateWarn = now;
              send(ws, { type: 'error', message: '作画点数不足，请等待恢复' });
            }
            return;
          }
        }

        // 令牌桶限流；超限时回传服务端真实状态，让客户端回滚乐观更新
        ws.tokens = Math.min(BUCKET_CAP,
          ws.tokens + (now - ws.tokenAt) / 1000 * BUCKET_REFILL_PER_SEC);
        ws.tokenAt = now;
        if (ws.tokens < 1) {
          const real = await Q.getPixel(ws.roomId, x, y);
          send(ws, { type: 'pixel', x, y, color: real ? real.color : null });
          if (now - ws.lastRateWarn > 3000) {
            ws.lastRateWarn = now;
            send(ws, { type: 'error', message: '操作过于频繁，请稍缓' });
          }
          return;
        }
        ws.tokens -= 1;

        if (erase) {
          const old = await Q.getPixel(ws.roomId, x, y);
          await Q.deletePixel(ws.roomId, x, y);
          await Q.insertPixelLog(ws.userId, ws.roomId, x, y, old ? old.color : '', 'erase');
          broadcast(ws.roomId, { type: 'pixel', x, y, color: null, by: ws.username });
        } else {
          await Q.upsertPixel(ws.roomId, x, y, color, ws.userId);
          await Q.insertPixelLog(ws.userId, ws.roomId, x, y, color, 'place');
          broadcast(ws.roomId, { type: 'pixel', x, y, color, by: ws.username });

          // 累计涂鸦 + 等级判定（逐格累计，跨阈值即升级并赠送涂鸦币 + 临时涂鸦点）
          const up = await Q.addPlaced(ws.userId);
          const nlv = levelFor(up.total_placed);
          if (nlv.level > up.level) {
            // 合并 up.level+1 .. nlv.level 各级奖励（覆盖并发跨级，避免漏发）
            const bonusSum = LEVELS
              .filter((L) => L.level > up.level && L.level <= nlv.level)
              .reduce((s, L) => s + L.coins, 0);
            const tempBonus = 30 + Math.floor(Math.random() * 21);   // 30~50 临时涂鸦点
            const r = await Q.upgrade(ws.userId, nlv.level, nlv.limit, bonusSum, tempBonus);
            if (r.changes > 0) {   // 只有真正升级的那一次发消息（原子判定，杜绝重复）
              const fresh = await Q.findUserById(ws.userId);
              send(ws, {
                type: 'level_up', level: nlv.level, limit: nlv.limit,
                coins: fresh.coins, bonus: bonusSum, tempBonus, total: up.total_placed,
              });
              up.level = nlv.level; up.coins = fresh.coins; up.point_limit = nlv.limit;
              up.temp_points = fresh.temp_points;   // 后续 points 推送需含升级奖励
            }
          }
          // 点数/等级合并推送，避免每格一条消息
          if (now - ws.lastPointsAt > 300) {
            ws.lastPointsAt = now;
            send(ws, {
              type: 'points', points: up.points, limit: up.point_limit,
              tempPoints: up.temp_points || 0,
              level: up.level || 1, coins: up.coins || 0, totalPlaced: up.total_placed || 0,
            });
          }
        }
        break;
      }

      case 'chat': {
        if (!ws.userId || ws.roomId == null) return;
        const text = String(msg.text ?? '').slice(0, 200).trim();
        if (!text) return;
        broadcast(ws.roomId, {
          type: 'chat', from: ws.username, text, at: Date.now(),
        });
        break;
      }

      case 'leave':
        leaveRoom(ws);
        break;

      case 'ping':
        send(ws, { type: 'pong' });
        break;
    }
  });

  ws.on('close', async () => {
    if (ws.userId) await Q.touchUser(ws.userId);
    leaveRoom(ws);
  });

  ws.on('error', () => leaveRoom(ws));
});

// 心跳：清理僵尸连接
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

// 点数额度恢复：每秒检查。全局按 settings 间隔恢复未达上限用户；
// 自定义了恢复间隔的房间按各自间隔恢复房间内在线用户（这些用户跳过全局恢复，避免双重恢复）。
let lastRegen = Date.now();
async function regenLoop() {
  setTimeout(async () => {
    try {
      // ---- 全局恢复 ----
      const row = await Q.getSetting('point_regen_seconds');
      const secs = Number(row?.value || 30);
      if (Date.now() - lastRegen >= Math.max(1, secs) * 1000) {
        lastRegen = Date.now();
        const excluded = new Set();
        for (const rid of customRooms.keys()) {
          const set = roomClients.get(rid);
          if (set) for (const c of set) if (c.userId) excluded.add(c.userId);
        }
        await Q.regenPoints(excluded);
        for (const set of roomClients.values()) {
          for (const c of set) {
            if (c.userId && !excluded.has(c.userId)) {
              const u = await Q.findUserById(c.userId);
              if (u) send(c, { type: 'points', points: u.points, limit: u.point_limit });
            }
          }
        }
      }
      // ---- 房间自定义恢复 ----
      for (const [rid, secs] of customRooms) {
        const last = roomLastRegen.get(rid) || Date.now();
        if (Date.now() - last >= Math.max(1, secs) * 1000) {
          roomLastRegen.set(rid, Date.now());
          const set = roomClients.get(rid);
          if (set) {
            for (const c of set) {
              if (!c.userId) continue;
              await Q.restoreOnePoint(c.userId);
              const u = await Q.findUserById(c.userId);
              if (u) send(c, { type: 'points', points: u.points, limit: u.point_limit });
            }
          }
        }
      }
    } catch { /* ignore */ }
    regenLoop();
  }, 1000);
}
regenLoop();

// ---------------- 启动（等待数据库就绪）----------------
initDB()
  .then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`[pixel-canvas] 服务已启动: http://${HOST}:${PORT}`);
      console.log(`[pixel-canvas] 管理后台:   http://localhost:${PORT}/admin.html`);
      console.log(`[pixel-canvas] 默认公共房间: ${PUBLIC_ROOM_NAME}`);
    });
  })
  .catch((err) => {
    console.error('[pixel-canvas] 数据库初始化失败，服务未启动：', err);
    process.exit(1);
  });

process.on('SIGINT', () => { console.log('\n[pixel-canvas] 正在关闭...'); server.close(() => process.exit(0)); });
