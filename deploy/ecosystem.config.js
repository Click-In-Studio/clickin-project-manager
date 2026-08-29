// pm2 进程定义——CD 每次发布把本文件复制到服务器 shared/ecosystem.config.js 后
// `pm2 reload <file> --update-env`（deploy.yml「Activate release」）。
// 之前这份配置只存在于服务器上（手工维护）；收进仓库后增删进程走 PR。
//
// 开关类 env（AGENT_RUNTIME / AGENT_RUNNER_URL / 各类 key）一律放 shared/.env.local，
// 这里只放端口这类"进程定义"的东西——node --env-file 不覆盖已存在的进程 env，
// 写在这里的值 .env.local 就改不动，回滚会多一次发布。
module.exports = {
  apps: [
    {
      // AI 运行时独立进程（#367，docs/AGENT_RUNTIME.md）。放在前面：pm2 按文件顺序
      // 处理，先把 runner 拉起/换新，再 reload next——next 拿到 AGENT_RUNNER_URL 时对端已在。
      name: 'agent-runner',
      script: '/var/www/production-manager/current/agent-runner.js',
      cwd: '/var/www/production-manager/current',   // base prompt 六件套按 process.cwd()/openclaw-workspace 读
      node_args: '--env-file=/var/www/production-manager/shared/.env.local',
      // cluster 模式（单实例）才有真正的零停机 reload：新进程 ready 后才向旧进程发 SIGTERM；
      // fork 模式的 reload 等于 restart——旧进程排水期间（最长 10 分钟）没有人接请求。
      exec_mode: 'cluster',
      instances: 1,
      env: {
        NODE_ENV: 'production',
        AGENT_RUNNER_PORT: 3102,
      },
      wait_ready: true,        // 进程 listen 后 process.send("ready")
      listen_timeout: 30000,
      kill_timeout: 660000,    // ≥ AGENT_DRAIN_TIMEOUT_MS(600000) + 余量：SIGTERM 后给足排水时间
      max_memory_restart: '600M',
      out_file: '/var/log/pm2/agent-runner.log',
      error_file: '/var/log/pm2/agent-runner-error.log',
      merge_logs: true,
    },
    {
      name: 'production-manager',
      script: '/var/www/production-manager/current/server.js',
      node_args: '--env-file=/var/www/production-manager/shared/.env.local',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        HOSTNAME: '0.0.0.0',
      },
      max_memory_restart: '1G',
      // Keep stdout/stderr logs
      out_file: '/var/log/pm2/production-manager.log',
      error_file: '/var/log/pm2/production-manager-error.log',
      merge_logs: true,
    },
  ],
};
