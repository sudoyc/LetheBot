#!/bin/sh
set -eu

cd /snowluma
mkdir -p config data logs

if [ ! -f config/onebot.json ] || [ "${SNOWLUMA_ACCEPTANCE_OVERWRITE_ONEBOT_CONFIG:-0}" = "1" ]; then
  node --input-type=module <<'NODE'
import fs from 'node:fs';

const accessToken = process.env.ONEBOT_TOKEN || 'lethebot-local-token';

const config = {
  networks: {
    httpServers: [
      {
        name: 'http-default',
        host: '0.0.0.0',
        port: 3000,
        path: '/',
        accessToken,
        messageFormat: 'array',
        reportSelfMessage: false,
      },
    ],
    httpClients: [],
    wsServers: [
      {
        name: 'ws-default',
        host: '0.0.0.0',
        port: 3001,
        path: '/',
        role: 'Universal',
        accessToken,
        messageFormat: 'array',
        reportSelfMessage: false,
      },
    ],
    wsClients: [],
  },
  statusCommand: {
    enabled: true,
    swallow: false,
    cooldownSeconds: 5,
    trigger: '#sl',
  },
  notifications: { channelIds: [] },
};

fs.mkdirSync('config', { recursive: true });
fs.writeFileSync('config/onebot.json', `${JSON.stringify(config, null, 2)}\n`, 'utf8');
NODE
  echo 'Seeded SnowLuma OneBot config for local acceptance.'
else
  echo 'Keeping existing SnowLuma OneBot config.'
fi

exec "$@"
