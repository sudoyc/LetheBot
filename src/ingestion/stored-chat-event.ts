import { Buffer } from 'node:buffer';
import { z } from 'zod';
import type { ChatMessageReceived } from '../types/events.js';

const MAX_STORED_EVENT_BYTES = 1024 * 1024;
const identifier = z.string().min(1).max(512);
const optionalText = z.string().max(65_536).optional();

const mediaAttachmentSchema = z.object({
  type: z.enum(['image', 'video', 'audio', 'file']),
  url: z.string().max(8_192).optional(),
  localPath: z.string().max(8_192).optional(),
  mimeType: z.string().max(512).optional(),
  size: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();

const quotedMessageSchema = z.object({
  messageId: identifier,
  senderId: identifier,
  text: optionalText,
}).strict();

const gatewayCapabilitiesSchema = z.object({
  platform: z.literal('qq'),
  reactions: z.object({
    emojiLike: z.boolean(),
    faceMessage: z.boolean(),
  }).strict(),
  foldedForward: z.object({
    groupForward: z.boolean(),
    privateForward: z.boolean(),
    customNode: z.boolean(),
  }).strict(),
  platformAdmin: z.object({
    kick: z.boolean(),
    mute: z.boolean(),
    setGroupCard: z.boolean(),
  }).strict(),
}).strict();

const storedChatMessageReceivedSchema = z.object({
  id: identifier,
  type: z.literal('chat.message.received'),
  timestamp: z.string().max(64).datetime().transform((value, context) => {
    const timestamp = new Date(value);
    if (!Number.isFinite(timestamp.getTime())) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid timestamp' });
      return z.NEVER;
    }
    return timestamp;
  }),
  source: z.literal('gateway'),
  platform: z.literal('qq'),
  conversationId: identifier,
  correlationId: identifier.optional(),
  ingress: z.object({
    transport: z.enum(['http', 'ws']),
    platformEventId: identifier.optional(),
  }).strict(),
  message: z.object({
    messageId: identifier,
    conversationId: identifier,
    conversationType: z.enum(['private', 'group']),
    groupId: identifier.optional(),
    senderId: identifier,
    senderRole: z.enum(['member', 'admin', 'owner']).optional(),
    senderDisplayName: z.string().max(2_048).optional(),
    senderCard: z.string().max(2_048).optional(),
    content: z.object({
      text: optionalText,
      media: z.array(mediaAttachmentSchema).max(64).optional(),
      quote: quotedMessageSchema.optional(),
    }).strict(),
    mentions: z.array(identifier).max(128).optional(),
    mentionsBot: z.boolean(),
    replyToMessageId: identifier.optional(),
  }).strict(),
  gatewayCapabilities: gatewayCapabilitiesSchema,
}).strict().superRefine((event, context) => {
  if (event.conversationId !== event.message.conversationId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'conversation mismatch' });
  }

  if (event.message.conversationType === 'group') {
    if (!event.message.groupId || event.message.groupId !== event.conversationId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'group mismatch' });
    }
  } else if (event.message.groupId !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'private event has group' });
  }

  if (
    event.ingress.platformEventId !== undefined
    && event.ingress.platformEventId !== event.message.messageId
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'message identity mismatch' });
  }
});

export interface StoredChatEventRow {
  id: string;
  type: string;
  timestamp: number;
  source: string;
  platform: string | null;
  conversation_id: string | null;
  correlation_id: string | null;
  platform_event_id: string | null;
  payload: string;
}

export type StoredChatEventParseResult =
  | { ok: true; event: ChatMessageReceived }
  | { ok: false };

export function parseStoredChatMessageReceived(
  row: StoredChatEventRow,
): StoredChatEventParseResult {
  if (Buffer.byteLength(row.payload, 'utf8') > MAX_STORED_EVENT_BYTES) {
    return { ok: false };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    return { ok: false };
  }

  const parsed = storedChatMessageReceivedSchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false };
  }

  const event = parsed.data;
  if (
    event.id !== row.id
    || event.type !== row.type
    || event.timestamp.getTime() !== row.timestamp
    || event.source !== row.source
    || event.platform !== row.platform
    || event.conversationId !== row.conversation_id
    || (event.correlationId ?? null) !== row.correlation_id
    || (event.ingress.platformEventId ?? null) !== row.platform_event_id
  ) {
    return { ok: false };
  }

  return { ok: true, event: event as ChatMessageReceived };
}
