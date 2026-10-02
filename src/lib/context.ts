import { createContext, useContext } from 'react';
import type React from 'react';
import type {
  Attachment,
  BubbleEffect,
  Chat,
  Contact,
  Message,
  ScreenEffect,
  Store,
  Tapback,
} from '../types';
import type { Action } from './reducer';

export interface SendOptions {
  text: string;
  subject?: string;
  attachments?: Attachment[];
  replyTo?: string;
  bubbleEffect?: BubbleEffect;
  screenEffect?: ScreenEffect;
  forwarded?: boolean;
}

export interface Ctx {
  state: Store;
  dispatch: React.Dispatch<Action>;
  activeChat: Chat | null;
  messagesFor: (chatId: string) => Message[];
  chatTitle: (chat: Chat) => string;
  chatContacts: (chat: Chat) => Contact[];
  send: (chatId: string, opts: SendOptions) => void;
  retrySend: (messageId: string) => void;
  react: (messageId: string, tapback: Tapback) => void;
  effect: ScreenEffect;
  fireEffect: (e: ScreenEffect) => void;
  startChatWith: (contactIds: string[]) => string;
  reset: () => void;
  resolvedTheme: 'light' | 'dark';
  /** false until the store has been read from IndexedDB */
  booted: boolean;
  online: boolean;
  storageIssue: string | null;
  dismissStorageIssue: () => void;
  /** writes a JSON backup; async because file bytes are inlined into it */
  exportData: () => Promise<void>;
  importData: (file: File) => Promise<void>;
  enableNotifications: () => Promise<boolean>;
  notificationsGranted: boolean;
  /**
   * The agent run currently in flight for a chat, if any. The composer
   * reads this to offer a stop button: a run that has gone wrong should
   * be stoppable, not waited out.
   */
  runningRun: (chatId: string) => string | null;
  cancelRun: (chatId: string) => void;
}

export const StoreContext = createContext<Ctx | null>(null);

export function useStore() {
  const v = useContext(StoreContext);
  if (!v) throw new Error('useStore outside provider');
  return v;
}
