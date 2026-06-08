// PM2 process definitions for the Hostinger VPS. (Guide §3.3)
// Usage:  pm2 start ecosystem.config.js  &&  pm2 save && pm2 startup
module.exports = {
  apps: [
    {
      name: "cara-crm",
      script: "npm",
      args: "start",
      env: { NODE_ENV: "production", PORT: 3000 },
    },
    {
      name: "call-queue-worker",
      script: "npx",
      args: "tsx workers/callQueueWorker.ts",
      env: { NODE_ENV: "production" },
    },
  ],
};
