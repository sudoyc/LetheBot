/**
 * OneBot Runtime Connection Verification Utility
 *
 * Standalone tool to verify SnowLuma / OneBot connectivity
 */

import { loadNapCatConfig } from '../config/index.js';
import { verifyOneBotConnection } from './deploy-napcat.js';

async function main() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║   OneBot Connection Verification      ║');
  console.log('╚════════════════════════════════════════╝\n');

  try {
    console.log('Loading configuration...');
    const config = loadNapCatConfig();
    console.log(`✓ Configuration loaded`);
    console.log(`  Transport: ${config.transport}`);
    console.log(`  HTTP URL: ${config.httpUrl}`);
    console.log(`  WS URL: ${config.wsUrl}`);
    console.log(`  Token: ${config.token ? '***' + config.token.slice(-4) : '(none)'}`);

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
      console.log(`     curl -X POST ${config.httpUrl}/get_login_info`);
      console.log('  4. Check network connectivity');
      console.log('  5. Verify authentication token if configured');
      process.exit(1);
    }
  } catch (error) {
    console.error('\n✗ Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
