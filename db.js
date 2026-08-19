'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

// ---------- 载入 .env（部署配置，可选）----------
// 读取项目根目录下的 .env，将 KEY=VALUE 注入 process.env（不覆盖已有变量）。
(function loadEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    const txt = fs.readFileSync(envPath, 'utf8');
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch { /* 忽略 .env 读取错误，使用默认值 */ }
})();

// ---------- MySQL 连接池 ----------
// 默认库名/账号/密码均为 qypixel，可通过 .env 覆盖。
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'qypixel',
  password: process.env.MYSQL_PASS || 'qypixel',
  database: process.env.MYSQL_DB || 'qypixel',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
});

// ---------- 通用查询封装 ----------
async function run(sql, params = []) {
  const [r] = await pool.execute(sql, params);
  return { lastInsertRowid: r.insertId, changes: r.affectedRows };
}
async function all(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}
async function get(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows[0];
}

// ---------- 初始化默认数据 ----------
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const PUBLIC_ROOM_NAME = '公共画布';

async function runSql(sql) {
  await pool.execute(sql);
}

// MySQL 8.0 无 ADD COLUMN IF NOT EXISTS，需先查 information_schema 再迁移
async function ensureColumn(table, column, ddl) {
  const rows = await all(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [table]);
  const cols = new Set(rows.map((r) => r.COLUMN_NAME));
  if (!cols.has(column)) {
    await runSql(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

async function initDB() {
  // ---- 建表（InnoDB + utf8mb4）----
  await runSql(`CREATE TABLE IF NOT EXISTS users (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    username    VARCHAR(64) NOT NULL UNIQUE,
    password    VARCHAR(255) NOT NULL,
    points      INT NOT NULL DEFAULT 60,
    point_limit INT NOT NULL DEFAULT 60,
    banned      TINYINT NOT NULL DEFAULT 0,
    is_admin    TINYINT NOT NULL DEFAULT 0,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_seen   TIMESTAMP NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await runSql(`CREATE TABLE IF NOT EXISTS rooms (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    name       VARCHAR(64) NOT NULL UNIQUE,
    password   VARCHAR(255) NOT NULL DEFAULT '',
    is_public  TINYINT NOT NULL DEFAULT 0,
    owner_id   INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await runSql(`CREATE TABLE IF NOT EXISTS pixels (
    room_id   INT NOT NULL,
    x         INT NOT NULL,
    y         INT NOT NULL,
    color     VARCHAR(7) NOT NULL,
    user_id   INT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (room_id, x, y),
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await runSql(`CREATE TABLE IF NOT EXISTS settings (
    \`key\`   VARCHAR(64) PRIMARY KEY,
    value    VARCHAR(255) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await runSql(`CREATE TABLE IF NOT EXISTS sessions (
    token      VARCHAR(64) PRIMARY KEY,
    user_id    INT NOT NULL,
    kind       VARCHAR(16) NOT NULL DEFAULT 'user',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // 画迹日志：记录每位用户的每次落子/擦除，便于后台溯源
  await runSql(`CREATE TABLE IF NOT EXISTS pixel_logs (
    id         BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id    INT NOT NULL,
    room_id    INT NOT NULL,
    x          INT NOT NULL,
    y          INT NOT NULL,
    color      VARCHAR(7)  NOT NULL DEFAULT '',
    action     VARCHAR(8)  NOT NULL DEFAULT 'place',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_logs_user (user_id, id),
    INDEX idx_logs_room (room_id, id),
    INDEX idx_logs_time (id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // ---- 默认管理员 ----
  const admin = await get('SELECT id FROM users WHERE username = ?', [ADMIN_USER]);
  if (!admin) {
    await run('INSERT INTO users (username, password, points, point_limit, is_admin) VALUES (?, ?, 60, 60, 1)',
      [ADMIN_USER, ADMIN_PASS]);
  } else {
    await run('UPDATE users SET is_admin = 1 WHERE id = ?', [admin.id]);
  }

  // ---- 默认公共房间 ----
  const pub = await get('SELECT id FROM rooms WHERE is_public = 1');
  if (!pub) {
    await run("INSERT INTO rooms (name, password, is_public, owner_id) VALUES (?, '', 1, NULL)",
      [PUBLIC_ROOM_NAME]);
  }

  // ---- 默认恢复间隔设置 ----
  const sec = await get('SELECT value FROM settings WHERE `key` = ?', ['point_regen_seconds']);
  if (!sec) {
    await run('INSERT INTO settings (`key`, value) VALUES (?, ?)', ['point_regen_seconds', '30']);
  }

  // ---- 坐标细化一次性迁移：1格=0.01° → 1格=0.0001°（像素/画迹坐标 ×100）----
  const cs = await get('SELECT value FROM settings WHERE `key` = ?', ['coord_scale']);
  if (!cs) {
    await run('UPDATE pixels SET x = x * 100, y = y * 100');
    await run('UPDATE pixel_logs SET x = x * 100, y = y * 100');
    await run('INSERT INTO settings (`key`, value) VALUES (?, ?)', ['coord_scale', '100']);
  }

  // ---- 等级/涂鸦币/签到 列迁移（兼容已有库） ----
  await ensureColumn('users', 'total_placed', 'total_placed INT NOT NULL DEFAULT 0');
  await ensureColumn('users', 'level', 'level INT NOT NULL DEFAULT 1');
  await ensureColumn('users', 'coins', 'coins INT NOT NULL DEFAULT 0');
  await ensureColumn('users', 'last_checkin', 'last_checkin DATE NULL');
  await ensureColumn('users', 'claimed_level', 'claimed_level INT NOT NULL DEFAULT 1');
  // 邮箱（注册验证用；开关关闭时可空）
  await ensureColumn('users', 'email', 'email VARCHAR(255) NULL');

  // ---- 邮箱验证开关：默认开启 ----
  const evr = await get('SELECT value FROM settings WHERE `key` = ?', ['email_verify_required']);
  if (!evr) {
    await run('INSERT INTO settings (`key`, value) VALUES (?, ?)', ['email_verify_required', '1']);
  }

  // ---- 邮箱唯一性：空字符串改为 NULL（避免 UNIQUE 索引把多个空邮箱判为重复），并建 UNIQUE 索引 ----
  // 封号用户的邮箱保留占用，无法用同一邮箱再注册（findUserByEmail 查全部用户含封禁）
  await run("UPDATE users SET email = NULL WHERE email = ''");
  const idx = await all(
    'SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
    ['users', 'uniq_email']);
  if (idx.length === 0) {
    await runSql('ALTER TABLE users ADD UNIQUE INDEX uniq_email (email)');
  }
}

// ---------- 查询封装 ----------
// 所有方法均为 async，返回 Promise；.get()/all()/run() 的语义与原 SQLite 版一致。
const Q = {
  // users
  findUserByName: (username) => get('SELECT * FROM users WHERE username = ?', [username]),
  findUserById: (id) => get('SELECT * FROM users WHERE id = ?', [id]),
  findUserByEmail: (email) => get('SELECT * FROM users WHERE email = ?', [email]),
  createUser: (username, password, email) =>
    run('INSERT INTO users (username, password, email, points, point_limit) VALUES (?, ?, ?, 60, 60)',
      [username, password, email ? email : null]),
  // 后台修改用户资料：仅更新传入的字段（null 表示不更新；空邮箱存 NULL 保持唯一索引兼容）
  updateUser: async (id, patch) => {
    const sets = [], params = [];
    if (patch.username !== undefined) { sets.push('username = ?'); params.push(patch.username); }
    if (patch.password !== undefined) { sets.push('password = ?'); params.push(patch.password); }
    if (patch.email !== undefined) { sets.push('email = ?'); params.push(patch.email ? patch.email : null); }
    if (!sets.length) return { changes: 0 };
    params.push(id);
    return run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
  },
  getUserPoints: (id) => get('SELECT points, point_limit FROM users WHERE id = ?', [id]),
  addPoints: (delta, id) =>
    run("UPDATE users SET points = points + ?, last_seen = NOW() WHERE id = ?", [delta, id]),
  setPoints: (v, id) => run('UPDATE users SET points = ? WHERE id = ?', [v, id]),
  touchUser: (id) => run('UPDATE users SET last_seen = NOW() WHERE id = ?', [id]),
  listUsers: () => all(`
    SELECT u.id, u.username, u.password, u.email, u.points, u.point_limit, u.banned, u.is_admin,
           u.total_placed, u.level, u.coins,
           DATE_FORMAT(u.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
           DATE_FORMAT(u.last_seen, '%Y-%m-%d %H:%i:%s') AS last_seen,
           (SELECT COUNT(*) FROM rooms r WHERE r.owner_id = u.id) AS owned_rooms
    FROM users u ORDER BY u.id ASC`),
  setBanned: (banned, id) => run('UPDATE users SET banned = ? WHERE id = ?', [banned, id]),
  deleteUser: (id) => run('DELETE FROM users WHERE id = ? AND is_admin = 0', [id]),
  resetPoints: (id) => run('UPDATE users SET points = 0 WHERE id = ?', [id]),
  setPointLimit: (limit, id) => run('UPDATE users SET point_limit = ? WHERE id = ?', [limit, id]),
  setCoins: (coins, id) => run('UPDATE users SET coins = ? WHERE id = ?', [coins, id]),
  // 原子扣 1 点（并发安全）：affectedRows=0 表示点数不足
  spendPoint: (id) => run('UPDATE users SET points = points - 1 WHERE id = ? AND points > 0', [id]),
  // 预览恢复：加回 count 点（不超过上限）
  restorePoints: (count, id) =>
    run('UPDATE users SET points = LEAST(point_limit, points + ?) WHERE id = ?', [count, id]),

  // 等级系统：累计涂鸦 +1 并返回更新后的用户（MySQL 不支持 RETURNING，需两步）
  addPlaced: async (id) => {
    await run('UPDATE users SET total_placed = total_placed + 1 WHERE id = ?', [id]);
    return get('SELECT * FROM users WHERE id = ?', [id]);
  },
  // 升级：更新等级/点数上限，涂鸦币原子累加（仅当新等级更高；affectedRows=1 才是本次真正升级者）
  upgrade: (id, level, limit, bonusCoins) => run(`
    UPDATE users SET level = ?, point_limit = ?, coins = coins + ?
    WHERE id = ? AND level < ?`, [level, limit, bonusCoins, id, level]),
  // 签到：记录日期、加涂鸦币、加点数（不超过上限）
  checkin: (id, date, coinBonus, pointBonus) => run(`
    UPDATE users SET last_checkin = ?, coins = coins + ?,
      points = LEAST(point_limit, points + ?) WHERE id = ?`,
    [date, coinBonus, pointBonus, id]),
  // 排行榜：涂鸦最多的前 N 名（LIMIT 为整数，内联避免 ER_WRONG_ARGUMENTS）
  leaderboard: (limit) => all(`
    SELECT username, total_placed, level, points, coins FROM users
    ORDER BY total_placed DESC, id ASC LIMIT ${limit}`),

  // 点数额度恢复：把未达上限的用户 +1（由定时任务批量调用）
  regenPoints: () =>
    run('UPDATE users SET points = LEAST(point_limit, points + 1) WHERE points < point_limit'),

  // settings
  getSetting: (k) => get('SELECT value FROM settings WHERE `key` = ?', [k]),
  setSetting: (k, v) =>
    run('INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = ?', [k, v, v]),

  // rooms
  listRoomsPublicView: () => all(`
    SELECT r.id, r.name, r.is_public,
           DATE_FORMAT(r.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
           CASE WHEN r.password = '' THEN 0 ELSE 1 END AS has_password,
           (SELECT username FROM users u WHERE u.id = r.owner_id) AS owner,
           (SELECT COUNT(*) FROM pixels p WHERE p.room_id = r.id) AS pixel_count
    FROM rooms r ORDER BY r.is_public DESC, r.id ASC`),
  listRoomsAdminView: () => all(`
    SELECT r.id, r.name, r.password, r.is_public,
           DATE_FORMAT(r.created_at, '%Y-%m-%d %H:%i:%s') AS created_at, r.owner_id,
           (SELECT username FROM users u WHERE u.id = r.owner_id) AS owner,
           (SELECT COUNT(*) FROM pixels p WHERE p.room_id = r.id) AS pixel_count
    FROM rooms r ORDER BY r.is_public DESC, r.id ASC`),
  findRoomById: (id) => get('SELECT * FROM rooms WHERE id = ?', [id]),
  findRoomByName: (name) => get('SELECT * FROM rooms WHERE name = ?', [name]),
  publicRoom: () => get('SELECT * FROM rooms WHERE is_public = 1 LIMIT 1'),
  createRoom: (name, password, ownerId) =>
    run('INSERT INTO rooms (name, password, owner_id) VALUES (?, ?, ?)', [name, password, ownerId]),
  deleteRoom: (id) => run('DELETE FROM rooms WHERE id = ? AND is_public = 0', [id]),
  countUserRooms: (id) => get('SELECT COUNT(*) AS c FROM rooms WHERE owner_id = ?', [id]),
  updateRoomPassword: (password, id) => run('UPDATE rooms SET password = ? WHERE id = ?', [password, id]),

  // pixels
  pixelsOfRoom: (roomId) => all('SELECT x, y, color FROM pixels WHERE room_id = ?', [roomId]),
  getPixel: (roomId, x, y) => get('SELECT color FROM pixels WHERE room_id = ? AND x = ? AND y = ?', [roomId, x, y]),
  upsertPixel: (roomId, x, y, color, userId) =>
    run(`INSERT INTO pixels (room_id, x, y, color, user_id, updated_at)
         VALUES (?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE color = ?, user_id = ?, updated_at = NOW()`,
      [roomId, x, y, color, userId, color, userId]),
  deletePixel: (roomId, x, y) => run('DELETE FROM pixels WHERE room_id = ? AND x = ? AND y = ?', [roomId, x, y]),
  clearRoom: (roomId) => run('DELETE FROM pixels WHERE room_id = ?', [roomId]),

  // 画迹日志
  insertPixelLog: (userId, roomId, x, y, color, action) =>
    run('INSERT INTO pixel_logs (user_id, room_id, x, y, color, action) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, roomId, x, y, color, action]),
  // 注意：LIMIT/OFFSET 已由调用方约束为整数，内联进 SQL（mysql2 execute 对 LIMIT ? 绑定会报 ER_WRONG_ARGUMENTS）
  listUserLogs: (userId, limit, offset) => all(`
    SELECT l.id, l.x, l.y, l.color, l.action,
           DATE_FORMAT(l.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
           r.name AS room_name
    FROM pixel_logs l LEFT JOIN rooms r ON r.id = l.room_id
    WHERE l.user_id = ? ORDER BY l.id DESC LIMIT ${limit} OFFSET ${offset}`,
    [userId]),
  countUserLogs: (userId) => get('SELECT COUNT(*) AS c FROM pixel_logs WHERE user_id = ?', [userId]),
  listLogsAdminView: (where, params, limit, offset) => all(`
    SELECT l.id, l.x, l.y, l.color, l.action,
           DATE_FORMAT(l.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
           r.name AS room_name, u.username AS username
    FROM pixel_logs l
    LEFT JOIN rooms r ON r.id = l.room_id
    LEFT JOIN users u ON u.id = l.user_id
    ${where} ORDER BY l.id DESC LIMIT ${limit} OFFSET ${offset}`,
    params),
  countLogsAdminView: (where, params) => all(`
    SELECT COUNT(*) AS c FROM pixel_logs l
    LEFT JOIN rooms r ON r.id = l.room_id
    LEFT JOIN users u ON u.id = l.user_id
    ${where}`,
    params),

  // sessions
  createSession: (token, userId, kind) =>
    run('INSERT INTO sessions (token, user_id, kind) VALUES (?, ?, ?)', [token, userId, kind]),
  findSession: (token) => get('SELECT * FROM sessions WHERE token = ?', [token]),
  deleteSession: (token) => run('DELETE FROM sessions WHERE token = ?', [token]),
  deleteUserSessions: (userId) => run('DELETE FROM sessions WHERE user_id = ?', [userId]),
};

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

module.exports = { pool, Q, newToken, ADMIN_USER, PUBLIC_ROOM_NAME, initDB, dbGet: get, dbAll: all, dbRun: run };
