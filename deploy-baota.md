# 像素画布（MySQL 版）— 宝塔面板（Ubuntu）部署指南

本应用是一个 Node.js 服务（Express + WebSocket + MySQL）。源码已适配部署：
- 端口、绑定地址、管理员账号、MySQL 连接均可通过环境变量 / `.env` 配置
- 默认数据库名 / 账号 / 密码均为 **qypixel**
- 服务启动时自动建表并初始化管理员与公共房间，无需手工建表

---

## 一、准备源码

**不要上传 Windows 的 `node_modules/`**（`mysql2` 会在服务器重新安装）。

上传这些文件到 `/www/wwwroot/pixel/`：

```
pixel/
├── server.js / db.js          # 服务与数据库层
├── package.json               # 依赖声明（express / ws / mysql2）
├── package-lock.json          # 可选
├── ecosystem.config.js        # PM2 配置
├── .env.example               # 配置模板
├── deploy.sh                  # 一键部署脚本 ★
├── deploy-baota.md / BT-PM2-GUIDE.md
└── public/                    # 前端（index.html / admin.html / app.js / style.css）
```

---

## 二、安装运行环境（宝塔）

### 1. 安装 MySQL（必须）
宝塔面板 → **软件商店** → 安装 **MySQL 5.7 / 8.0**（任选其一）。
安装后在「数据库」中：
- 创建一个数据库，库名填 **`qypixel`**，字符集 `utf8mb4`
- 创建用户，用户名 **`qypixel`**，密码 **`qypixel`**（或自定义，但需与 `.env` 中 `MYSQL_*` 一致）
- 把该用户授权给 `qypixel` 库（本地 `localhost`）

> 或执行（需 root 密码）：
> ```sql
> CREATE DATABASE IF NOT EXISTS qypixel CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
> CREATE USER IF NOT EXISTS 'qypixel'@'localhost' IDENTIFIED BY 'qypixel';
> GRANT ALL PRIVILEGES ON qypixel.* TO 'qypixel'@'localhost';
> FLUSH PRIVILEGES;
> ```

### 2. 安装 Node 运行时
宝塔 → **软件商店** → 安装 **PM2 管理器**（自带 Node 运行时，推荐 Node 18 / 20 / 22）。
记录 Node 版本，后续 `npm install` 与 `pm2 start` 共用同一版本。

### 3. 安装依赖（mysql2 为纯 JS，无需编译，比 better-sqlite3 更简单）
进入项目目录：
```bash
cd /www/wwwroot/pixel
npm install --production
```

---

## 三、配置

编辑 `.env`（若不存在先 `cp .env.example .env`）：

```ini
PORT=3000
HOST=0.0.0.0
ADMIN_USER=admin
ADMIN_PASS=你的强密码

# MySQL（默认库名/账号/密码均为 qypixel）
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=qypixel
MYSQL_PASS=qypixel
MYSQL_DB=qypixel

# 注册邮箱验证（QQ 邮箱 SMTP）
EMAIL_USER=你的QQ邮箱@qq.com
EMAIL_PASS=你的QQ邮箱授权码   # 设置→账户→开启SMTP服务后获取的授权码，非登录密码
```

- `ADMIN_USER` / `ADMIN_PASS`：仅在数据库首次初始化时创建管理员；库已存在则不会覆盖
- `MYSQL_*`：必须与实际库/账号一致
- `EMAIL_USER` / `EMAIL_PASS`：注册发信使用（QQ 邮箱授权码）。不配置则用源码内置默认（仅限学习）；生产环境务必改为你自己的授权码。**服务器需能访问 smtp.qq.com:465**
- 注册邮箱验证可在管理后台「全局设置 → 需要邮箱验证」开关，关闭后注册无需邮箱

---

## 四、启动（PM2 守护）

```bash
pm2 start ecosystem.config.js
pm2 save
```

或：`pm2 start server.js --name pixel-canvas && pm2 save`。

查看：`pm2 status` / `pm2 logs pixel-canvas`。

---

## 五、对外开放（二选一）

### 方式 A：IP + 端口
宝塔「安全」+ 云厂商安全组放行 `3000`。访问 `http://服务器IP:3000/`。

### 方式 B：域名 + 反向代理 + HTTPS（推荐）
1. 宝塔 → 网站 → 添加站点
2. 站点设置 → 反向代理 → 目标 `http://127.0.0.1:3000`
3. 编辑站点配置，补充 WebSocket 支持：
```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 60s;
}
```
4. SSL 申请并强制 HTTPS。建议把 `.env` 中 `HOST=127.0.0.1`。

---

## 六、开机自启
```bash
pm2 startup
pm2 save
```

---

## 七、升级 / 维护
```bash
cd /www/wwwroot/pixel
git pull   # 或覆盖上传新文件
npm install
pm2 restart pixel-canvas
pm2 save
```
- 数据库在 MySQL 中，升级代码不会丢失用户与画作
- 重置库：在宝塔「数据库」中清空 `qypixel` 库的所有表，重启服务即重新初始化

---

## 八、常见问题

| 现象 | 原因 / 解决 |
|------|-------------|
| 启动报 `ER_ACCESS_DENIED` / `ER_BAD_DB_ERROR` | `.env` 中 `MYSQL_*` 与实际库/账号不符；检查库存在、账号密码、已授权 `localhost` |
| 启动报 `ECONNREFUSED` | MySQL 未运行，或 `MYSQL_HOST/PORT` 写错；宝塔确认 MySQL 已启动 |
| 页面能打开但落子不同步 | Nginx 反向代理缺 WebSocket `Upgrade` 头，按第五节配置 |
| 外网访问不了 | 宝塔「安全」+ 云安全组放行端口；或 `.env` 中 `HOST=0.0.0.0` |
| 管理员密码不对 | 库已存在同名管理员时不会用 `.env` 覆盖；去 `/admin.html` 修改或重置库 |
| `EADDRINUSE` 端口占用 | 另一实例在跑，`pm2 delete pixel-canvas` 或换 `PORT` |
| 画布背景空白 / 无地图 | 底图为高德矢量瓦片（公网加载），服务器需可访问外网 `*.is.autonavi.com`；瓦片不可用时自动降级为内置示意轮廓 |

---

## 九、默认入口
- 作画页：`http://域名或IP:端口/`
- 管理后台：`http://域名或IP:端口/admin.html`（默认 `admin / admin123`，请改强密码）
