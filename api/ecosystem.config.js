// PM2 설정 — Windows 서버에서 `pm2 start ecosystem.config.js` 로 기동.
// 포트·SMTP 등 실제 값은 같은 폴더의 .env 에서 읽는다 (server.js 가 dotenv 로 로드).
// NODE_ENV=production 이 여기서 고정된다 → .env 에 TURNSTILE_SECRET 이 없으면 서버가 기동을 거부한다(exit 1).
const path = require('path');

module.exports = {
  apps: [
    {
      name: 'enclu-contact-api',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '200M',
      restart_delay: 3000,
      env: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || 3200
      },
      out_file: path.join(__dirname, 'logs', 'out.log'),
      error_file: path.join(__dirname, 'logs', 'error.log'),
      merge_logs: true,
      time: true
    }
  ]
};
