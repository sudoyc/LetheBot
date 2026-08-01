import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  DisplayProfileRedactionSnapshot,
  DisplayProfileScope,
  PlatformAccountUnlinkPreviewProjection,
  PlatformAccountUnlinkSnapshot,
} from './query-contracts.js';

const DISPLAY_PROFILE_TARGET_RESOURCE_ID_DOMAIN =
  'lethebot-governance:display-profile-target-resource:v1\0';
const DISPLAY_PROFILE_REDACTION_SNAPSHOT_FINGERPRINT_DOMAIN =
  'lethebot-governance:display-profile-redaction-snapshot:v1\0';
const PLATFORM_ACCOUNT_UNLINK_SNAPSHOT_FINGERPRINT_DOMAIN =
  'lethebot-governance:platform-account-unlink-snapshot:v1\0';
const NORMALIZED_QQ_PLATFORM_ACCOUNT_ID_PATTERN = /^[1-9][0-9]{4,11}$/u;
const MAX_JAVASCRIPT_DATE_MS = 8_640_000_000_000_000;

interface DisplayProfileRedactionSnapshotProfileRow {
  current_display_name_type: string;
  current_display_name_hex: string;
  observed_at_type: string;
  observed_at_hex: string;
  trust_type: string;
  trust_hex: string;
}

interface DisplayProfileRedactionSnapshotHistoryRow {
  history_id_type: string;
  history_id_hex: string;
  display_name_type: string;
  display_name_hex: string;
  observed_at_type: string;
  observed_at_hex: string;
  observed_until_type: string;
  observed_until_hex: string;
}

interface PlatformAccountUnlinkPreviewRow {
  platform: unknown;
  platform_account_id: unknown;
  canonical_user_id: unknown;
  account_type: unknown;
  verified_level: unknown;
  status: unknown;
  first_seen_at: unknown;
  last_seen_at: unknown;
  platform_type: unknown;
  platform_hex: unknown;
  platform_account_id_type: unknown;
  platform_account_id_hex: unknown;
  canonical_user_id_type: unknown;
  canonical_user_id_hex: unknown;
  account_type_type: unknown;
  account_type_hex: unknown;
  verified_level_type: unknown;
  verified_level_hex: unknown;
  status_type: unknown;
  status_hex: unknown;
  first_seen_at_type: unknown;
  first_seen_at_hex: unknown;
  last_seen_at_type: unknown;
  last_seen_at_hex: unknown;
}

export type PlatformAccountUnlinkSnapshotReadResult =
  | {
    outcome: 'found';
    canonicalUserId: string;
    accountType: PlatformAccountUnlinkPreviewProjection['account']['accountType'];
    verifiedLevel: PlatformAccountUnlinkPreviewProjection['account']['verifiedLevel'];
    firstSeenAt: number;
    lastSeenAt: number;
    snapshot: PlatformAccountUnlinkSnapshot;
  }
  | { outcome: 'not_found' | 'invalid' };

export function readPlatformAccountUnlinkSnapshot(
  db: Database.Database,
  input: {
    platform: 'qq';
    platformAccountId: string;
  },
): PlatformAccountUnlinkSnapshotReadResult {
  if (
    input.platform !== 'qq'
    || typeof input.platformAccountId !== 'string'
    || !NORMALIZED_QQ_PLATFORM_ACCOUNT_ID_PATTERN.test(input.platformAccountId)
  ) {
    return { outcome: 'invalid' };
  }
  const row = db.prepare(
    `SELECT platform,
            platform_account_id,
            canonical_user_id,
            account_type,
            verified_level,
            status,
            first_seen_at,
            last_seen_at,
            typeof(platform) AS platform_type,
            hex(platform) AS platform_hex,
            typeof(platform_account_id) AS platform_account_id_type,
            hex(platform_account_id) AS platform_account_id_hex,
            typeof(canonical_user_id) AS canonical_user_id_type,
            hex(canonical_user_id) AS canonical_user_id_hex,
            typeof(account_type) AS account_type_type,
            hex(account_type) AS account_type_hex,
            typeof(verified_level) AS verified_level_type,
            hex(verified_level) AS verified_level_hex,
            typeof(status) AS status_type,
            hex(status) AS status_hex,
            typeof(first_seen_at) AS first_seen_at_type,
            hex(first_seen_at) AS first_seen_at_hex,
            typeof(last_seen_at) AS last_seen_at_type,
            hex(last_seen_at) AS last_seen_at_hex
       FROM platform_accounts
      WHERE platform = ? AND platform_account_id = ?
      LIMIT 1`,
  ).get(input.platform, input.platformAccountId) as
    PlatformAccountUnlinkPreviewRow | undefined;
  if (!row) {
    return { outcome: 'not_found' };
  }
  if (row.status === 'disabled' || row.status === 'deleted') {
    return { outcome: 'not_found' };
  }

  const accountType = ['private', 'group_member', 'temp_session'].find(
    (candidate) => candidate === row.account_type,
  ) as PlatformAccountUnlinkPreviewProjection['account']['accountType'] | undefined;
  const verifiedLevel = ['observed', 'self_claimed', 'owner_verified'].find(
    (candidate) => candidate === row.verified_level,
  ) as PlatformAccountUnlinkPreviewProjection['account']['verifiedLevel'] | undefined;
  const canonicalUserCharacters = typeof row.canonical_user_id === 'string'
    ? Array.from(row.canonical_user_id)
    : [];
  const storageTypes = [
    row.platform_type,
    row.platform_account_id_type,
    row.canonical_user_id_type,
    row.account_type_type,
    row.verified_level_type,
    row.status_type,
    row.first_seen_at_type,
    row.last_seen_at_type,
  ];
  const storageHexValues = [
    row.platform_hex,
    row.platform_account_id_hex,
    row.canonical_user_id_hex,
    row.account_type_hex,
    row.verified_level_hex,
    row.status_hex,
    row.first_seen_at_hex,
    row.last_seen_at_hex,
  ];
  if (
    row.platform !== 'qq'
    || row.platform_account_id !== input.platformAccountId
    || typeof row.canonical_user_id !== 'string'
    || row.canonical_user_id.trim() !== row.canonical_user_id
    || canonicalUserCharacters.length < 1
    || canonicalUserCharacters.length > 256
    || !canonicalUserCharacters.every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint === undefined || (codePoint > 31 && codePoint !== 127);
    })
    || !accountType
    || !verifiedLevel
    || row.status !== 'active'
    || typeof row.first_seen_at !== 'number'
    || !Number.isSafeInteger(row.first_seen_at)
    || row.first_seen_at < 0
    || row.first_seen_at > MAX_JAVASCRIPT_DATE_MS
    || typeof row.last_seen_at !== 'number'
    || !Number.isSafeInteger(row.last_seen_at)
    || row.last_seen_at < row.first_seen_at
    || row.last_seen_at > MAX_JAVASCRIPT_DATE_MS
    || row.platform_type !== 'text'
    || row.platform_account_id_type !== 'text'
    || row.canonical_user_id_type !== 'text'
    || row.account_type_type !== 'text'
    || row.verified_level_type !== 'text'
    || row.status_type !== 'text'
    || row.first_seen_at_type !== 'integer'
    || row.last_seen_at_type !== 'integer'
    || !storageTypes.every((value) => typeof value === 'string')
    || !storageHexValues.every((value) => (
      typeof value === 'string' && /^(?:[0-9A-F]{2})+$/u.test(value)
    ))
  ) {
    return { outcome: 'invalid' };
  }

  const storageFields = storageTypes.flatMap((type, index) => [
    type,
    storageHexValues[index],
  ]);
  return {
    outcome: 'found',
    canonicalUserId: row.canonical_user_id,
    accountType,
    verifiedLevel,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    snapshot: {
      snapshotFingerprint: createHash('sha256')
        .update(PLATFORM_ACCOUNT_UNLINK_SNAPSHOT_FINGERPRINT_DOMAIN, 'utf8')
        .update(JSON.stringify(storageFields), 'utf8')
        .digest('hex'),
    },
  };
}

export type DisplayProfileRedactionSnapshotReadResult =
  | { outcome: 'found'; snapshot: DisplayProfileRedactionSnapshot }
  | { outcome: 'not_found' | 'invalid' };

export function deriveDisplayProfileTargetResourceId(
  scope: DisplayProfileScope,
  sourceGroupId: string,
): string {
  return createHash('sha256')
    .update(DISPLAY_PROFILE_TARGET_RESOURCE_ID_DOMAIN, 'utf8')
    .update(JSON.stringify({
      canonicalUserId: scope.canonicalUserId,
      sourceGroupId,
    }), 'utf8')
    .digest('hex');
}

export function readDisplayProfileRedactionSnapshot(
  db: Database.Database,
  input: {
    scope: DisplayProfileScope;
    sourceGroupId: string;
    targetId: string;
  },
): DisplayProfileRedactionSnapshotReadResult {
  const snapshotHash = createHash('sha256')
    .update(DISPLAY_PROFILE_REDACTION_SNAPSHOT_FINGERPRINT_DOMAIN, 'utf8')
    .update(input.targetId, 'utf8');
  let displayProfileRows = 0;
  const profileRows = db.prepare(
    `SELECT typeof(current_display_name) AS current_display_name_type,
            hex(current_display_name) AS current_display_name_hex,
            typeof(observed_at) AS observed_at_type,
            hex(observed_at) AS observed_at_hex,
            typeof(trust) AS trust_type,
            hex(trust) AS trust_hex
       FROM display_profiles
      WHERE canonical_user_id = ?
        AND source_group_id = ?`,
  ).iterate(
    input.scope.canonicalUserId,
    input.sourceGroupId,
  ) as Iterable<DisplayProfileRedactionSnapshotProfileRow>;
  for (const row of profileRows) {
    if (displayProfileRows === Number.MAX_SAFE_INTEGER) {
      return { outcome: 'invalid' };
    }
    displayProfileRows += 1;
    snapshotHash
      .update('\0display_profile\0', 'utf8')
      .update(JSON.stringify([
        row.current_display_name_type,
        row.current_display_name_hex,
        row.observed_at_type,
        row.observed_at_hex,
        row.trust_type,
        row.trust_hex,
      ]), 'utf8');
  }

  let nicknameHistoryRows = 0;
  let openNicknameHistoryRows = 0;
  const historyRows = db.prepare(
    `SELECT typeof(id) AS history_id_type,
            hex(id) AS history_id_hex,
            typeof(display_name) AS display_name_type,
            hex(display_name) AS display_name_hex,
            typeof(observed_at) AS observed_at_type,
            hex(observed_at) AS observed_at_hex,
            typeof(observed_until) AS observed_until_type,
            hex(observed_until) AS observed_until_hex
       FROM nickname_history
      WHERE canonical_user_id = ?
        AND source_group_id = ?
      ORDER BY history_id_type ASC, history_id_hex ASC`,
  ).iterate(
    input.scope.canonicalUserId,
    input.sourceGroupId,
  ) as Iterable<DisplayProfileRedactionSnapshotHistoryRow>;
  for (const row of historyRows) {
    if (
      nicknameHistoryRows === Number.MAX_SAFE_INTEGER
      || (row.observed_until_type === 'null'
        && openNicknameHistoryRows === Number.MAX_SAFE_INTEGER)
    ) {
      return { outcome: 'invalid' };
    }
    nicknameHistoryRows += 1;
    if (row.observed_until_type === 'null') {
      openNicknameHistoryRows += 1;
    }
    snapshotHash
      .update('\0nickname_history\0', 'utf8')
      .update(JSON.stringify([
        row.history_id_type,
        row.history_id_hex,
        row.display_name_type,
        row.display_name_hex,
        row.observed_at_type,
        row.observed_at_hex,
        row.observed_until_type,
        row.observed_until_hex,
      ]), 'utf8');
  }

  const total = displayProfileRows + nicknameHistoryRows;
  if (!Number.isSafeInteger(total)) {
    return { outcome: 'invalid' };
  }
  if (total < 1) {
    return { outcome: 'not_found' };
  }
  return {
    outcome: 'found',
    snapshot: {
      displayProfileRows,
      nicknameHistoryRows,
      openNicknameHistoryRows,
      snapshotFingerprint: snapshotHash.digest('hex'),
    },
  };
}
