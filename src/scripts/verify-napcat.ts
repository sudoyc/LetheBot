/**
 * OneBot Runtime Connection Verification Utility
 *
 * Standalone tool to verify SnowLuma / OneBot connectivity
 */

import { loadNapCatConfig } from '../config/index.js';
import { redactSecretsInText } from '../memory/secret-scan.js';
import { verifyOneBotConnection } from './deploy-napcat.js';

function redactForDisplay(value: string): string {
  const platformRedacted = redactPlatformIdentifiers(value);
  const secretRedacted = redactSecretsInText(platformRedacted).text;
  const redacted = redactPlatformIdentifiers(secretRedacted);
  const platformMarkerLost =
    platformRedacted.includes('[REDACTED:platform_id]')
    && !redacted.includes('[REDACTED:platform_id]');

  return platformMarkerLost ? `${redacted} [REDACTED:platform_id]` : redacted;
}

function redactPlatformIdentifiers(value: string): string {
  return value
    .replace(/(?<![A-Za-z0-9])qq-(?:group-)?\d{5,12}(?![A-Za-z0-9])/gi, '[REDACTED:platform_id]')
    .replace(/(?<![A-Za-z0-9])\d{8,12}(?![A-Za-z0-9])/g, '[REDACTED:platform_id]');
}

function display(value: unknown): string {
  return redactForDisplay(value instanceof Error ? value.message : String(value));
}

async function main() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║   OneBot Connection Verification      ║');
  console.log('╚════════════════════════════════════════╝\n');

  try {
    console.log('Loading configuration...');
    const config = loadNapCatConfig();
    console.log(`✓ Configuration loaded`);
    console.log(`  Transport: ${config.transport}`);
    console.log(`  HTTP URL: ${redactForDisplay(config.httpUrl)}`);
    console.log(`  WS URL: ${redactForDisplay(config.wsUrl)}`);
    console.log(`  Token: ${config.token ? '[REDACTED:token_present]' : '(none)'}`);

    console.log('\nVerifying connection...');
    const isConnected = await verifyOneBotConnection(config);

    console.log('\n' + '═'.repeat(42));
    if (isConnected) {
      console.log('✓ OneBot runtime connection successful');
      console.log('\nYou can now deploy LetheBot with:');
      console.log('  pnpm run deploy:docker');
      console.log('  pnpm run deploy:systemd');
      console.log('  pnpm run deploy:pm2');
      process.exit(0);
    } else {
      console.log('✗ OneBot runtime connection failed');
      console.log('\nTroubleshooting:');
      console.log('  1. Check if SnowLuma / OneBot runtime is running');
      console.log('  2. Verify ONEBOT_TRANSPORT / ONEBOT_WS_URL / ONEBOT_HTTP_URL in .env');
      console.log('  3. HTTP test manually:');
      console.log(`     curl -X POST ${redactForDisplay(config.httpUrl)}/get_login_info`);
      console.log('  4. Check network connectivity');
      console.log('  5. Verify authentication token if configured');
      process.exit(1);
    }
  } catch (error) {
    console.error('\n✗ Error:', display(error));
    process.exit(1);
  }
}

main();
