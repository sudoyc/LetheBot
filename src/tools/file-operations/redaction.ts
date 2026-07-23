import { redactSecretsInText } from '../../memory/secret-scan.js';

export interface FileOperationRedactionResult {
  text: string;
  redacted: boolean;
}

export function redactFileOperationText(value: string): FileOperationRedactionResult {
  const platformRedacted = redactPlatformIdentifiers(value);
  const secretRedacted = redactSecretsInText(platformRedacted);
  const redacted = redactPlatformIdentifiers(secretRedacted.text);
  const platformMarkerLost = platformRedacted.includes('[REDACTED:platform_id]')
    && !redacted.includes('[REDACTED:platform_id]');
  const text = platformMarkerLost ? `${redacted} [REDACTED:platform_id]` : redacted;

  return {
    text,
    redacted:
      platformRedacted !== value
      || secretRedacted.findings.length > 0
      || redacted !== secretRedacted.text
      || platformMarkerLost,
  };
}

function redactPlatformIdentifiers(value: string): string {
  return value
    .replace(/(?<![A-Za-z0-9])qq-(?:group-)?\d{5,12}(?![A-Za-z0-9])/gi, '[REDACTED:platform_id]')
    .replace(/(?<![A-Za-z0-9])\d{8,12}(?![A-Za-z0-9])/g, '[REDACTED:platform_id]');
}
