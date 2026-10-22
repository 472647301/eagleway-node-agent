const { existsSync } = require('node:fs')
const { join } = require('node:path')
const runtimeNode = join(__dirname, 'runtime/bin/node')
const hasRuntime = existsSync(join(__dirname, 'runtime'))

module.exports = {
  apps: [
    {
      name: 'eagleway-node-agent',
      script: './dist/main.js',
      interpreter: hasRuntime ? runtimeNode : process.execPath,
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      kill_timeout: 15000,
      max_memory_restart: '512M',
      out_file: '/var/log/eagleway-node-agent/agent.log',
      error_file: '/var/log/eagleway-node-agent/agent-error.log',
      merge_logs: true,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
}
