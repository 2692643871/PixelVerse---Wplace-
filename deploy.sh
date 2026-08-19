#!/bin/bash
# ============================================================
#  像素画布（MySQL 版）— 宝塔面板 一键部署脚本
#  用法：上传源码到 /www/wwwroot/pixel 后执行：
#    cd /www/wwwroot/pixel && bash deploy.sh
# ============================================================
set -e

echo "============================================"
echo "  像素画布 — 一键部署（MySQL）"
echo "============================================"

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"
echo "[1/7] 项目目录: $PROJECT_DIR"

# ---- 2. 安装 npm 依赖（mysql2 为纯 JS，无需编译）----
echo "[2/7] 安装依赖（express / ws / mysql2）..."
if [ ! -d "node_modules" ]; then
    npm install --production --no-audit --no-fund
else
    echo "  ✓ node_modules 已存在，跳过安装（如需重装请先 rm -rf node_modules）"
fi

# ---- 3. 初始化 .env 配置 ----
echo "[3/7] 检查 .env 配置..."
if [ ! -f ".env" ]; then
    cp .env.example .env
    echo "  ✓ 已生成 .env（MySQL 默认 qypixel/qypixel；管理员 admin/admin123）"
    echo "  ⚠ 部署后请修改 .env 中的 ADMIN_PASS 与 MYSQL_PASS 为强密码！"
else
    echo "  ✓ .env 已存在"
fi

# ---- 4. 自动创建 MySQL 数据库与账号（可选）----
# 仅当提供 MYSQL_ROOT_PASS 时执行；否则请手动在宝塔/终端创建。
if [ -n "$MYSQL_ROOT_PASS" ] && command -v mysql &>/dev/null; then
    echo "[4/7] 使用 root 创建数据库与账号..."
    mysql -uroot -p"$MYSQL_ROOT_PASS" <<SQL
CREATE DATABASE IF NOT EXISTS qypixel CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'qypixel'@'localhost' IDENTIFIED BY 'qypixel';
GRANT ALL PRIVILEGES ON qypixel.* TO 'qypixel'@'localhost';
FLUSH PRIVILEGES;
SQL
    echo "  ✓ 数据库 qypixel 与账号 qypixel 已就绪"
else
    echo "[4/7] 跳过 MySQL 初始化（未提供 MYSQL_ROOT_PASS）"
    echo "  ⚠ 请确保已手动创建：数据库 qypixel + 账号 qypixel/'qypixel' + 授权"
fi

# ---- 5. 创建运行目录 ----
mkdir -p data
echo "[5/7] 运行目录就绪"

# ---- 6. 校验数据库连接 ----
echo "[6/7] 校验 MySQL 连接..."
node -e "
const {pool} = require('./db');
pool.query('SELECT 1').then(()=>{console.log('  ✓ MySQL 连接成功');process.exit(0);})
  .catch(e=>{console.error('  ✗ MySQL 连接失败：', e.message); process.exit(1);});
"

# ---- 7. PM2 启动/重启 ----
echo "[7/7] 启动服务..."
if ! command -v pm2 &>/dev/null; then
    echo "  ⚠ 未检测到 pm2，尝试用 node 直接启动..."
    PORT=$(grep '^PORT=' .env | cut -d'=' -f2)
    nohup node server.js > "$PROJECT_DIR/app.log" 2>&1 &
    echo $! > "$PROJECT_DIR/app.pid"
    sleep 2
    if kill -0 $(cat "$PROJECT_DIR/app.pid") 2>/dev/null; then
        echo ""
        echo "============================================"
        echo "  ✅ 部署完成！服务已启动（PID $(cat app.pid)）"
        echo "============================================"
        echo "  访问地址: http://$(hostname -I | awk '{print $1}'):${PORT:-3000}/"
        echo "  管理后台: http://$(hostname -I | awk '{print $1}'):${PORT:-3000}/admin.html"
        echo "  默认账号: admin / admin123"
        echo ""
        echo "  日志查看: tail -f $PROJECT_DIR/app.log"
        echo "  停止服务: kill \$(cat $PROJECT_DIR/app.pid)"
        echo "============================================"
    else
        echo "  ✗ 启动失败，请查看日志: cat $PROJECT_DIR/app.log"
        exit 1
    fi
else
    if pm2 list 2>/dev/null | grep -q "pixel-canvas"; then
        pm2 restart pixel-canvas
        echo "  ✓ 已重启现有进程"
    else
        pm2 start ecosystem.config.js
        echo "  ✓ 已启动新进程"
    fi
    pm2 save 2>/dev/null || true

    PORT=$(grep '^PORT=' .env | cut -d'=' -f2)
    IP=$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')

    echo ""
    echo "============================================"
    echo "  ✅ 部署完成！PM2 守护进程已启动"
    echo "============================================"
    echo "  本地访问: http://localhost:${PORT:-3000}/"
    echo "  外网访问: http://${IP}:${PORT:-3000}/"
    echo "  管理后台: http://${IP}:${PORT:-3000}/admin.html"
    echo "  默认账号: admin / admin123"
    echo ""
    echo "  常用命令:"
    echo "    pm2 status               # 查看状态"
    echo "    pm2 logs pixel-canvas    # 查看日志"
    echo "    pm2 restart pixel-canvas # 重启"
    echo "    pm2 stop pixel-canvas     # 停止"
    echo "============================================"
fi
