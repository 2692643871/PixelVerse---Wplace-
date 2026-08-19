// PM2 进程守护配置
// 用法：pm2 start ecosystem.config.js
// 升级后：拉取新代码 -> npm install -> pm2 restart pixel-canvas -> pm2 save
module.exports = {
  apps: [
    {
      name: 'pixel-canvas',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
