import { Buffer } from 'node:buffer';

export const TOOL_OUTPUT_TRUNCATION_MARKER = '[TRUNCATED:tool_output]';

export interface TruncatedToolOutput {
  truncated: true;
  originalBytes: number;
  preview: string;
}

export interface LimitedToolOutput {
  promptText: string;
  durableOutput: unknown;
  truncated: boolean;
}

export const MIN_TOOL_OUTPUT_BYTES = serializedByteLength({
  truncated: true,
  originalBytes: Number.MAX_SAFE_INTEGER,
  preview: TOOL_OUTPUT_TRUNCATION_MARKER,
});

export function limitToolOutput(
  promptText: string,
  durableOutput: unknown,
  maxOutputBytes?: number,
): LimitedToolOutput {
  if (maxOutputBytes === undefined) {
    return { promptText, durableOutput, truncated: false };
  }

  const promptBytes = Buffer.byteLength(promptText, 'utf8');
  const serializedOutput = JSON.stringify(durableOutput);
  const durableBytes = serializedOutput === undefined
    ? 0
    : Buffer.byteLength(serializedOutput, 'utf8');
  const promptTruncated = promptBytes > maxOutputBytes;
  const durableTruncated = durableBytes > maxOutputBytes;

  return {
    promptText: promptTruncated
      ? truncateUtf8WithMarker(promptText, maxOutputBytes)
      : promptText,
    durableOutput: durableTruncated && serializedOutput !== undefined
      ? buildTruncationEnvelope(promptText, durableBytes, maxOutputBytes)
      : durableOutput,
    truncated: promptTruncated || durableTruncated,
  };
}

function truncateUtf8WithMarker(value: string, maxBytes: number): string {
  const markerBytes = Buffer.byteLength(TOOL_OUTPUT_TRUNCATION_MARKER, 'utf8');
  const prefixBudget = maxBytes - markerBytes;
  const parts: string[] = [];
  let usedBytes = 0;

  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (usedBytes + characterBytes > prefixBudget) {
      break;
    }
    parts.push(character);
    usedBytes += characterBytes;
  }

  return `${parts.join('')}${TOOL_OUTPUT_TRUNCATION_MARKER}`;
}

function buildTruncationEnvelope(
  previewSource: string,
  originalBytes: number,
  maxBytes: number,
): TruncatedToolOutput {
  const baseEnvelope: TruncatedToolOutput = {
    truncated: true,
    originalBytes,
    preview: TOOL_OUTPUT_TRUNCATION_MARKER,
  };
  let remainingBytes = maxBytes - serializedByteLength(baseEnvelope);
  const parts: string[] = [];

  for (const character of previewSource) {
    const characterBytes = jsonStringContentByteLength(character);
    if (characterBytes > remainingBytes) {
      break;
    }
    parts.push(character);
    remainingBytes -= characterBytes;
  }

  return {
    ...baseEnvelope,
    preview: `${parts.join('')}${TOOL_OUTPUT_TRUNCATION_MARKER}`,
  };
}

function serializedByteLength(value: unknown): number {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 0 : Buffer.byteLength(serialized, 'utf8');
}

function jsonStringContentByteLength(character: string): number {
  if (character === '"' || character === '\\') {
    return 2;
  }

  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) {
    return 0;
  }

  if (codePoint <= 0x1f) {
    return codePoint === 0x08
      || codePoint === 0x09
      || codePoint === 0x0a
      || codePoint === 0x0c
      || codePoint === 0x0d
      ? 2
      : 6;
  }

  if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
    return 6;
  }

  return Buffer.byteLength(character, 'utf8');
}
