# 宝塔 PM2 一键部署 — 界面填法 + 脚本部署

## 方式 A：一键脚本（推荐，最简单）

在宝塔「终端」里执行：

```bash
cd /www/wwwroot/pixel && bash deploy.sh
```

一条命令完成全部：装编译依赖 → npm install → 生成 .env → PM2 启动。

---

## 方式 B：宝塔 PM2 项目管理器界面（对照截图填）

打开 **PM2管理器** → 点击 **添加项目**，按以下值填写：

| 字段 | 填写内容 | 说明 |
|------|---------|------|
| **启动模式** | `PM2模式` | 已选中 ✓ |
| **项目路径** | `/www/wwwroot/pixel` | 你上传源码的目录 |
| **项目名称** | `pixel-canvas` | PM2 进程名，自定义即可 |
| **启动文件** | `server.js` | ⚠ 填这个，不要留空 |
| **Node版本** | `20.4.0` 或你安装的版本 | 必须与系统 Node 一致 |
| **包管理器** | `npm` | 默认即可 |
| **运行目录** | **选「安装 node_modules」** | ⚠ 关键！需在服务器安装 express / ws / mysql2 依赖 |

> 如果界面没有「安装 node_modules」选项，则先在终端手动执行：
> ```bash
> cd /www/wwwroot/pixel
> npm install --production
> ```
> 然后再回界面添加项目，此时选「不安装 node_modules」也可以。
>
> 注意：项目使用 MySQL（非 SQLite），请务必先在宝塔「数据库」中创建库 `qypixel`、账号 `qypixel` / 密码 `qypixel`，并在 `.env` 中填好 `MYSQL_*`，否则服务启动会因连不上数据库而退出。

填好后点 **提交/确定** 即可。

---

## 部署后必做

1. **修改管理员密码**：编辑 `.env` 文件中的 `ADMIN_PASS`
2. **放行端口**：宝塔「安全」→ 放行 `.env` 中配置的 PORT（默认 3000）
3. **云厂商安全组**：在阿里云/腾讯云控制台也放行该端口
4. （可选）加域名反向代理 + SSL，见 `deploy-baota.md` 第五节

---

## 文件上传清单

上传到服务器 `/www/wwwroot/pixel/` 的文件：

```
pixel/
├── server.js              # 主服务
├── db.js                  # 数据库层（含 .env 加载器）
├── package.json           # 依赖声明
├── package-lock.json      # 锁定版本（可选但推荐）
├── ecosystem.config.js    # PM2 配置
├── .env.example           # 配置模板
├── deploy.sh              # 一键部署脚本 ★
├── deploy-baota.md        # 完整部署文档
└── public/                # 前端文件
    ├── index.html         # 作画页
    ├── admin.html         # 管理后台
    ├── app.js             # 前端逻辑
    └── style.css          # 样式
```

⚠ **不要上传**：`node_modules/`、`data/`、`.env`、`*.log`
