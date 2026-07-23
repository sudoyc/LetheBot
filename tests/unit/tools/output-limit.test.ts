import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  limitToolOutput,
  MIN_TOOL_OUTPUT_BYTES,
  TOOL_OUTPUT_TRUNCATION_MARKER,
} from '../../../src/tools/output-limit';

describe('tool output limit', () => {
  it('leaves prompt and durable output unchanged when both fit', () => {
    const durableOutput = { summary: 'small output', value: 7 };

    const result = limitToolOutput('small output', durableOutput, 128);

    expect(result).toEqual({
      promptText: 'small output',
      durableOutput,
      truncated: false,
    });
    expect(result.durableOutput).toBe(durableOutput);
  });

  it('fits escaped and multibyte output in the minimum truncation envelope', () => {
    const discardedSuffix = 'discarded-suffix';
    const durableOutput = {
      value: `start "\\ ${'界'.repeat(100)} ${discardedSuffix}`,
    };
    const promptText = `start "\\ ${'猫'.repeat(100)} ${discardedSuffix}`;

    const result = limitToolOutput(promptText, durableOutput, MIN_TOOL_OUTPUT_BYTES);
    const serializedResult = JSON.stringify(result.durableOutput);

    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.promptText, 'utf8')).toBeLessThanOrEqual(
      MIN_TOOL_OUTPUT_BYTES,
    );
    expect(Buffer.byteLength(serializedResult, 'utf8')).toBeLessThanOrEqual(
      MIN_TOOL_OUTPUT_BYTES,
    );
    expect(result.promptText).toContain(TOOL_OUTPUT_TRUNCATION_MARKER);
    expect(result.durableOutput).toMatchObject({
      truncated: true,
      originalBytes: Buffer.byteLength(JSON.stringify(durableOutput), 'utf8'),
    });
    expect(serializedResult).toContain(TOOL_OUTPUT_TRUNCATION_MARKER);
    expect(JSON.stringify(result)).not.toContain(discardedSuffix);
    expect(JSON.stringify(result)).not.toMatch(/\uFFFD/u);
  });

  it('bounds prompt and durable representations independently', () => {
    const smallOutput = { summary: 'small output' };
    const promptOnly = limitToolOutput('x'.repeat(200), smallOutput, 128);

    expect(promptOnly.promptText).toContain(TOOL_OUTPUT_TRUNCATION_MARKER);
    expect(promptOnly.durableOutput).toBe(smallOutput);

    const durableOnly = limitToolOutput(
      'small output',
      { payload: 'x'.repeat(200) },
      128,
    );

    expect(durableOnly.promptText).toBe('small output');
    expect(durableOnly.durableOutput).toMatchObject({ truncated: true });
    expect(JSON.stringify(durableOnly.durableOutput)).toContain(
      TOOL_OUTPUT_TRUNCATION_MARKER,
    );
  });
});
