/**
 * Unit Test: Persona Builder
 *
 * 验证 system prompt 动态生成
 */

import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../../../src/context/persona.js';

describe('Persona Builder', () => {
  it('should generate group chat system prompt', () => {
    const prompt = buildSystemPrompt({
      conversationType: 'group',
      hasMemorySystem: true,
    });

    expect(prompt).toContain('LetheBot');
    expect(prompt).toContain('记忆能力');
    expect(prompt).toContain('群聊风格');
    expect(prompt).toContain('简短自然');
    expect(prompt).toContain('最多 30 字');
    expect(prompt).not.toContain('私聊风格');
  });

  it('should generate private chat system prompt', () => {
    const prompt = buildSystemPrompt({
      conversationType: 'private',
      hasMemorySystem: true,
    });

    expect(prompt).toContain('LetheBot');
    expect(prompt).toContain('记忆能力');
    expect(prompt).toContain('私聊风格');
    expect(prompt).toContain('友好、自然');
    expect(prompt).not.toContain('群聊风格');
  });

  it('should route explicit safe remember requests through reviewable proposal semantics', () => {
    const prompt = buildSystemPrompt({
      conversationType: 'private',
      hasMemorySystem: true,
    });

    expect(prompt).toContain('明确要求');
    expect(prompt).toContain('稳定、非敏感');
    expect(prompt).toContain('记忆提议工具');
    expect(prompt).toContain('待审核');
    expect(prompt).toContain('不得声称已写入或已经成为长期记忆');
  });
});
