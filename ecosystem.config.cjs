module.exports = {
  apps: [
    {
      name: 'eagleway-node-agent',
      script: './dist/main.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      kill_timeout: 15000,
      max_memory_restart: '512M',
      time: true,
      out_file: '/var/log/eagleway-node-agent/agent.log',
      error_file: '/var/log/eagleway-node-agent/agent-error.log',
      merge_logs: true,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
}
