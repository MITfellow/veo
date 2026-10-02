import type { Chat, Contact, Message, Store, Tapback } from '../types';
import type { MemojiSpec } from './memoji';

export type Action =
  | { type: 'select'; chatId: string | null }
  | { type: 'draft'; chatId: string; value: string }
  | { type: 'push'; message: Message }
  | { type: 'status'; id: string; status: Message['status']; readAt?: number }
  | { type: 'typing'; chatId: string; typing: boolean; by?: string }
  | { type: 'stream'; id: string; text: string; done?: boolean }
  | { type: 'approval-outcome'; approvalId: string; outcome: 'granted' | 'denied' | 'expired' }
  | { type: 'react'; messageId: string; tapback: Tapback; by: string }
  | { type: 'unsend'; id: string }
  | { type: 'delete'; id: string }
  | { type: 'edit'; id: string; text: string }
  | { type: 'reveal'; id: string }
  | { type: 'chat-flag'; chatId: string; patch: Partial<Chat> }
  | { type: 'agent-session'; chatId: string; sessionId: string }
  | { type: 'delete-chat'; chatId: string }
  | { type: 'new-chat'; chat: Chat }
  | { type: 'settings'; patch: Partial<Store['settings']> }
  | { type: 'rename'; chatId: string; name: string }
  | { type: 'read-all'; chatId: string }
  | { type: 'me'; patch: Partial<Store['me']> }
  | { type: 'save-memoji'; spec: MemojiSpec }
  | { type: 'delete-memoji'; id: string }
  | { type: 'add-contact'; contact: Contact }
  | { type: 'update-contact'; id: string; patch: Partial<Contact> }
  | { type: 'delete-contact'; id: string }
  | { type: 'replace'; store: Store };

export function reducer(state: Store, action: Action): Store {
  switch (action.type) {
    case 'select': {
      if (!action.chatId) return { ...state, activeChatId: null };
      return {
        ...state,
        activeChatId: action.chatId,
        chats: state.chats.map((c) => {
          // opening a chat clears its badge but keeps the read watermark, so the
          // "Unread Messages" divider survives until you leave the thread
          if (c.id === action.chatId) return { ...c, unread: 0 };
          if (c.id === state.activeChatId) return { ...c, lastReadAt: Date.now() };
          return c;
        }),
      };
    }
    case 'draft':
      return {
        ...state,
        chats: state.chats.map((c) => (c.id === action.chatId ? { ...c, draft: action.value } : c)),
      };
    case 'push': {
      const incoming = action.message.authorId !== 'me';
      const isActive = state.activeChatId === action.message.chatId;
      return {
        ...state,
        messages: [...state.messages, action.message],
        chats: state.chats.map((c) =>
          c.id === action.message.chatId
            ? {
                ...c,
                unread: incoming && !isActive ? c.unread + 1 : c.unread,
                lastReadAt: !incoming || isActive ? Date.now() : c.lastReadAt,
              }
            : c,
        ),
      };
    }
    case 'status':
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.id ? { ...m, status: action.status, readAt: action.readAt ?? m.readAt } : m,
        ),
      };
    case 'stream':
      // Replaces rather than appends: the caller owns the accumulated text,
      // so a dropped frame cannot leave the bubble with a hole in it.
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.id
            ? { ...m, text: action.text, streaming: action.done !== true }
            : m,
        ),
      };
    case 'approval-outcome':
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.approval?.id === action.approvalId
            ? { ...m, approval: { ...m.approval, outcome: action.outcome } }
            : m,
        ),
      };
    case 'typing':
      return {
        ...state,
        chats: state.chats.map((c) =>
          c.id === action.chatId ? { ...c, typing: action.typing, typingBy: action.by } : c,
        ),
      };
    case 'react':
      return {
        ...state,
        messages: state.messages.map((m) => {
          if (m.id !== action.messageId) return m;
          const existing = m.reactions.find((r) => r.by === action.by);
          let reactions = m.reactions.filter((r) => r.by !== action.by);
          if (!existing || existing.type !== action.tapback) {
            reactions = [...reactions, { type: action.tapback, by: action.by, at: Date.now() }];
          }
          return { ...m, reactions };
        }),
      };
    case 'unsend':
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.id ? { ...m, unsent: true, text: '', attachments: [], reactions: [] } : m,
        ),
      };
    case 'delete':
      return { ...state, messages: state.messages.filter((m) => m.id !== action.id) };
    case 'edit':
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.id ? { ...m, text: action.text, edited: true } : m,
        ),
      };
    case 'reveal':
      return {
        ...state,
        messages: state.messages.map((m) => (m.id === action.id ? { ...m, revealed: true } : m)),
      };
    case 'agent-session':
      return {
        ...state,
        chats: state.chats.map((c) =>
          c.id === action.chatId ? { ...c, agentSessionId: action.sessionId } : c,
        ),
      };
    case 'chat-flag':
      return {
        ...state,
        chats: state.chats.map((c) => (c.id === action.chatId ? { ...c, ...action.patch } : c)),
      };
    case 'rename':
      return {
        ...state,
        chats: state.chats.map((c) => (c.id === action.chatId ? { ...c, name: action.name } : c)),
      };
    case 'delete-chat':
      return {
        ...state,
        chats: state.chats.filter((c) => c.id !== action.chatId),
        messages: state.messages.filter((m) => m.chatId !== action.chatId),
        activeChatId: state.activeChatId === action.chatId ? null : state.activeChatId,
      };
    case 'new-chat':
      return { ...state, chats: [action.chat, ...state.chats], activeChatId: action.chat.id };
    case 'me':
      return { ...state, me: { ...state.me, ...action.patch } };

    // one action for create and edit: the studio hands back a whole spec
    case 'save-memoji': {
      const list = state.customMemoji ?? [];
      const at = list.findIndex((m) => m.id === action.spec.id);
      const customMemoji =
        at === -1 ? [...list, action.spec] : list.map((m) => (m.id === action.spec.id ? action.spec : m));
      return { ...state, customMemoji };
    }

    // deleting a character also takes it off anyone wearing it, so nothing is
    // left pointing at an avatar that can no longer be resolved
    case 'delete-memoji': {
      const list = state.customMemoji ?? [];
      if (!list.some((m) => m.id === action.id)) return state;
      const ref = `memoji:${action.id}`;
      const contacts = { ...state.contacts };
      for (const [id, c] of Object.entries(contacts)) {
        if (c.avatar === ref) contacts[id] = { ...c, avatar: undefined };
      }
      return {
        ...state,
        customMemoji: list.filter((m) => m.id !== action.id),
        contacts,
        me: state.me.avatar === ref ? { ...state.me, avatar: undefined } : state.me,
      };
    }

    case 'add-contact':
      return { ...state, contacts: { ...state.contacts, [action.contact.id]: action.contact } };

    case 'update-contact': {
      const current = state.contacts[action.id];
      if (!current) return state;
      return { ...state, contacts: { ...state.contacts, [action.id]: { ...current, ...action.patch, id: action.id } } };
    }

    case 'delete-contact': {
      if (!state.contacts[action.id]) return state;
      const contacts = { ...state.contacts };
      delete contacts[action.id];
      // every thread that person was part of goes with them
      const doomed = new Set(
        state.chats.filter((c) => c.participantIds.includes(action.id)).map((c) => c.id),
      );
      const chats = state.chats.filter((c) => !doomed.has(c.id));
      return {
        ...state,
        contacts,
        chats,
        messages: state.messages.filter((m) => !doomed.has(m.chatId)),
        activeChatId: doomed.has(state.activeChatId ?? '') ? null : state.activeChatId,
      };
    }

    case 'read-all':
      return {
        ...state,
        chats: state.chats.map((c) => (c.id === action.chatId ? { ...c, unread: 0 } : c)),
      };
    case 'settings':
      return { ...state, settings: { ...state.settings, ...action.patch } };
    case 'replace':
      return action.store;
    default:
      return state;
  }
}
