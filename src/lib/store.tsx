import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { Chat, Message, ScreenEffect, Store, Tapback } from '../types';
import { reducer } from './reducer';
import { StoreContext, type Ctx, type SendOptions } from './context';
import { AGENT_CHAT_ID, AGENT_CONTACT, buildSeedStore } from '../data/seed';
import { agent, AgentUnavailableError } from './agent';
import { isAgentChat } from './agent-chat';
import { composeReply } from './bot';
import { playReceive, playSend, playTapback, setSoundEnabled } from './sound';
import { setCustomMemoji } from './memoji';
import {
  STORAGE_KEY,
  clearState,
  exportState,
  importState,
  loadState,
  saveState,
  saveToLocal,
  storageChangedElsewhere,
} from './persist';
import { notify, notificationsAllowed, requestNotificationPermission } from './notify';

const SYNC_CHANNEL = 'messages.sync';

let uid = 0;

/**
 * Identifies this tab on the sync channel so a tab can ignore the echo of its
 * own write. The module is evaluated once per document, which is exactly the
 * lifetime we want.
 */
const TAB_ID = `${Date.now().toString(36)}-${(Math.random() * 1e9).toString(36)}`;
const newId = () => `u${Date.now().toString(36)}${(uid++).toString(36)}`;

/** A message with every field at its boring default, ready to be overridden. */
function blank(id: string, chatId: string): Message {
  return {
    id,
    chatId,
    authorId: 'me',
    text: '',
    at: Date.now(),
    status: 'read',
    attachments: [],
    reactions: [],
    bubbleEffect: 'none',
    screenEffect: 'none',
  };
}

/**
 * Stores written before the agent existed have no agent contact and no agent
 * chat. Add them on load rather than migrating the database: this is the one
 * piece of state the app is allowed to assume into existence, because its
 * absence is a missing feature rather than lost user data.
 */
function withAgent(store: Store): Store {
  const hasChat = store.chats.some((c) => c.id === AGENT_CHAT_ID);
  if (store.contacts[AGENT_CONTACT.id] !== undefined && hasChat) return store;
  return {
    ...store,
    contacts: { ...store.contacts, [AGENT_CONTACT.id]: AGENT_CONTACT },
    chats: hasChat
      ? store.chats
      : [
          ...store.chats,
          // Appended, not prepended: an existing install's first
          // conversation stays its first conversation.
          {
            id: AGENT_CHAT_ID,
            participantIds: [AGENT_CONTACT.id],
            pinned: false,
            muted: false,
            unread: 0,
            draft: '',
            typing: false,
            sms: false,
            lastReadAt: 0,
          },
        ],
  };
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  // IndexedDB is async, so the app starts on an empty seed and swaps in the
  // real store once it has loaded. `booted` gates persistence: writing before
  // the load resolves would stamp the seed over the user's account.
  const [state, dispatch] = useReducer(reducer, undefined, buildSeedStore);
  const [booted, setBooted] = useState(false);
  const bootedRef = useRef(false);
  const stateRef = useRef(state);
  const savedRef = useRef<Store | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadState()
      .then((raw) => {
        if (cancelled) return;
        const loaded = withAgent(raw);
        stateRef.current = loaded;
        savedRef.current = loaded; // it came from storage; nothing to write back
        dispatch({ type: 'replace', store: loaded });
      })
      .catch(() => {
        /* fall back to the seed already in state */
      })
      .finally(() => {
        if (cancelled) return;
        bootedRef.current = true;
        setBooted(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const [effect, setEffect] = useState<ScreenEffect>('none');
  const [systemDark, setSystemDark] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  const timers = useRef<number[]>([]);
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const [storageIssue, setStorageIssue] = useState<string | null>(null);
  /** chatId → the agent run currently in flight for it. */
  const [running, setRunning] = useState<Record<string, string>>({});

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const fn = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);

  const resolvedTheme: 'light' | 'dark' =
    state.settings.theme === 'system' ? (systemDark ? 'dark' : 'light') : state.settings.theme;

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);

  useEffect(() => setSoundEnabled(state.settings.sounds), [state.settings.sounds]);

  // keep the avatar registry in step so <Avatar> can resolve custom characters
  // without every call site passing the list down
  useEffect(() => setCustomMemoji(state.customMemoji), [state.customMemoji]);

  /**
   * Persistence: debounced, quota-aware, and deferred to idle time.
   *
   * Serialising a busy account is a megabyte-plus of JSON. Doing that straight
   * off a timer lands a ~100ms task in the middle of whatever the user is
   * doing, so the write is handed to requestIdleCallback and only falls back
   * to a timeout where that doesn't exist (Safari).
   */
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  /** tell other tabs a write landed so they can reload from the database */
  const broadcast = useCallback((_next: Store) => {
    if (typeof BroadcastChannel === 'undefined') return;
    try {
      const chan = new BroadcastChannel(SYNC_CHANNEL);
      chan.postMessage({ tab: TAB_ID, at: Date.now() });
      chan.close();
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!booted) return;
    let idle = 0;
    const write = () => {
      void saveState(state).then((res) => {
        savedRef.current = state;
        broadcast(state);
        if (!res.ok) {
          setStorageIssue(
            res.reason === 'quota'
              ? 'Storage is full — older photos were freed to keep saving your messages.'
              : 'This browser blocked local storage, so changes will not be saved.',
          );
        }
      });
    };

    const t = window.setTimeout(() => {
      const ric = window.requestIdleCallback;
      // the timeout guarantees the write still happens on a busy main thread
      if (ric) idle = ric(write, { timeout: 2000 });
      else write();
    }, 250);

    return () => {
      window.clearTimeout(t);
      if (idle && window.cancelIdleCallback) window.cancelIdleCallback(idle);
    };
  }, [state, booted, broadcast]);

  /**
   * Cross-tab sync. IndexedDB fires no events, so writes are announced on a
   * BroadcastChannel and the other tabs reload from the database. The
   * `storage` listener stays for the localStorage fallback path.
   */
  useEffect(() => {
    if (!booted) return;
    const adopt = async () => {
      const next = await loadState().catch(() => null);
      if (!next) return;
      savedRef.current = next;
      stateRef.current = next;
      dispatch({ type: 'replace', store: next });
    };

    const chan = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(SYNC_CHANNEL) : null;
    if (chan) {
      chan.onmessage = (e) => {
        if (e.data?.tab === TAB_ID) return; // our own write
        void adopt();
      };
    }

    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY || !e.newValue) return;
      void adopt();
    };
    window.addEventListener('storage', onStorage);

    return () => {
      chan?.close();
      window.removeEventListener('storage', onStorage);
    };
  }, [booted]);

  /**
   * A tab can be hidden or closed mid-debounce. IndexedDB has no synchronous
   * write, so the escape hatch is localStorage: it carries a newer `savedAt`
   * than the database, and the next load prefers it and migrates it back.
   */
  useEffect(() => {
    const flush = () => {
      if (!bootedRef.current) return;
      if (savedRef.current === stateRef.current) return;
      if (storageChangedElsewhere()) return;
      saveToLocal(stateRef.current);
      savedRef.current = stateRef.current;
    };
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, []);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const later = useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(fn, ms);
    timers.current.push(id);
    return id;
  }, []);

  const fireEffect = useCallback((e: ScreenEffect) => {
    setEffect('none');
    window.requestAnimationFrame(() => setEffect(e));
  }, []);

  /** O(n) once per message change instead of O(n) per chat render */
  const messagesByChat = useMemo(() => {
    const index = new Map<string, Message[]>();
    for (const m of state.messages) {
      const list = index.get(m.chatId);
      if (list) list.push(m);
      else index.set(m.chatId, [m]);
    }
    for (const list of index.values()) list.sort((a, b) => a.at - b.at);
    return index;
  }, [state.messages]);

  const EMPTY: Message[] = useMemo(() => [], []);
  const messagesFor = useCallback(
    (chatId: string) => messagesByChat.get(chatId) ?? EMPTY,
    [messagesByChat, EMPTY],
  );

  const chatContacts = useCallback(
    (chat: Chat) => chat.participantIds.map((id) => state.contacts[id]).filter(Boolean),
    [state.contacts],
  );

  const chatTitle = useCallback(
    (chat: Chat) => {
      if (chat.name) return chat.name;
      const people = chatContacts(chat);
      if (people.length === 1) return people[0].name;
      return people.map((p) => p.name.split(' ')[0]).join(', ');
    },
    [chatContacts],
  );

  const react = useCallback(
    (messageId: string, tapback: Tapback) => {
      dispatch({ type: 'react', messageId, tapback, by: 'me' });
      playTapback();
    },
    [],
  );

  /**
   * An agent chat does not get an auto-reply: it gets a real run.
   *
   * The sequence is the whole integration in one function — create (or
   * reuse) a runtime session, post the turn, then follow the run's event
   * stream and paint it into the bubble as it arrives. Everything the agent
   * does on the way (steps, tool calls, approval requests, degradation)
   * arrives on that one stream, which is why the UI needs no polling and no
   * second source of truth.
   */
  const deliverToAgent = useCallback(
    async (chatId: string, outgoingId: string, text: string) => {
      const bubble = newId();
      const fail = (message: string) => {
        dispatch({ type: 'typing', chatId, typing: false });
        dispatch({ type: 'status', id: outgoingId, status: 'failed' });
        dispatch({
          type: 'push',
          message: {
            ...blank(bubble, chatId),
            authorId: AGENT_CONTACT.id,
            text: message,
            system: true,
          },
        });
      };

      try {
        let sessionId = stateRef.current.chats.find((c) => c.id === chatId)?.agentSessionId;
        if (sessionId === undefined) {
          sessionId = (await agent.createSession('Veo')).id;
          dispatch({ type: 'agent-session', chatId, sessionId });
        }

        dispatch({ type: 'status', id: outgoingId, status: 'delivered' });
        const { runId } = await agent.send(sessionId, text);
        dispatch({ type: 'typing', chatId, typing: true, by: AGENT_CONTACT.id });
        // From here the run is interruptible, and the composer says so.
        setRunning((current) => ({ ...current, [chatId]: runId }));

        /** A system line in the transcript, where it stays. */
        const note = (message: string) =>
          dispatch({
            type: 'push',
            message: {
              ...blank(newId(), chatId),
              authorId: AGENT_CONTACT.id,
              text: message,
              system: true,
            },
          });

        let painted = '';
        let opened = false;
        const open = () => {
          if (opened) return;
          opened = true;
          dispatch({ type: 'typing', chatId, typing: false });
          dispatch({
            type: 'push',
            message: {
              ...blank(bubble, chatId),
              authorId: AGENT_CONTACT.id,
              streaming: true,
              // The join that lets the bubble explain itself (§30).
              runId,
            },
          });
        };

        await agent.follow(runId, {
          onDelta: (delta) => {
            open();
            painted += delta;
            dispatch({ type: 'stream', id: bubble, text: painted });
          },
          onTool: (tool) => {
            dispatch({ type: 'typing', chatId, typing: true, by: AGENT_CONTACT.id });
            if (!opened) return;
            dispatch({ type: 'stream', id: bubble, text: `${painted}\n\n· using ${tool}…` });
          },
          onApproval: (approval) => {
            dispatch({ type: 'typing', chatId, typing: false });
            dispatch({
              type: 'push',
              message: {
                ...blank(newId(), chatId),
                authorId: AGENT_CONTACT.id,
                text: '',
                approval,
              },
            });
          },
          onApprovalDecided: (id, outcome) => {
            if (outcome === 'granted' || outcome === 'denied' || outcome === 'expired') {
              dispatch({ type: 'approval-outcome', approvalId: id, outcome });
            }
          },
          onMessage: (final) => {
            // The `message.agent` event is authoritative: deltas are a
            // preview, this is what was actually committed to the log.
            open();
            painted = final;
            dispatch({ type: 'stream', id: bubble, text: final, done: true });
          },
          onDone: () => {
            dispatch({ type: 'typing', chatId, typing: false });
            dispatch({ type: 'stream', id: bubble, text: painted, done: true });
            if (painted !== '' && !stateRef.current.chats.find((c) => c.id === chatId)?.muted) {
              playReceive();
            }
          },
          onSuspended: () => {
            dispatch({ type: 'typing', chatId, typing: false });
          },
          onResumed: () => {
            dispatch({ type: 'typing', chatId, typing: true, by: AGENT_CONTACT.id });
          },
          // §27: the ladder moved while this answer was being written.
          // It goes in the transcript rather than a toast, because it is
          // a fact about this reply and belongs next to it forever.
          onDegraded: (level, reason) => {
            note(`⚠︎ Working with less (${level}): ${reason}. The answer below reflects that.`);
          },
          onCancelled: () => {
            dispatch({ type: 'typing', chatId, typing: false });
            if (opened) dispatch({ type: 'stream', id: bubble, text: painted, done: true });
            note('You stopped this one.');
          },
          onError: (message) => {
            if (opened) {
              dispatch({
                type: 'stream',
                id: bubble,
                text: `${painted}\n\n⚠︎ ${message}`,
                done: true,
              });
              dispatch({ type: 'typing', chatId, typing: false });
            } else fail(`⚠︎ ${message}`);
          },
        });
        dispatch({ type: 'typing', chatId, typing: false });
      } catch (error) {
        fail(
          error instanceof AgentUnavailableError
            ? error.message
            : `⚠︎ ${error instanceof Error ? error.message : 'the agent failed'}`,
        );
      } finally {
        // Whatever happened — finished, failed, cancelled, threw — the
        // run is no longer in flight, so the stop button goes away.
        setRunning((current) => {
          const next = { ...current };
          delete next[chatId];
          return next;
        });
      }
    },
    [],
  );

  const runningRun = useCallback((chatId: string) => running[chatId] ?? null, [running]);

  /**
   * Stop a run. The server answers 409 if it already finished, which is
   * a race rather than a failure: the user asked for it to be over, and
   * it is over either way.
   */
  const cancelRun = useCallback(
    (chatId: string) => {
      const runId = running[chatId];
      if (runId === undefined) return;
      void agent.cancel(runId).catch(() => undefined);
    },
    [running],
  );

  /** Runs delivery receipts + the auto-reply conversation for an outgoing message. */
  const deliver = useCallback(
    (chatId: string, id: string, text: string) => {
      const chat = state.chats.find((c) => c.id === chatId);
      if (!chat) return;

      if (isAgentChat(chat, state.contacts)) {
        void deliverToAgent(chatId, id, text);
        return;
      }

      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        later(() => dispatch({ type: 'status', id, status: 'failed' }), 600);
        return;
      }

      later(() => dispatch({ type: 'status', id, status: 'sent' }), 420);
      later(() => dispatch({ type: 'status', id, status: 'delivered' }), 950);

      if (!state.settings.autoReply) return;

      const people = chat.participantIds.map((p) => state.contacts[p]).filter(Boolean);
      if (!people.length) return;
      const isGroup = people.length > 1;
      const responder = people[Math.floor(Math.random() * people.length)];
      if (responder.persona === 'business' && Math.random() > 0.3) return;

      // the other side reads it
      later(
        () => dispatch({ type: 'status', id, status: 'read', readAt: Date.now() }),
        1400 + Math.random() * 1600,
      );

      const receive = (authorId: string, body: string) => {
        dispatch({ type: 'typing', chatId, typing: false });
        dispatch({
          type: 'push',
          message: {
            id: newId(),
            chatId,
            authorId,
            text: body,
            at: Date.now(),
            status: 'read',
            attachments: [],
            reactions: [],
            bubbleEffect: 'none',
            screenEffect: 'none',
          },
        });
        if (!chat.muted) {
          playReceive();
          notify(state.contacts[authorId]?.name ?? 'Veo', body, chatId);
        }
      };

      const turns = composeReply(responder, text, isGroup);
      let clock = 1600 + Math.random() * 900;
      turns.forEach((turn) => {
        if (turn.tapbackOnYou) {
          later(() => {
            dispatch({ type: 'react', messageId: id, tapback: turn.tapbackOnYou!, by: turn.authorId });
            playTapback();
          }, clock + 300);
        }
        const startTyping = clock + turn.delay;
        later(() => dispatch({ type: 'typing', chatId, typing: true, by: turn.authorId }), startTyping);
        later(() => receive(turn.authorId, turn.text), startTyping + turn.typingFor);
        clock = startTyping + turn.typingFor;
      });

      // a second person chimes in sometimes in groups
      if (isGroup && Math.random() < 0.45) {
        const other = people.filter((p) => p.id !== responder.id);
        const second = other[Math.floor(Math.random() * other.length)];
        const extra = composeReply(second, text, true)[0];
        const s2 = clock + 900 + Math.random() * 1200;
        later(() => dispatch({ type: 'typing', chatId, typing: true, by: second.id }), s2);
        later(() => receive(second.id, extra.text), s2 + extra.typingFor);
      }
    },
    [state.chats, state.contacts, state.settings.autoReply, later, deliverToAgent],
  );

  const send = useCallback(
    (chatId: string, opts: SendOptions) => {
      const chat = state.chats.find((c) => c.id === chatId);
      if (!chat) return;
      const id = newId();
      const msg: Message = {
        id,
        chatId,
        authorId: 'me',
        text: opts.text,
        subject: opts.subject,
        at: Date.now(),
        status: 'sending',
        attachments: opts.attachments ?? [],
        reactions: [],
        replyTo: opts.replyTo,
        bubbleEffect: opts.bubbleEffect ?? 'none',
        screenEffect: opts.screenEffect ?? 'none',
        forwarded: opts.forwarded,
      };
      dispatch({ type: 'push', message: msg });
      dispatch({ type: 'draft', chatId, value: '' });
      if (state.settings.sendWithSound) playSend();
      if (msg.screenEffect && msg.screenEffect !== 'none') fireEffect(msg.screenEffect);
      deliver(chatId, id, opts.text);
    },
    [state.chats, state.settings.sendWithSound, deliver, fireEffect],
  );

  /** Tap a "Not Delivered" bubble to try again. */
  const retrySend = useCallback(
    (messageId: string) => {
      const msg = state.messages.find((m) => m.id === messageId);
      if (!msg || msg.status !== 'failed') return;
      dispatch({ type: 'status', id: messageId, status: 'sending' });
      deliver(msg.chatId, messageId, msg.text);
    },
    [state.messages, deliver],
  );

  const startChatWith = useCallback(
    (contactIds: string[]) => {
      const existing = state.chats.find(
        (c) =>
          c.participantIds.length === contactIds.length &&
          contactIds.every((id) => c.participantIds.includes(id)),
      );
      if (existing) {
        dispatch({ type: 'select', chatId: existing.id });
        return existing.id;
      }
      const chat: Chat = {
        id: `c-${newId()}`,
        participantIds: contactIds,
        pinned: false,
        muted: false,
        unread: 0,
        draft: '',
        typing: false,
        sms: contactIds.length === 1 && !!state.contacts[contactIds[0]]?.sms,
        lastReadAt: Date.now(),
      };
      dispatch({ type: 'new-chat', chat });
      return chat.id;
    },
    [state.chats, state.contacts],
  );

  const reset = useCallback(() => {
    const fresh = buildSeedStore();
    savedRef.current = fresh;
    stateRef.current = fresh;
    dispatch({ type: 'replace', store: fresh });
    // clear after the swap, and write the empty store so a pending save or
    // another tab cannot resurrect what was just deleted
    void clearState()
      .then(() => saveState(fresh))
      .then(() => broadcast(fresh));
  }, [broadcast]);

  const exportData = useCallback(() => exportState(state), [state]);  // async: inlines file bytes

  const importData = useCallback(async (file: File) => {
    const store = await importState(file);
    dispatch({ type: 'replace', store });
  }, []);

  const enableNotifications = useCallback(async () => {
    const result = await requestNotificationPermission();
    const granted = result === 'granted';
    dispatch({ type: 'settings', patch: { notifications: granted } });
    return granted;
  }, []);

  const activeChat = useMemo(
    () => state.chats.find((c) => c.id === state.activeChatId) ?? null,
    [state.chats, state.activeChatId],
  );

  const value: Ctx = {
    state,
    booted,
    dispatch,
    activeChat,
    messagesFor,
    chatTitle,
    chatContacts,
    send,
    retrySend,
    react,
    effect,
    fireEffect,
    startChatWith,
    reset,
    resolvedTheme,
    online,
    storageIssue,
    dismissStorageIssue: () => setStorageIssue(null),
    exportData,
    importData,
    enableNotifications,
    notificationsGranted: notificationsAllowed(),
    runningRun,
    cancelRun,
  };

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}
