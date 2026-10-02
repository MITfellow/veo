import type { MemojiSpec } from './lib/memoji';
export type Tapback = 'heart' | 'like' | 'dislike' | 'haha' | 'emphasize' | 'question';

export const TAPBACKS: { id: Tapback; glyph: string; label: string }[] = [
  { id: 'heart', glyph: '❤️', label: 'Love' },
  { id: 'like', glyph: '👍', label: 'Like' },
  { id: 'dislike', glyph: '👎', label: 'Dislike' },
  { id: 'haha', glyph: '😂', label: 'Laugh' },
  { id: 'emphasize', glyph: '‼️', label: 'Emphasize' },
  { id: 'question', glyph: '❓', label: 'Question' },
];

export type BubbleEffect = 'none' | 'slam' | 'loud' | 'gentle' | 'invisible';
export type ScreenEffect =
  | 'none'
  | 'echo'
  | 'spotlight'
  | 'balloons'
  | 'confetti'
  | 'love'
  | 'lasers'
  | 'fireworks'
  | 'celebration';

export const BUBBLE_EFFECTS: { id: BubbleEffect; label: string }[] = [
  { id: 'slam', label: 'Slam' },
  { id: 'loud', label: 'Loud' },
  { id: 'gentle', label: 'Gentle' },
  { id: 'invisible', label: 'Invisible Ink' },
];

export const SCREEN_EFFECTS: { id: ScreenEffect; label: string }[] = [
  { id: 'echo', label: 'Echo' },
  { id: 'spotlight', label: 'Spotlight' },
  { id: 'balloons', label: 'Balloons' },
  { id: 'confetti', label: 'Confetti' },
  { id: 'love', label: 'Love' },
  { id: 'lasers', label: 'Lasers' },
  { id: 'fireworks', label: 'Fireworks' },
  { id: 'celebration', label: 'Celebration' },
];

export type DeliveryStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface Attachment {
  id: string;
  kind: 'image' | 'video' | 'audio' | 'link' | 'location' | 'file' | 'sticker';
  /** data-uri, remote url, or generated gradient descriptor */
  src?: string;
  /**
   * The real bytes. Stored in IndexedDB as a structured clone, so files keep
   * their original size instead of growing a third under base64. Rendering
   * goes through an object URL (see lib/blobs.ts).
   */
  blob?: Blob;
  /** MIME type as reported by the OS */
  type?: string;
  /** byte count, kept numeric for sorting and quota maths (`size` is the label) */
  bytes?: number;
  /** the metadata survived but the bytes did not (localStorage fallback) */
  unavailable?: boolean;
  name?: string;
  size?: string;
  width?: number;
  height?: number;
  /** audio */
  duration?: number;
  waveform?: number[];
  /** audio: the recording's container, e.g. audio/webm;codecs=opus */
  mimeType?: string;
  /** location: a real reading from the device */
  lat?: number;
  lon?: number;
  accuracy?: number;
  /** link preview */
  title?: string;
  domain?: string;
  description?: string;
}

export interface Reaction {
  type: Tapback;
  by: string; // contact id or 'me'
  at: number;
}

export interface Message {
  id: string;
  chatId: string;
  /** 'me' for outgoing */
  authorId: string;
  text: string;
  subject?: string;
  at: number;
  status: DeliveryStatus;
  readAt?: number;
  attachments: Attachment[];
  reactions: Reaction[];
  replyTo?: string;
  bubbleEffect: BubbleEffect;
  screenEffect: ScreenEffect;
  /** invisible ink revealed locally */
  revealed?: boolean;
  edited?: boolean;
  /** passed on from another conversation */
  forwarded?: boolean;
  unsent?: boolean;
  /** system notices: "Name named the conversation ..." */
  system?: boolean;
  /**
   * The agent is asking permission before doing something irreversible
   * (§19). Rendered as a card with the preview it generated, not as text:
   * an approval the user can mistake for chatter is not consent.
   */
  approval?: {
    id: string;
    tool: string;
    preview: string;
    risk: string;
    outcome?: 'granted' | 'denied' | 'expired';
  };
  /** Provenance of the content, carried straight from the event log. */
  trust?: string;
  /** True while deltas are still arriving. */
  streaming?: boolean;
}

export interface Contact {
  id: string;
  name: string;
  handle: string; // phone or email
  initials: string;
  color: [string, string];
  avatar?: string;
  /** persona drives the auto-reply engine */
  persona: 'friend' | 'family' | 'work' | 'partner' | 'business' | 'group';
  /**
   * This "contact" is the agent that lives in this app, not a person. A chat
   * with it is routed to the ARISH runtime instead of the reply engine.
   */
  agent?: boolean;
  sms?: boolean;
  bio?: string;
}

export interface Chat {
  id: string;
  participantIds: string[];
  name?: string; // group name
  pinned: boolean;
  muted: boolean;
  unread: number;
  draft: string;
  typing: boolean;
  typingBy?: string;
  sms: boolean;
  hidePreview?: boolean;
  lastReadAt: number;
  /** For agent chats: the runtime session this conversation maps to. */
  agentSessionId?: string;
}

export interface Store {
  contacts: Record<string, Contact>;
  chats: Chat[];
  messages: Message[];
  activeChatId: string | null;
  me: { name: string; handle: string; avatar?: string };
  /** characters you built in the Memoji studio */
  customMemoji?: MemojiSpec[];
  settings: {
    theme: 'light' | 'dark' | 'system';
    sounds: boolean;
    readReceipts: boolean;
    autoReply: boolean;
    sendWithSound: boolean;
    showDetails: boolean;
    density: 'comfortable' | 'compact';
    notifications: boolean;
  };
}
