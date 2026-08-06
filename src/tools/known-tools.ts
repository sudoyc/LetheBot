/**
 * Canonical names for the reviewed production tool catalog.
 *
 * This leaf module intentionally has no runtime dependencies so configuration
 * validation can run before database initialization or tool composition.
 */
export const KNOWN_TOOL_NAMES = [
  'group.recent_summary',
  'memory.disable',
  'memory.propose',
  'memory.search',
  'runtime.status',
  'runtime.tools',
  'web.fetch_text',
  'workspace.list',
  'workspace.read_text',
] as const;

const knownToolNames = new Set<string>(KNOWN_TOOL_NAMES);

export function isKnownToolName(name: string): boolean {
  return knownToolNames.has(name);
}
