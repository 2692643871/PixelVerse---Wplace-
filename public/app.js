'use strict';

/* =========================================================
 *  PixelVerse 客户端
 *  - 无限画布：世界格坐标(整数, 可负) + 视口偏移/缩放
 *  - 默认拖动模式；点「作画」后点击/拖拽格子上色
 * ======================================================= */

const PALETTE = [
  '#000000', '#4b5563', '#9ca3af', '#ffffff',
  '#ef4444', '#f97316', '#f59e0b', '#facc15',
  '#84cc16', '#22c55e', '#10b981', '#14b8a6',
  '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1',
  '#8b5cf6', '#a855f7', '#d946ef', '#ec4899',
  '#f43f5e', '#7c2d12', '#78350f', '#065f46',
];

const MIN_SCALE = 0.0003; // 允许缩到世界全图（全图 scale ≈ min(w,h)/3600000 ≈ 0.0003）
const MAX_SCALE = 64;     // 支持放大到街道/建筑级（瓦片 zoom 16-18）
const DEFAULT_CENTER = { x: 1163900, y: -43610 };   // 默认中心：经度116.39°E 纬度39.92°N（北京，1格=0.0001°）
const HIDE_PIXELS_ZOOM = 9;  // 缩放级别 ≤ 9（全图/洲/国家/省级）时隐藏像素涂鸦；放大到市级及以上（zoom≥10）显示
const DEFAULT_SCALE = 1.2;   // 默认缩放：城区级（zoom≈14，视野约 12km，一格≈1.2px）

// 等级配置（与服务端一致，仅用于前端展示升级进度）
const LEVELS = [
  { level: 1, need: 0,    limit: 60 },
  { level: 2, need: 50,   limit: 75 },
  { level: 3, need: 100,  limit: 95 },
  { level: 4, need: 300,  limit: 120 },
  { level: 5, need: 600,  limit: 150 },
  { level: 6, need: 1200, limit: 185 },
  { level: 7, need: 2400, limit: 215 },
  { level: 8, need: 4800, limit: 260 },
  { level: 9, need: 8000, limit: 300 },
];

// 示意世界地图背景（public/world.js 提供，瓦片加载失败/未加载时作为占位）
const WORLD = window.WORLD;

/* ---------- 真实地图瓦片背景（高德矢量瓦片，合规图商，无需 key） ---------- */
const TILE_SUBDOMAINS = ['webrd01', 'webrd02', 'webrd03', 'webrd04'];
const TILE_URL = (z, x, y) =>
  'https://' + TILE_SUBDOMAINS[(x + y) % 4] +
  '.is.autonavi.com/appmaptile?style=7&lang=zh_cn&size=1&scale=1&x=' + x + '&y=' + y + '&z=' + z;

const tileCache = new Map();    // "z/x/y" -> { img, ok }
const tilePending = new Map();  // "z/x/y" -> true（防重复请求）
const tileQueue = [];           // 待加载队列
let tileInFlight = 0;
const MAX_TILE_IN_FLIGHT = 12;  // 并发上限，防止瓦片风暴
const MAX_TILE_CACHE = 600;     // 缓存上限

// 根据当前缩放(格像素比 s)选择瓦片层级：让每张瓦片在屏幕上约 256px
function worldZoom(s) {
  return Math.max(0, Math.min(18, Math.round(Math.log2(3600000 * s / 256))));
}

// 计算可见瓦片并触发加载（瓦片与像素格同用 Web Mercator，精确对齐）
function ensureTiles(w, h, s) {
  const z = worldZoom(s);
  const n = 1 << z;
  const span = 3600000 / n;                       // 每张瓦片覆盖的格数
  const ox = view.ox, oy = view.oy;
  const gx0 = (0 - ox) / s, gy0 = (0 - oy) / s;
  const gx1 = (w - ox) / s, gy1 = (h - oy) / s;
  const tx0 = Math.max(0, Math.floor((gx0 + 1800000) / span));
  const tx1 = Math.min(n - 1, Math.floor((gx1 + 1800000) / span));
  const ty0 = Math.max(0, Math.floor((gy0 + 1800000) / span));
  const ty1 = Math.min(n - 1, Math.floor((gy1 + 1800000) / span));
  let need = 0;
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const key = z + '/' + tx + '/' + ty;
      if (tileCache.has(key) || tilePending.has(key)) continue;
      tilePending.set(key, true);
      tileQueue.push({ key, z, tx, ty });
      need++;
    }
  }
  if (need) pumpTiles();
}

function pumpTiles() {
  while (tileInFlight < MAX_TILE_IN_FLIGHT && tileQueue.length) {
    const t = tileQueue.shift();
    if (tileCache.has(t.key)) { tilePending.delete(t.key); continue; }
    tileInFlight++;
    const img = new Image();
    // 仅做 drawImage 显示，无需读取像素，因此不设 crossOrigin（高德瓦片不返回 CORS 头）
    img.onload = () => {
      tileInFlight--;
      tileCache.set(t.key, { img, ok: true });
      tilePending.delete(t.key);
      trimTiles();
      pumpTiles();          // 继续泵送队列（否则剩余瓦片永远无人加载）
      draw();
    };
    img.onerror = () => {
      tileInFlight--;
      tileCache.set(t.key, { img: null, ok: false });
      tilePending.delete(t.key);
      pumpTiles();
      draw();
    };
    img.src = TILE_URL(t.z, t.tx, t.ty);
  }
}

// 缓存超限时优先淘汰最旧层级
function trimTiles() {
  if (tileCache.size <= MAX_TILE_CACHE) return;
  const keys = [...tileCache.keys()];
  for (let i = 0; i < keys.length && tileCache.size > MAX_TILE_CACHE; i++) {
    tileCache.delete(keys[i]);
  }
}

const S = {
  token: localStorage.getItem('pv_token') || '',
  user: null,
  ws: null,
  wsReady: false,
  room: null,                 // {id,name,isPublic,hasPassword,isOwner}
  pixels: new Map(),          // "x,y" -> color
  color: PALETTE[4],
  mode: 'pan',                // pan | draw | erase
  roomPasswords: JSON.parse(localStorage.getItem('pv_room_pwd') || '{}'),
  pendingJoin: null,          // 等待密码的房间
  reconnectTimer: null,
  authMode: 'login',
};

const view = { ox: 0, oy: 0, scale: 14 };

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const authScreen = $('authScreen'), appScreen = $('appScreen');
const canvas = $('board');
const ctx = canvas.getContext('2d', { alpha: false });

/* =========================================================
 *  通用 UI 辅助
 * ======================================================= */
let toastTimer;
function toast(msg, isErr = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2200);
}

let modeTimer;
function flashMode(text) {
  const el = $('modeToast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(modeTimer);
  modeTimer = setTimeout(() => el.classList.remove('show'), 1100);
}

function openPanel(id) {
  closePanels();
  $(id).classList.add('open');
  $('overlay').classList.add('show');
}
function closePanels() {
  $('roomPanel').classList.remove('open');
  $('menuPanel').classList.remove('open');
  $('boardPanel').classList.remove('open');
  $('shopPanel').classList.remove('open');
  $('settingsPanel').classList.remove('open');
  $('overlay').classList.remove('show');
}

async function api(url, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && S.token) headers.Authorization = 'Bearer ' + S.token;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch { /* 非 JSON */ }
  if (!res.ok || data.ok === false) {
    throw new Error(data.message || `请求失败 (${res.status})`);
  }
  return data;
}

/* =========================================================
 *  登录 / 注册
 * ======================================================= */
function authFieldsVisible(mode) {
  const reg = mode === 'register';
  $('emailField').classList.toggle('hidden', !reg);
  $('codeField').classList.toggle('hidden', !reg);
}
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    S.authMode = t.dataset.tab;
    $('authSubmit').textContent = S.authMode === 'login' ? '进入画布' : '注册并进入';
    $('authError').textContent = '';
    authFieldsVisible(S.authMode);
  });
});

// 游客 → 顶部「登录」按钮（窄屏折叠进更多菜单，按钮逻辑一致）
function openLoginPanel() {
  S.authMode = 'login';
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === 'login'));
  $('authSubmit').textContent = '进入画布';
  authFieldsVisible('login');
  openAuth();
}
$('btnLoginTop').addEventListener('click', openLoginPanel);
$('btnLoginTopM').addEventListener('click', () => { closeMoreMenu(); openLoginPanel(); });

/* ---------- 更多下拉菜单（窄屏折叠次要信息） ---------- */
function toggleMoreMenu() { $('moreMenu').classList.toggle('hidden'); }
function closeMoreMenu() { $('moreMenu').classList.add('hidden'); }
$('btnMore').addEventListener('click', (e) => { e.stopPropagation(); toggleMoreMenu(); });
$('moreMenu').addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', closeMoreMenu);
$('btnShopM').addEventListener('click', () => { closeMoreMenu(); openPanel('shopPanel'); refreshShop(); });
$('btnCheckinM').addEventListener('click', async () => {
  if (!requireLogin()) return;
  closeMoreMenu();
  try {
    const d = await api('/api/checkin', { method: 'POST' });
    if (S.user) {
      S.user.points = d.pointsNow;
      S.user.tempPoints = d.tempPointsNow;
      S.user.coins = d.totalCoins;
      S.user.checkedToday = true;
      renderMe();
    }
    toast(`✅ 签到成功！+${d.coins} 涂鸦币 · +${d.tempPoints} 临时涂鸦点`);
  } catch (e) {
    toast(e.message, true);
  }
});

// 发送邮箱验证码
$('btnSendCode').addEventListener('click', async () => {
  const email = $('authEmail').value.trim();
  if (!email) { $('authError').textContent = '请先填写邮箱'; return; }
  const btn = $('btnSendCode');
  btn.disabled = true;
  $('authError').textContent = '';
  try {
    const d = await api('/api/send-code', { method: 'POST', body: { email }, auth: false });
    $('authError').textContent = d.message || '验证码已发送';
    let s = 60;
    const timer = setInterval(() => {
      btn.textContent = s > 0 ? `${s}s 后重发` : '发送验证码';
      if (s <= 0) { clearInterval(timer); btn.disabled = false; }
      s--;
    }, 1000);
  } catch (err) {
    $('authError').textContent = err.message;
    btn.disabled = false;
  }
});

$('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('authUser').value.trim();
  const password = $('authPass').value;
  const email = $('authEmail').value.trim();
  const code = $('authCode').value.trim();
  const btn = $('authSubmit');
  btn.disabled = true;
  $('authError').textContent = '';
  try {
    const body = { username, password };
    if (S.authMode === 'register') { body.email = email; body.code = code; }
    const d = await api('/api/' + (S.authMode === 'login' ? 'login' : 'register'),
      { method: 'POST', body, auth: false });
    S.token = d.token;
    S.user = d.user;
    localStorage.setItem('pv_token', S.token);
    enterApp();
  } catch (err) {
    $('authError').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$('btnLogout').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
  localStorage.removeItem('pv_token');
  S.token = ''; S.user = null;
  if (S.ws) { S.ws.close(); S.ws = null; }
  location.reload();
});

function enterApp() {
  authScreen.classList.add('hidden');
  appScreen.classList.remove('hidden');
  renderMe();
  buildPalette();
  resizeCanvas();
  centerOrigin();
  connectWS();
}

function openAuth() {
  closePanels();
  authScreen.classList.remove('hidden');
  appScreen.classList.add('hidden');
}

// 游客点击涂鸦/擦除/换色 → 弹出登录注册
function requireLogin() {
  if (S.user) return true;
  toast('请先登录后再涂鸦', true);
  openAuth();
  return false;
}

function renderMe() {
  const isGuest = !S.user;
  // 顶部登录按钮：仅游客显示；窄屏时折叠进更多菜单，同步显隐
  $('btnLoginTop').classList.toggle('hidden', !isGuest);
  $('btnLoginTopM').classList.toggle('hidden', !isGuest);
  // 顶部点数：游客显示 —
  $('myPoints').textContent = isGuest ? '—' : (S.user.points + '/' + (S.user.pointLimit || 60));

  if (isGuest) {
    $('meAvatar').textContent = '?';
    $('meName').textContent = '游客';
    $('mePoints').textContent = '—';
    $('meLevel').textContent = '-';
    $('meLevelM').textContent = '-';
    $('meCoins').textContent = '-';
    $('meCoinsM').textContent = '-';
    $('meCoins2').textContent = '-';
    $('meTotal').textContent = '-';
    $('meProgressText').textContent = '登录后开始涂鸦';
    $('meProgressFill').style.width = '0%';
    $('tempHud').classList.add('hidden');
    const btn = $('btnCheckin');
    btn.textContent = '签到'; btn.disabled = false; btn.classList.remove('checked');
    const btnM = $('btnCheckinM');
    btnM.textContent = '签到'; btnM.disabled = false; btnM.classList.remove('checked');
    return;
  }

  const u = S.user;
  $('meName').textContent = u.username;
  $('meAvatar').textContent = (u.username[0] || 'P').toUpperCase();
  const lim = u.pointLimit || 60;
  $('mePoints').textContent = u.points + '/' + lim;

  // 临时涂鸦点：独立浮动 UI（画布右下角，与正式点分开；仅在有值时显示）
  const tp = u.tempPoints || 0;
  $('tempHudNum').textContent = tp;
  $('tempHud').classList.toggle('hidden', tp <= 0);

  // 等级 / 涂鸦币 / 累计涂鸦（顶部 + 更多菜单同步）
  $('meLevel').textContent = u.level || 1;
  $('meLevelM').textContent = u.level || 1;
  $('meCoins').textContent = u.coins || 0;
  $('meCoinsM').textContent = u.coins || 0;
  $('meCoins2').textContent = u.coins || 0;
  $('meTotal').textContent = u.totalPlaced || 0;

  // 升级进度条：当前等级 → 下一级
  const lv = u.level || 1;
  const next = LEVELS[lv];   // 下一级配置（1级对应 LEVELS[1]）
  if (next) {
    const cur = LEVELS[lv - 1];
    const span = next.need - cur.need;
    const done = Math.max(0, Math.min(1, ((u.totalPlaced || 0) - cur.need) / span));
    $('meProgressText').textContent = `${u.totalPlaced || 0} / ${next.need} · 升 ${next.level} 级`;
    $('meProgressFill').style.width = Math.round(done * 100) + '%';
  } else {
    $('meProgressText').textContent = '已达最高等级 Lv.9';
    $('meProgressFill').style.width = '100%';
  }

  // 签到按钮状态（顶部 + 更多菜单同步）
  const btn = $('btnCheckin');
  if (u.checkedToday) { btn.textContent = '已签到'; btn.disabled = true; btn.classList.add('checked'); }
  else { btn.textContent = '签到'; btn.disabled = false; btn.classList.remove('checked'); }
  const btnM = $('btnCheckinM');
  if (u.checkedToday) { btnM.textContent = '已签到'; btnM.disabled = true; btnM.classList.add('checked'); }
  else { btnM.textContent = '签到'; btnM.disabled = false; btnM.classList.remove('checked'); }

  // 商店面板余额同步（面板关闭时也无妨）
  $('shopCoins').textContent = u.coins || 0;
  $('shopLimit').textContent = u.pointLimit || 60;
  $('shopCards').textContent = u.roomCards || 0;
  $('shopTempInfo').textContent = tp > 0 ? `当前临时点 ${tp}` : '暂无可消耗的临时点';
  $('myRoomCards').textContent = u.roomCards || 0;
}

/* =========================================================
 *  商店：涂鸦币兑换点数上限 / 临时涂鸦点
 * ======================================================= */
function refreshShop() {
  if (!S.user) return;
  $('shopCoins').textContent = S.user.coins || 0;
  $('shopLimit').textContent = S.user.pointLimit || 60;
  $('shopCards').textContent = S.user.roomCards || 0;
  $('shopTempInfo').textContent = (S.user.tempPoints || 0) > 0 ? `当前临时点 ${S.user.tempPoints}` : '暂无可消耗的临时点';
  $('shopMsg').textContent = '';
}

async function shopBuyLimit() {
  if (!S.user) { toast('请先登录', true); return; }
  const amount = Math.trunc(Number($('shopLimitInput').value));
  if (!Number.isFinite(amount) || amount < 1) { $('shopMsg').textContent = '请输入正确的兑换数量'; return; }
  try {
    const d = await api('/api/shop/buy-limit', { method: 'POST', body: { amount } });
    S.user = d.user;
    renderMe();
    $('shopMsg').textContent = d.message;
    toast(d.message);
  } catch (err) {
    $('shopMsg').textContent = err.message;
    toast(err.message, true);
  }
}

async function shopBuyTemp() {
  if (!S.user) { toast('请先登录', true); return; }
  const points = Math.trunc(Number($('shopTempInput').value));
  if (!Number.isFinite(points) || points < 10 || points % 10 !== 0) { $('shopMsg').textContent = '临时点数需为 10 的倍数（至少 10）'; return; }
  try {
    const d = await api('/api/shop/buy-temp', { method: 'POST', body: { points } });
    S.user = d.user;
    renderMe();
    $('shopMsg').textContent = d.message;
    toast(d.message);
  } catch (err) {
    $('shopMsg').textContent = err.message;
    toast(err.message, true);
  }
}

async function shopBuyCard() {
  if (!S.user) { toast('请先登录', true); return; }
  const cards = Math.trunc(Number($('shopCardInput').value));
  if (!Number.isFinite(cards) || cards < 1) { $('shopMsg').textContent = '请输入正确的张数'; return; }
  try {
    const d = await api('/api/shop/buy-card', { method: 'POST', body: { cards } });
    S.user = d.user;
    renderMe();
    $('shopMsg').textContent = d.message;
    toast(d.message);
  } catch (err) {
    $('shopMsg').textContent = err.message;
    toast(err.message, true);
  }
}

/* =========================================================
 *  房间设置（仅房主）：免点涂鸦 / 自定义恢复间隔
 * ======================================================= */
function updateRoomSettingsForm() {
  if (!S.room) return;
  $('setFreeDrawing').checked = !!S.room.freeDrawing;
  $('setRegenInput').value = S.room.pointRegenSeconds != null ? S.room.pointRegenSeconds : '';
  $('settingsMsg').textContent = '';
}

async function saveRoomSettings() {
  if (!S.room || !S.room.isOwner) { toast('只有房主可以设置房间玩法', true); return; }
  const freeDrawing = $('setFreeDrawing').checked;
  const regenVal = $('setRegenInput').value.trim();
  const body = { freeDrawing };
  if (regenVal !== '') body.pointRegenSeconds = Number(regenVal);
  try {
    const d = await api('/api/rooms/' + S.room.id + '/settings', { method: 'PUT', body });
    S.room.freeDrawing = d.room.freeDrawing;
    S.room.pointRegenSeconds = d.room.pointRegenSeconds;
    updateRoomSettingsForm();
    $('settingsMsg').textContent = '保存成功' + (d.room.freeDrawing ? '，本房间涂鸦免点' : '') + (d.room.pointRegenSeconds ? `，恢复间隔 ${d.room.pointRegenSeconds} 秒` : '，恢复间隔跟随全局');
    toast('房间玩法已更新');
  } catch (err) {
    $('settingsMsg').textContent = err.message;
    toast(err.message, true);
  }
}

/* =========================================================
 *  调色板
 * ======================================================= */
function buildPalette() {
  const box = $('palette');
  box.innerHTML = '';
  PALETTE.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'sw' + (c === S.color ? ' active' : '');
    b.style.background = c;
    b.title = c;
    b.addEventListener('click', () => {
      // 游客点击色板 → 弹登录
      if (!requireLogin()) return;
      S.color = c;
      box.querySelectorAll('.sw').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      if (S.mode !== 'draw') setMode('draw');
    });
    box.appendChild(b);
  });
}

/* =========================================================
 *  模式切换
 * ======================================================= */
function setMode(m) {
  // 游客：作画/擦除需登录
  if (m !== 'pan' && !requireLogin()) return;
  S.mode = m;
  $('btnPan').classList.toggle('active', m === 'pan');
  $('btnDraw').classList.toggle('active', m === 'draw');
  $('btnErase').classList.toggle('active', m === 'erase');
  canvas.classList.toggle('draw-mode', m !== 'pan');
  flashMode(m === 'pan' ? '拖动模式 · 拖拽平移画布'
    : m === 'draw' ? '作画模式 · 点击格子上色'
    : '擦除模式 · 点击清除像素');
}
$('btnPan').addEventListener('click', () => setMode('pan'));
$('btnDraw').addEventListener('click', () => setMode('draw'));
$('btnErase').addEventListener('click', () => setMode('erase'));
$('btnHome').addEventListener('click', () => { centerOrigin(); draw(); });
$('btnWorld').addEventListener('click', viewAllWorld);
$('btnZoomIn').addEventListener('click', () => zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1.35));
$('btnZoomOut').addEventListener('click', () => zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1 / 1.35));

/* =========================================================
 *  画布：尺寸 / 坐标换算 / 渲染
 * ======================================================= */
function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}
window.addEventListener('resize', () => { resizeCanvas(); });

function centerOrigin() {
  // 默认视野：全世界地图，中心为北京（116.39°E, 39.92°N），对应格坐标 (1163900, -43610)
  const w = canvas.clientWidth, h = canvas.clientHeight;
  view.scale = Math.min(w, h) / 3600000;   // 全世界地图按屏高适配
  view.ox = w / 2 - DEFAULT_CENTER.x * view.scale;
  view.oy = h / 2 - DEFAULT_CENTER.y * view.scale;
  updateHud();
  updateHudCoord();
}

const cellKey = (x, y) => x + ',' + y;
function screenToCell(sx, sy) {
  return {
    x: Math.floor((sx - view.ox) / view.scale),
    y: Math.floor((sy - view.oy) / view.scale),
  };
}

function zoomAt(sx, sy, factor) {
  const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, view.scale * factor));
  if (next === view.scale) return;
  const wx = (sx - view.ox) / view.scale;
  const wy = (sy - view.oy) / view.scale;
  view.scale = next;
  view.ox = sx - wx * view.scale;
  view.oy = sy - wy * view.scale;
  updateHud();
  draw();
}

function updateHud() {
  $('hudZoom').textContent = Math.round(view.scale / DEFAULT_SCALE * 100) + '%';
}

// 用视口中心格刷新坐标/经纬度显示（切换视野后调用）
function updateHudCoord() {
  const c = screenToCell(canvas.clientWidth / 2, canvas.clientHeight / 2);
  $('hudCoord').textContent = c.x + ', ' + c.y;
  $('hudLonLat').textContent = fmtLonLat(c.x, c.y);
}

let rafPending = false;
function draw() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; render(); });
}

/* ---------- 背景层：真实地图瓦片（主） + 示意轮廓（未加载占位） ---------- */
function drawWorldBackground(w, h, s) {
  const z = worldZoom(s);
  const n = 1 << z;
  const span = 3600000 / n;
  const ox = view.ox, oy = view.oy;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();

  // 1) 示意轮廓占位：瓦片尚未覆盖的区域可见，加载后会被真实地图盖住
  if (WORLD) {
    const vx0 = (0 - ox) / s, vy0 = (0 - oy) / s;
    const vx1 = (w - ox) / s, vy1 = (h - oy) / s;
    ctx.fillStyle = 'rgba(214,211,190,.9)';
    ctx.strokeStyle = 'rgba(160,150,110,.6)';
    ctx.lineWidth = 1;
    for (let i = 0; i < WORLD.landCells.length; i++) {
      const bb = WORLD.bboxes[i];
      if (bb.maxX < vx0 || bb.minX > vx1 || bb.maxY < vy0 || bb.minY > vy1) continue;
      const poly = WORLD.landCells[i];
      ctx.beginPath();
      ctx.moveTo(poly[0][0] * s + ox, poly[0][1] * s + oy);
      for (let j = 1; j < poly.length; j++) ctx.lineTo(poly[j][0] * s + ox, poly[j][1] * s + oy);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    // 南海诸岛 / 钓鱼岛占位点
    if (s >= 0.25) {
      const r = Math.max(1.2, s * 1.0);
      ctx.fillStyle = 'rgba(205,200,169,.9)';
      ctx.strokeStyle = 'rgba(160,150,110,.7)';
      for (const [cx, cy] of WORLD.isletCells) {
        const px = cx * s + ox, py = cy * s + oy;
        if (px < -12 || px > w + 12 || py < -12 || py > h + 12) continue;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      const dpx = WORLD.diaoyuCell[0] * s + ox, dpy = WORLD.diaoyuCell[1] * s + oy;
      if (dpx > -12 && dpx < w + 12 && dpy > -12 && dpy < h + 12) {
        ctx.beginPath();
        ctx.arc(dpx, dpy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  // 2) 已加载的真实地图瓦片（与像素格同用 Web Mercator，天然对齐）
  for (const [key, t] of tileCache) {
    if (!t.ok || !t.img) continue;
    const p = key.split('/');
    if (+p[0] !== z) continue;                 // 只画当前层级
    const tx = +p[1], ty = +p[2];
    const px = (-1800000 + tx * span) * s + ox;
    const py = (-1800000 + ty * span) * s + oy;
    const sz = span * s + 0.6;                 // 微扩 0.6px 消除接缝
    if (px + sz < 0 || px > w || py + sz < 0 || py > h) continue;
    ctx.drawImage(t.img, px, py, sz, sz);
  }

  ctx.restore();
}

/* 像素绘制：缩放 >=1 画实心格；缩放 <1 画 1px 点（全图视野下可见涂鸦分布） */
function drawPixel(cx, cy, s) {
  if (s >= 1) {
    ctx.fillRect(cx * s + view.ox, cy * s + view.oy, s + .6, s + .6);
  } else {
    ctx.fillRect(Math.round(cx * s + view.ox), Math.round(cy * s + view.oy), 1, 1);
  }
}

/* 世界格坐标 -> 经纬度文本（如 116.30°E 23.50°N） */
function fmtLonLat(x, y) {
  if (!WORLD) return '';
  const lon = WORLD.xToLon(x), lat = WORLD.yToLat(y);
  const ew = lon >= 0 ? 'E' : 'W';
  const ns = lat >= 0 ? 'N' : 'S';
  return Math.abs(lon).toFixed(2) + '°' + ew + ' ' + Math.abs(lat).toFixed(2) + '°' + ns;
}

/* 一键查看整个示意世界地图 */
function viewAllWorld() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  view.scale = Math.min(w, h) / 3600000;   // 世界地图区域为 36000 x 36000 格
  view.ox = w / 2;
  view.oy = h / 2;
  updateHud();
  updateHudCoord();
  draw();
}

function render() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const s = view.scale;

  // 海洋底色
  ctx.fillStyle = '#e9f2fb';
  ctx.fillRect(0, 0, w, h);

  // 请求并绘制真实地图瓦片（含占位轮廓）
  ensureTiles(w, h, s);
  drawWorldBackground(w, h, s);

  const x0 = Math.floor((0 - view.ox) / s);
  const y0 = Math.floor((0 - view.oy) / s);
  const x1 = Math.ceil((w - view.ox) / s);
  const y1 = Math.ceil((h - view.oy) / s);
  const visibleCells = (x1 - x0 + 1) * (y1 - y0 + 1);

  // 像素：缩小到省级（zoom ≤ 8）及更小时隐藏涂鸦，避免满屏像素淹没地图；数据保留，放大后恢复
  if (worldZoom(s) > HIDE_PIXELS_ZOOM) {
    // 可视格数少时遍历范围，否则遍历已有像素
    if (visibleCells <= S.pixels.size) {
      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
          const c = S.pixels.get(cellKey(cx, cy));
          if (!c) continue;
          ctx.fillStyle = c;
          drawPixel(cx, cy, s);
        }
      }
    } else {
      for (const [k, c] of S.pixels) {
        const i = k.indexOf(',');
        const cx = +k.slice(0, i), cy = +k.slice(i + 1);
        if (cx < x0 || cx > x1 || cy < y0 || cy > y1) continue;
        ctx.fillStyle = c;
        drawPixel(cx, cy, s);
      }
    }
  }

  // 网格
  if (s >= 6) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = s >= 10 ? 'rgba(0,0,0,.09)' : 'rgba(0,0,0,.05)';
    ctx.beginPath();
    for (let cx = x0; cx <= x1 + 1; cx++) {
      const px = Math.round(cx * s + view.ox) + .5;
      ctx.moveTo(px, 0); ctx.lineTo(px, h);
    }
    for (let cy = y0; cy <= y1 + 1; cy++) {
      const py = Math.round(cy * s + view.oy) + .5;
      ctx.moveTo(0, py); ctx.lineTo(w, py);
    }
    ctx.stroke();
  }

  // 每 16 格的粗参考线
  if (s >= 3) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,.16)';
    ctx.beginPath();
    const gx0 = Math.floor(x0 / 16) * 16, gy0 = Math.floor(y0 / 16) * 16;
    for (let cx = gx0; cx <= x1 + 16; cx += 16) {
      const px = Math.round(cx * s + view.ox) + .5;
      ctx.moveTo(px, 0); ctx.lineTo(px, h);
    }
    for (let cy = gy0; cy <= y1 + 16; cy += 16) {
      const py = Math.round(cy * s + view.oy) + .5;
      ctx.moveTo(0, py); ctx.lineTo(w, py);
    }
    ctx.stroke();
  }

  // 原点标记
  ctx.strokeStyle = 'rgba(91,140,255,.85)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(view.ox + .5, view.oy + .5, Math.max(s, 3), Math.max(s, 3));

  // 悬停高亮（桌面端作画模式）
  if (hover && S.mode !== 'pan') {
    ctx.strokeStyle = S.mode === 'erase' ? 'rgba(239,68,68,.95)' : 'rgba(17,24,39,.95)';
    ctx.lineWidth = 2;
    ctx.strokeRect(hover.x * s + view.ox + 1, hover.y * s + view.oy + 1, s - 2, s - 2);
  }
}

/* =========================================================
 *  指针交互：拖动 / 作画 / 缩放
 * ======================================================= */
const pointers = new Map();
let hover = null;
let dragState = null;     // {lastX,lastY,moved}
let pinchState = null;    // {dist,cx,cy}
let paintLast = null;     // 上一个上色格

function canvasPos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const p = canvasPos(e);
  pointers.set(e.pointerId, p);

  if (pointers.size === 2) {
    dragState = null;
    const [a, b] = [...pointers.values()];
    pinchState = {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2,
    };
    return;
  }
  if (pointers.size > 2) return;

  // 右键 / 中键 强制平移
  const forcePan = e.button === 1 || e.button === 2;
  if (S.mode === 'pan' || forcePan) {
    dragState = { lastX: p.x, lastY: p.y, moved: false };
    canvas.classList.add('dragging');
  } else {
    paintLast = null;
    paintAtScreen(p.x, p.y);
  }
});

canvas.addEventListener('pointermove', (e) => {
  const p = canvasPos(e);
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);

  // 悬停坐标
  const c = screenToCell(p.x, p.y);
  $('hudCoord').textContent = c.x + ', ' + c.y;
  $('hudLonLat').textContent = fmtLonLat(c.x, c.y);
  if (e.pointerType === 'mouse') {
    if (!hover || hover.x !== c.x || hover.y !== c.y) { hover = c; draw(); }
  }

  if (pinchState && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    if (pinchState.dist > 0) zoomAt(cx, cy, dist / pinchState.dist);
    view.ox += cx - pinchState.cx;
    view.oy += cy - pinchState.cy;
    pinchState = { dist, cx, cy };
    draw();
    return;
  }

  if (dragState) {
    const dx = p.x - dragState.lastX, dy = p.y - dragState.lastY;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) dragState.moved = true;
    view.ox += dx; view.oy += dy;
    dragState.lastX = p.x; dragState.lastY = p.y;
    draw();
    return;
  }

  // 作画模式下拖拽连续上色
  if (pointers.has(e.pointerId) && S.mode !== 'pan' && pointers.size === 1) {
    paintAtScreen(p.x, p.y);
  }
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchState = null;
  if (pointers.size === 0) {
    dragState = null;
    paintLast = null;
    canvas.classList.remove('dragging');
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', (e) => {
  if (e.pointerType === 'mouse') { hover = null; draw(); }
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const p = canvasPos(e);
  // 缩小用更大步长（1/1.3），便于快速回到世界全图
  zoomAt(p.x, p.y, e.deltaY < 0 ? 1.14 : 1 / 1.3);
}, { passive: false });

// 键盘：空格切换拖动，D 作画，E 擦除
window.addEventListener('keydown', (e) => {
  if (appScreen.classList.contains('hidden')) return;
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); setMode(S.mode === 'pan' ? 'draw' : 'pan'); }
  if (e.key === 'd' || e.key === 'D') setMode('draw');
  if (e.key === 'e' || e.key === 'E') setMode('erase');
  if (e.key === 'h' || e.key === 'H') { centerOrigin(); draw(); }
});

/* ---------- 上色（含拖拽插值 + 发送节流队列） ---------- */
function paintAtScreen(sx, sy) {
  const c = screenToCell(sx, sy);
  if (paintLast) {
    // 沿路径插值，避免快速拖动出现断点
    const dx = c.x - paintLast.x, dy = c.y - paintLast.y;
    const steps = Math.max(Math.abs(dx), Math.abs(dy));
    if (steps > 1 && steps <= 200) {
      for (let i = 1; i < steps; i++) {
        paintCell(paintLast.x + Math.round(dx * i / steps), paintLast.y + Math.round(dy * i / steps));
      }
    }
  }
  paintCell(c.x, c.y);
  paintLast = c;
}

const sendQueue = [];
let flushTimer = null;

function paintCell(x, y) {
  const key = cellKey(x, y);
  const erase = S.mode === 'erase';
  const target = erase ? null : S.color;
  const cur = S.pixels.get(key) || null;
  if (cur === target) return;              // 无变化，不发送

  // 本地乐观更新
  if (target) S.pixels.set(key, target); else S.pixels.delete(key);
  draw();

  sendQueue.push({ type: 'place', x, y, color: target || '#000000', erase });
  if (sendQueue.length > 4000) sendQueue.splice(0, sendQueue.length - 4000);
  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    if (!S.wsReady) { return; }
    let n = 0;
    while (sendQueue.length && n < 8) { wsSend(sendQueue.shift()); n++; }
    if (!sendQueue.length) { clearInterval(flushTimer); flushTimer = null; }
  }, 45);
}

/* =========================================================
 *  WebSocket
 * ======================================================= */
function wsSend(obj) {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(obj));
}

function connectWS() {
  clearTimeout(S.reconnectTimer);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  S.ws = ws;

  ws.onopen = () => { wsSend({ type: 'auth', token: S.token }); };

  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    switch (m.type) {
      case 'auth_ok':
        S.wsReady = true;
        if (m.user) { S.user = m.user; renderMe(); }
        const storedRoom = Number(localStorage.getItem('pv_room') || 0) || null;
        joinRoom((S.room?.id) ?? storedRoom);
        break;

      case 'auth_fail':
        S.wsReady = false;
        localStorage.removeItem('pv_token');
        toast(m.message || '登录已失效', true);
        setTimeout(() => location.reload(), 1200);
        break;

      case 'joined': {
        S.room = m.room;
        localStorage.setItem('pv_room', String(m.room.id));
        S.pixels = new Map();          // 清空，等待分块像素到达（大房间避免一次性构建卡顿）
        $('roomName').textContent = m.room.name;
        $('roomLock').classList.toggle('hidden', !m.room.hasPassword);
        $('btnDeleteRoom').classList.toggle('hidden', !m.room.isOwner);
        $('btnRoomSettings').classList.toggle('hidden', !m.room.isOwner);
        if (m.user) { S.user = m.user; renderMe(); }
        draw();
        refreshRooms();
        toast(m.pixelTotal > 3000
          ? `已进入「${m.room.name}」，正在加载 ${m.pixelTotal} 像素画布…`
          : `已进入「${m.room.name}」`);
        break;
      }

      case 'pixels_chunk': {
        // 增量构建画布：每块最多 3000 像素，逐块填充并重绘视口
        const c = m.chunk || [];
        if (c.length) {
          for (const p of c) S.pixels.set(cellKey(p.x, p.y), p.color);
          draw();
        }
        break;
      }

      case 'pixels_done': {
        toast(`画布加载完成（共 ${S.pixels.size} 像素）`);
        draw();
        break;
      }

      case 'room_settings': {
        if (S.room && S.room.id === m.room.id) {
          S.room.freeDrawing = m.room.freeDrawing;
          S.room.pointRegenSeconds = m.room.pointRegenSeconds;
          if (m.room.freeDrawing) toast('本房间已开启免点涂鸦（不消耗涂鸦点）');
          else if (S.room.isOwner) toast('本房间已关闭免点涂鸦');
          updateRoomSettingsForm();
        }
        break;
      }

      case 'join_denied':
        S.pendingJoin = { id: m.roomId, name: $('pwdRoomName').textContent || '房间' };
        $('pwdErr').textContent = m.message || '密码错误';
        $('pwdModal').classList.add('show');
        $('pwdInput').focus();
        break;

      case 'pixel': {
        const k = cellKey(m.x, m.y);
        if (m.color) S.pixels.set(k, m.color); else S.pixels.delete(k);
        draw();
        break;
      }

      case 'points':
        if (S.user) {
          S.user.points = m.points;
          if (m.limit != null) S.user.pointLimit = m.limit;
          if (m.level != null) S.user.level = m.level;
          if (m.coins != null) S.user.coins = m.coins;
          if (m.totalPlaced != null) S.user.totalPlaced = m.totalPlaced;
          if (m.tempPoints != null) S.user.tempPoints = m.tempPoints;
          renderMe();
        }
        break;

      case 'level_up':
        if (S.user) {
          S.user.level = m.level;
          S.user.coins = m.coins;
          if (m.limit != null) S.user.pointLimit = m.limit;
          if (m.total != null) S.user.totalPlaced = m.total;
          if (m.tempBonus != null) S.user.tempPoints = (S.user.tempPoints || 0) + m.tempBonus;
          renderMe();
        }
        toast(`🎉 升到 Lv.${m.level}！获得 ${m.bonus} 涂鸦币 + ${m.tempBonus ?? 0} 临时涂鸦点，点数上限提升至 ${m.limit}`);
        break;

      case 'presence':
        $('onlineCount').textContent = m.count;
        break;

      case 'cleared':
        S.pixels.clear();
        draw();
        toast('画布已被清空');
        break;

      case 'pixels_removed': {
        // 后台删除了某些坐标的画迹，实时从本地画布移除
        for (const c of (m.coords || [])) S.pixels.delete(cellKey(c[0], c[1]));
        draw();
        break;
      }

      case 'kicked':
        toast(m.reason || '已离开房间', true);
        S.room = null;
        S.pixels.clear();
        draw();
        if (m.banned) {
          localStorage.removeItem('pv_token');
          setTimeout(() => location.reload(), 1500);
        } else {
          localStorage.removeItem('pv_room');
          setTimeout(() => joinRoom(null), 600);
        }
        break;

      case 'error':
        toast(m.message, true);
        break;
    }
  };

  ws.onclose = () => {
    S.wsReady = false;
    S.reconnectTimer = setTimeout(connectWS, 1800);
  };
  ws.onerror = () => { /* onclose 会接管重连 */ };
}

function joinRoom(roomId, password) {
  const pwd = password !== undefined ? password
    : (roomId != null ? (S.roomPasswords[roomId] || '') : '');
  wsSend({ type: 'join', roomId, password: pwd });
}

/* ---------- 房间密码弹窗 ---------- */
$('pwdCancel').addEventListener('click', () => {
  $('pwdModal').classList.remove('show');
  S.pendingJoin = null;
});
$('pwdOk').addEventListener('click', submitPwd);
$('pwdInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitPwd(); });

function submitPwd() {
  if (!S.pendingJoin) return;
  const pwd = $('pwdInput').value;
  S.roomPasswords[S.pendingJoin.id] = pwd;
  localStorage.setItem('pv_room_pwd', JSON.stringify(S.roomPasswords));
  $('pwdModal').classList.remove('show');
  $('pwdInput').value = '';
  joinRoom(S.pendingJoin.id, pwd);
}

/* =========================================================
 *  房间面板
 * ======================================================= */
$('btnRooms').addEventListener('click', () => { openPanel('roomPanel'); refreshRooms(); });
$('btnMenu').addEventListener('click', () => openPanel('menuPanel'));
$('btnBoard').addEventListener('click', () => { openPanel('boardPanel'); loadBoard(); });
$('btnShop').addEventListener('click', () => { openPanel('shopPanel'); refreshShop(); });
$('tempHud').addEventListener('click', () => { if (!requireLogin()) return; openPanel('shopPanel'); refreshShop(); });
$('overlay').addEventListener('click', closePanels);
document.querySelectorAll('[data-close]').forEach((b) =>
  b.addEventListener('click', closePanels));

/* ---------- 签到：每天一次，随机 20-50 涂鸦币 + 20-30 涂鸦点 ---------- */
$('btnCheckin').addEventListener('click', async () => {
  try {
    const d = await api('/api/checkin', { method: 'POST' });
    if (S.user) {
      S.user.points = d.pointsNow;
      S.user.tempPoints = d.tempPointsNow;
      S.user.coins = d.totalCoins;
      S.user.checkedToday = true;
      renderMe();
    }
    toast(`✅ 签到成功！+${d.coins} 涂鸦币 · +${d.tempPoints} 临时涂鸦点`);
  } catch (e) {
    toast(e.message, true);
  }
});

/* ---------- 排行榜：涂鸦累计前 10 ---------- */
async function loadBoard() {
  try {
    const { list } = await api('/api/leaderboard', { auth: false });
    $('boardRows').innerHTML = list.length
      ? list.map((u, i) => `
        <div class="board-item${S.user && S.user.username === u.username ? ' me' : ''}">
          <span class="rank${i < 3 ? ' top' : ''}">${i + 1}</span>
          <span class="b-name">${esc(u.username)}</span>
          <span class="b-lv">Lv.${u.level}</span>
          <span class="b-total">${u.total_placed} 涂鸦</span>
        </div>`).join('')
      : '<div class="muted center-pad">暂无数据</div>';
  } catch (e) {
    toast(e.message, true);
  }
}

async function refreshRooms() {
  try {
    const { rooms } = await api('/api/rooms', { auth: false });
    const box = $('roomList');
    box.innerHTML = '';
    rooms.forEach((r) => {
      const item = document.createElement('div');
      item.className = 'room-item' + (S.room && S.room.id === r.id ? ' current' : '');
      item.innerHTML = `
        <div class="ri-icon">${r.isPublic ? '🌐' : (r.hasPassword ? '🔒' : '🎨')}</div>
        <div class="ri-main">
          <div class="ri-name">${esc(r.name)}${r.isPublic ? '<span class="badge pub">公共</span>' : ''}${r.hasPassword ? '<span class="badge">加密</span>' : ''}</div>
          <div class="ri-meta">在线 ${r.online} · 像素 ${r.pixelCount}${r.owner ? ' · 房主 ' + esc(r.owner) : ''}</div>
        </div>`;
      item.addEventListener('click', () => {
        closePanels();
        if (S.room && S.room.id === r.id) return;
        if (r.hasPassword && !S.roomPasswords[r.id]) {
          S.pendingJoin = { id: r.id, name: r.name };
          $('pwdRoomName').textContent = r.name;
          $('pwdErr').textContent = '';
          $('pwdInput').value = '';
          $('pwdModal').classList.add('show');
          setTimeout(() => $('pwdInput').focus(), 60);
        } else {
          joinRoom(r.id);
        }
      });
      box.appendChild(item);
    });
  } catch (err) {
    toast(err.message, true);
  }
}

$('createRoomForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('newRoomName').value.trim();
  const password = $('newRoomPass').value;
  $('createErr').textContent = '';
  try {
    const d = await api('/api/rooms', { method: 'POST', body: { name, password } });
    const room = d.room;
    if (d.user) { S.user = d.user; renderMe(); }   // 开房卡 -1 同步
    S.roomPasswords[room.id] = password;
    localStorage.setItem('pv_room_pwd', JSON.stringify(S.roomPasswords));
    $('newRoomName').value = ''; $('newRoomPass').value = '';
    closePanels();
    joinRoom(room.id, password);
  } catch (err) {
    $('createErr').textContent = err.message;
  }
});

$('btnDeleteRoom').addEventListener('click', async () => {
  if (!S.room || S.room.isPublic) return;
  if (!confirm(`确定删除房间「${S.room.name}」？画布内容将一并清除。`)) return;
  try {
    await api('/api/rooms/' + S.room.id, { method: 'DELETE' });
    closePanels();
    toast('房间已删除');
  } catch (err) {
    toast(err.message, true);
  }
});

$('btnRoomSettings').addEventListener('click', () => {
  if (!S.room || !S.room.isOwner) return;
  updateRoomSettingsForm();
  openPanel('settingsPanel');
});

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* =========================================================
 *  启动
 * ======================================================= */
(async function boot() {
  // 游客模式：无论是否登录都直接进入画布观看；有 token 时自动登录
  if (S.token) {
    try {
      const { user } = await api('/api/me');
      S.user = user;
    } catch {
      localStorage.removeItem('pv_token');
      S.token = '';
    }
  }
  enterApp();
})();

setInterval(() => { if (S.room) refreshRoomsQuiet(); }, 15000);
async function refreshRoomsQuiet() {
  if (!$('roomPanel').classList.contains('open')) return;
  try { await refreshRooms(); } catch { /* ignore */ }
}
