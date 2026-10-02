import type { Chat, Contact } from '../types';

/**
 * A one-to-one chat with the thing that is actually running.
 *
 * The test is the contact's own `agent` flag rather than a hardcoded id, so
 * a second agent — a different model, a different machine — is a contact
 * row and not a code change.
 */
export function isAgentChat(chat: Chat, contacts: Record<string, Contact>): boolean {
  return chat.participantIds.length === 1 && contacts[chat.participantIds[0]]?.agent === true;
}
