# Troubleshooting Guide

Common issues and practical solutions for LetheBot.

## OneBot Connection Problems

### Check SnowLuma / OneBot Status

```bash
# Check if SnowLuma is running
ps aux | grep -i snowluma

# Check SnowLuma logs
tail -f /path/to/snowluma/logs/latest.log

# Test OneBot HTTP API endpoint
curl -X POST http://localhost:3000/get_login_info
```

Expected response:
```json
{
  "status": "ok",
  "retcode": 0,
  "data": {
    "user_id": 123456789,
    "nickname": "BotName"
  }
}
```

### Port Configuration

Check that the transport and port in your `.env` match SnowLuma's configuration:

```bash
# In LetheBot .env
grep -E 'ONEBOT_TRANSPORT|ONEBOT_WS_URL|ONEBOT_HTTP_URL' .env
# ONEBOT_TRANSPORT=ws uses ONEBOT_WS_URL; ONEBOT_TRANSPORT=http uses ONEBOT_HTTP_URL.

# Test HTTP port when using HTTP API
nc -zv localhost 3000
```

If port is in use:
```bash
# Find what's using the port
lsof -i :3000

# Change port in both SnowLuma config and LetheBot .env
```

### Test with curl

```bash
# Send a test message
curl -X POST http://localhost:3000/send_private_msg \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": 123456789,
    "message": "test"
  }'

# Get friend list
curl -X POST http://localhost:3000/get_friend_list

# Get group list
curl -X POST http://localhost:3000/get_group_list
```

## Pi API Call Failures

### API Key Location

```bash
# Check if API key is set
grep PI_API_KEY .env

# Verify key format (should start with sk- for OpenAI-compatible)
cat .env | grep PI_API_KEY
```

If missing:
```bash
echo "PI_API_KEY=sk-your-key-here" >> .env
```

### Model Configuration

**Using DeepSeek:**
```bash
# .env should have:
PI_API_KEY=sk-your-deepseek-key
PI_BASE_URL=https://api.deepseek.com
PI_MODEL=deepseek-chat
```

Test:
```bash
curl https://api.deepseek.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-key" \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "test"}]
  }'
```

**Using OpenAI:**
```bash
# .env should have:
PI_API_KEY=sk-your-openai-key
PI_BASE_URL=https://api.openai.com/v1
PI_MODEL=gpt-4o-mini
```

### baseUrl Format

Common mistakes:
```bash
# ❌ Wrong
PI_BASE_URL=https://api.deepseek.com/v1/chat/completions

# ✅ Correct
PI_BASE_URL=https://api.deepseek.com

# ❌ Wrong (trailing slash)
PI_BASE_URL=https://api.deepseek.com/

# ✅ Correct
PI_BASE_URL=https://api.deepseek.com
```

Test API connection:
```bash
# From project root
pnpm tsx tests/test-pi-api.ts
```

## Database Errors

### Path Configuration

```bash
# Check database path in .env
grep DB_PATH .env

# Verify directory exists and is writable
ls -la data/
touch data/test.txt && rm data/test.txt
```

If permission denied:
```bash
chmod 755 data/
chmod 644 data/lethebot.db
```

### Migration Issues

```bash
# Check current schema
sqlite3 data/lethebot.db ".schema"

# If schema is wrong, reset database
rm data/lethebot.db
pnpm run migrate

# Verify migrations ran
sqlite3 data/lethebot.db "SELECT name FROM sqlite_master WHERE type='table';"
```

Expected tables:
- `conversations`
- `messages`
- `memory_entries`
- `memory_mentions`

### Permission Problems

```bash
# Check file permissions
ls -la data/lethebot.db

# Fix permissions
chmod 644 data/lethebot.db

# If using systemd service, check user
ps aux | grep lethebot
# Database should be writable by that user
```

## Test Failures

### Clear Cache

```bash
# Remove build artifacts
rm -rf dist/

# Clear Vitest cache
rm -rf node_modules/.vitest/

# Clear TypeScript build info
rm -rf tsconfig.tsbuildinfo

# Reinstall dependencies
pnpm install
```

### Dependency Re-install

```bash
# Remove node_modules and lockfile
rm -rf node_modules/ pnpm-lock.yaml

# Clean pnpm cache
pnpm store prune

# Fresh install
pnpm install

# Rebuild if needed
pnpm run build
```

### Run Tests in Isolation

```bash
# Run specific test file
pnpm test tests/unit/memory.test.ts

# Run with verbose output
pnpm test --reporter=verbose

# Run in watch mode
pnpm test --watch

# Run without coverage
pnpm test --coverage=false
```

### Common Test Issues

**Error: "Cannot find module"**
```bash
# Rebuild TypeScript
pnpm run build

# Check tsconfig paths
cat tsconfig.json | grep paths
```

**Error: "Database locked"**
```bash
# Close any open connections
pkill -f lethebot

# Remove lock file if exists
rm data/lethebot.db-journal

# Use in-memory database for tests (check vitest.config.ts)
```

## Message Sending Failures

### Check OneBot API Response

```bash
# Enable debug logging in .env
LOG_LEVEL=debug

# Run bot and watch logs
pnpm start | tee bot.log

# Check for API errors
grep -i error bot.log
grep -i "send_private_msg" bot.log
```

### Verify Conversation ID Format

```bash
# Query database for conversation
sqlite3 data/lethebot.db "SELECT * FROM conversations WHERE platform_conversation_id='123456789';"

# Check message records
sqlite3 data/lethebot.db "SELECT * FROM messages ORDER BY created_at DESC LIMIT 10;"
```

Conversation ID should match:
- Private chat: QQ user ID (number)
- Group chat: Group ID (number)

### Test Message Sending Manually

```bash
# Send test message via OneBot API
curl -X POST http://localhost:3000/send_private_msg \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": 123456789,
    "message": "Manual test"
  }'

# Check response
# retcode should be 0
# data.message_id should be present
```

### Common OneBot Error Codes

- `retcode: 100` - API call format error
- `retcode: 200` - OneBot API error (check NapCat logs)
- `retcode: 1400` - No such user/group
- `retcode: 1404` - Message send failed (rate limit, blocked, etc.)

Check NapCat documentation for complete error code list.

## Environment Setup Issues

### Missing .env File

```bash
# Copy example
cp .env.example .env

# Edit required fields
nano .env
```

Required variables:
- `ONEBOT_PORT`
- `PI_API_KEY`
- `PI_BASE_URL`
- `PI_MODEL`
- `DB_PATH`

### TypeScript Build Errors

```bash
# Check TypeScript version
pnpm list typescript

# Rebuild
pnpm run build

# Check for type errors
pnpm run typecheck
```

### Runtime Import Errors

```bash
# Ensure all dependencies are installed
pnpm install

# Check package.json type field
grep '"type"' package.json
# Should be "module" for ESM

# Verify file extensions in imports
# Should use .js not .ts in compiled output
```

## Performance Issues

### Slow Pi API Responses

```bash
# Test API latency
time curl https://api.deepseek.com/v1/chat/completions \
  -H "Authorization: Bearer $PI_API_KEY" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}]}'

# Enable request logging
LOG_LEVEL=debug pnpm start
```

Consider:
- Using faster model (e.g., `deepseek-chat` vs `gpt-4`)
- Reducing max tokens in prompt
- Caching frequent queries

### Database Slowdown

```bash
# Check database size
ls -lh data/lethebot.db

# Analyze database
sqlite3 data/lethebot.db "ANALYZE;"

# Vacuum to reclaim space
sqlite3 data/lethebot.db "VACUUM;"

# Check for missing indexes
sqlite3 data/lethebot.db ".schema" | grep -i index
```

## Getting More Help

1. Check logs with `LOG_LEVEL=debug`
2. Search existing issues on GitHub
3. Provide full error messages when reporting
4. Include relevant config (redact API keys)
5. Share minimal reproduction steps
