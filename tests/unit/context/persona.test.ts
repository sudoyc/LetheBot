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

  it('should include memory system description', () => {
    const prompt = buildSystemPrompt({
      conversationType: 'private',
      hasMemorySystem: true,
    });

    expect(prompt).toContain('持久记忆');
    expect(prompt).toContain('历史消息');
    expect(prompt).toContain('长期存储');
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

  it('should include conversation principles', () => {
    const prompt = buildSystemPrompt({
      conversationType: 'group',
      hasMemorySystem: true,
    });

    expect(prompt).toContain('理解上下文');
    expect(prompt).toContain('不编造信息');
  });

  it('should have different tone for group vs private', () => {
    const groupPrompt = buildSystemPrompt({
      conversationType: 'group',
      hasMemorySystem: true,
    });

    const privatePrompt = buildSystemPrompt({
      conversationType: 'private',
      hasMemorySystem: true,
    });

    // 群聊强调简短
    expect(groupPrompt).toContain('简短');
    expect(privatePrompt).not.toContain('简短');

    // 私聊强调详细
    expect(privatePrompt).toContain('详细');
    expect(groupPrompt).not.toContain('详细');
  });
});
