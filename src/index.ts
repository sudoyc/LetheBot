/**
 * LetheBot entry point
 *
 * A persistent, local-first chatbot with thick memory layer and Pi-based reasoning core.
 */

export const VERSION = '0.1.0';

export function hello(): string {
  return 'LetheBot v' + VERSION;
}
