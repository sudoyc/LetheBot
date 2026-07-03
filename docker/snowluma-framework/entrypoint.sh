#!/usr/bin/env bash
set -euo pipefail

SNOWLUMA_DATA="${SNOWLUMA_DATA:-/app/snowluma-data}"
CONFIG_DIR="${SNOWLUMA_DATA}/config"
ONEBOT_CONFIG="${CONFIG_DIR}/onebot.json"

mkdir -p "${CONFIG_DIR}"

if [[ "${SNOWLUMA_FRAMEWORK_OVERWRITE_WEBUI_CONFIG:-0}" == "1" ]]; then
  rm -f "${CONFIG_DIR}/webui.json"
  echo 'Removed SnowLuma WebUI auth config; it will be reseeded on startup.'
fi

if [[ ! -f "${ONEBOT_CONFIG}" || "${SNOWLUMA_FRAMEWORK_OVERWRITE_ONEBOT_CONFIG:-0}" == "1" ]]; then
  node --input-type=module <<'NODE'
import fs from 'node:fs';
import path from 'node:path';

const dataDir = process.env.SNOWLUMA_DATA || '/app/snowluma-data';
const configDir = path.join(dataDir, 'config');
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

fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(path.join(configDir, 'onebot.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
NODE
  echo 'Seeded SnowLuma Framework OneBot config with configured access token.'
else
  echo 'Keeping existing SnowLuma Framework OneBot config.'
fi

exec /root/start.sh
