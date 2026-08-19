# PixelVerse‑Wplace
> 仿 r/place 多人在线像素涂鸦网页程序，复刻大规模集体画布涂鸦玩法，支持多人实时共同绘制像素，全部代码由 AI 开发。
![项目演示截图](PixPin_2026-08-19_21-30-53.png)
## 📖 项目介绍
PixelVerse‑Wplace 是一款模仿 Wplace / Reddit r/place 的多人在线像素画布项目。
多人可以在同一张巨大画布上自由放置像素方块，实时同步所有人的绘画操作，一起共创像素画作。

- ✨ 多人实时在线，像素操作全网同步
- 🖼️ 超大画布，自由涂鸦创作
- 🚀 轻量 Node.js 后端，部署简单快速
- 📦 开箱即用，少量依赖，快速搭建私有涂鸦画布

## 🛠️ 环境要求
- Node.js 推荐 v20.20.2
- npm 包管理器

## 📥 安装部署
### 1. 拉取代码
```bash
git clone 你的仓库地址
cd PixelVerse---Wplace
```

### 2. 安装依赖
```bash
npm install
```

### 3. 启动服务
```bash
node server.js
```

### 4. 访问网页
```bash
你的服务器ip:3000
```

服务启动成功后，访问浏览器打开对应地址即可进入像素涂鸦画布。

## 📁 项目结构
```
PixelVerse---Wplace‑
├─ public/     #前端文件
│  ├─ admin.html
│  ├─ index.html
│  ├─ app.js
│  ├─ style.css
│  └─ world.js
├─ LICENSE
├─ README.md
├─ db.js
├─ server.js
└─ 其他部署文档
```

## 🚀 服务器部署
### 方式1：直接后台运行
```bash
node server.js
```

### 方式2：PM2 守护进程（推荐生产环境）
```bash
# 安装pm2
npm install pm2 -g
# 启动项目
pm2 start ecosystem.config.js
# 设置开机自启
pm2 startup
pm2 save
```

### 方式3：宝塔面板部署
参考文档：`deploy‑baota.md`

## 📝 注意事项
1. 默认端口可在 `server.js` 内修改，注意服务器安全组放行端口
2. 画布数据会持久化保存，重启服务不会丢失像素画面
3. 公网部署建议配置反向代理 + SSL证书实现 HTTPS 访问

## 📄 License
MIT

---
如果你需要，我还可以帮你补充：使用说明、常见问题FAQ、截图占位、功能待办列表。
这个是网页服务项目，工作任务模式更适合做页面修改、调参和问题排查，要不要用它继续？
