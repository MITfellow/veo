import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Attachment, Chat, Message } from '../types';
import { useStore } from '../lib/context';
import { needsSeparator, sameGroup, separatorStamp, timeOfDay, separatorStamp as stampOf } from '../lib/time';
import { Avatar } from './Avatar';
import { ApprovalCard } from './ApprovalCard';
import { Bubble } from './Bubble';
import TraceSheet from './TraceSheet';
import { Lightbox, type LightboxItem } from './Lightbox';

export function MessageList({
  chat,
  onReply,
}: {
  chat: Chat;
  onReply: (m: Message) => void;
}) {
  const { state, messagesFor, chatContacts, send } = useStore();
  const all = useMemo(() => messagesFor(chat.id), [messagesFor, chat.id]);

  /* Long threads only mount their tail — "Load earlier" walks backwards a page
     at a time, which keeps a 5,000-message conversation at 60fps. */
  // one viewport's worth plus slack; older messages arrive via Load Earlier.
  // 120 made every thread switch render ~120 bubbles (~570ms on a big account)
  const PAGE = 50;
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [chat.id]);
  const hidden = Math.max(0, all.length - limit);
  const msgs = useMemo(() => (hidden > 0 ? all.slice(hidden) : all), [all, hidden]);
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const seen = useRef<Set<string>>(new Set());
  const firstPaint = useRef(true);
  const [zoom, setZoom] = useState<string | null>(null);
  /** §30 — the run whose trace is open, if the user asked. */
  const [traceRunId, setTraceRunId] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [dragging, setDragging] = useState(false);

  /** the first of the last N incoming messages, N = unread count */
  const firstUnreadOf = useCallback(
    (list: Message[], unread: number, lastReadAt: number) => {
      if (unread <= 0) return null;
      const incoming = list.filter((m) => m.authorId !== 'me' && !m.system);
      const byTime = incoming.find((m) => m.at > lastReadAt);
      const byCount = incoming[Math.max(0, incoming.length - unread)];
      return (byTime ?? byCount)?.id ?? null;
    },
    [],
  );

  /* Snapshot the unread watermark when the thread opens so the divider doesn't
     vanish the moment the chat is marked read. */
  const [marker, setMarker] = useState<{ chatId: string; firstUnreadId: string | null }>({
    chatId: chat.id,
    firstUnreadId: null,
  });
  if (marker.chatId !== chat.id) {
    // `unread` is already cleared by the select action, so fall back to 1
    setMarker({
      chatId: chat.id,
      firstUnreadId: firstUnreadOf(all, Math.max(chat.unread, 1), chat.lastReadAt),
    });
  }
  const people = chatContacts(chat);

  // every photo in the thread, so Quick Look can page through them
  const photos = useMemo<LightboxItem[]>(
    () =>
      all.flatMap((m) =>
        (m.attachments ?? [])
          .filter((a) => a.kind === 'image' && a.src)
          .map((a) => ({
            src: a.src!,
            caption: `${m.authorId === 'me' ? 'You' : state.contacts[m.authorId]?.name ?? 'Unknown'} · ${stampOf(m.at)}`,
          })),
      ),
    [all, state.contacts],
  );
  const isGroup = people.length > 1;

  const didInitMarker = useRef(false);
  useLayoutEffect(() => {
    if (didInitMarker.current) return;
    didInitMarker.current = true;
    const id = firstUnreadOf(all, chat.unread, chat.lastReadAt);
    if (id) setMarker({ chatId: chat.id, firstUnreadId: id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // mark everything present on mount as "already seen" so nothing animates on open
  useLayoutEffect(() => {
    seen.current = new Set(msgs.map((m) => m.id));
    firstPaint.current = true;
    stick.current = true;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    const t = window.setTimeout(() => {
      firstPaint.current = false;
    }, 60);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.id]);

  // keep pinned to the bottom when near it
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance < 260) {
      el.scrollTo({ top: el.scrollHeight, behavior: firstPaint.current ? 'auto' : 'smooth' });
    }
  }, [msgs.length, chat.typing]);

  /* Images and link cards change height after layout — stay glued to the bottom
     while the user hasn't scrolled away. */
  useEffect(() => {
    const el = scroller.current;
    const content = inner.current;
    if (!el || !content) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      stick.current = distance < 80;
      setAtBottom(distance < 40);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const onAttLoad = () => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    };
    el.addEventListener('att-load', onAttLoad);
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    ro.observe(el); // the composer growing shrinks the viewport too
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('att-load', onAttLoad);
      ro.disconnect();
    };
  }, [chat.id]);

  const loadEarlier = () => {
    const el = scroller.current;
    const before = el?.scrollHeight ?? 0;
    setLimit((n) => n + PAGE);
    requestAnimationFrame(() => {
      if (el) el.scrollTop += el.scrollHeight - before;
    });
  };

  const scrollToBottom = useCallback(() => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, []);

  const jumpTo = (id: string) => {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.animate(
      [
        { backgroundColor: 'rgba(10,132,255,0)' },
        { backgroundColor: 'rgba(10,132,255,0.16)' },
        { backgroundColor: 'rgba(10,132,255,0)' },
      ],
      { duration: 1200, easing: 'ease-out' },
    );
  };

  // the sidebar's message search asks the thread to scroll to a hit
  useEffect(() => {
    const onJump = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (!id) return;
      // make sure the message is actually mounted before scrolling to it
      const index = all.findIndex((m) => m.id === id);
      if (index >= 0 && all.length - index > limit) setLimit(all.length - index + 20);
      requestAnimationFrame(() => requestAnimationFrame(() => jumpTo(id)));
    };
    window.addEventListener('jump-to-message', onJump);
    return () => window.removeEventListener('jump-to-message', onJump);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, limit]);

  const lastOutgoing = [...msgs].reverse().find((m) => m.authorId === 'me' && !m.unsent);

  const receiptFor = (m: Message): string | undefined => {
    if (!lastOutgoing || m.id !== lastOutgoing.id) return undefined;
    if (m.status === 'sending') return 'Sending…';
    if (m.status === 'failed') return 'Not Delivered';
    if (m.status === 'read' && state.settings.readReceipts)
      return `Read ${m.readAt ? timeOfDay(m.readAt) : ''}`.trim();
    if (m.status === 'delivered' || m.status === 'read') return 'Delivered';
    return undefined;
  };

  return (
    <div
      className={`messages ${state.settings.density === 'compact' ? 'compact' : ''} ${dragging ? 'dropping' : ''}`}
      ref={scroller}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files?.length) return;
        e.preventDefault();
        setDragging(false);
        const files = Array.from(e.dataTransfer.files).slice(0, 6);
        let pending = files.length;
        const attachments: Attachment[] = [];
        const flush = () => {
          if (--pending === 0 && attachments.length) send(chat.id, { text: '', attachments });
        };
        files.forEach((f, i) => {
          if (f.type.startsWith('image/')) {
            const reader = new FileReader();
            reader.onload = () => {
              attachments.push({ id: `d${Date.now()}${i}`, kind: 'image', src: String(reader.result) });
              flush();
            };
            reader.onerror = flush;
            reader.readAsDataURL(f);
          } else {
            attachments.push({
              id: `d${Date.now()}${i}`,
              kind: 'file',
              name: f.name,
              size: `${(f.size / 1024 / 1024).toFixed(1)} MB`,
            });
            flush();
          }
        });
      }}
    >
      <div className="messages-inner" ref={inner} role="log" aria-live="polite" aria-relevant="additions text" aria-label="Conversation">
      {hidden > 0 && (
        <button className="load-earlier" onClick={loadEarlier}>
          Load {Math.min(PAGE, hidden)} earlier message{Math.min(PAGE, hidden) === 1 ? '' : 's'}
        </button>
      )}
      {msgs.length === 0 && (
        <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>
          <div style={{ fontSize: 34, marginBottom: 6 }}>💬</div>
          Say hello to {people.map((p) => p.name.split(' ')[0]).join(', ')}
        </div>
      )}

      {msgs.map((m, i) => {
        const prev = msgs[i - 1];
        const next = msgs[i + 1];
        const sep = needsSeparator(prev?.at ?? null, m.at);
        const startsGroup = sep || !prev || !sameGroup(prev, m);
        const endsGroup = !next || !sameGroup(m, next) || needsSeparator(m.at, next.at);
        const fresh = !seen.current.has(m.id);
        if (fresh) seen.current.add(m.id);
        const stamp = separatorStamp(m.at);

        return (
          <div key={m.id}>
            {marker.firstUnreadId === m.id && (
              <div className="unread-sep" role="separator" aria-label="Unread messages">
                <span>Unread Messages</span>
              </div>
            )}
            {sep && (
              <div className="day-sep">
                <b>{stamp.lead}</b> {stamp.time}
              </div>
            )}
            {m.approval !== undefined ? (
              <ApprovalCard msg={m} />
            ) : m.system ? (
              <div className="system-note">{m.text}</div>
            ) : (
              <Bubble
                msg={m}
                isGroup={isGroup}
                sms={chat.sms}
                showAvatar={endsGroup}
                showName={startsGroup}
                isTail={endsGroup}
                isStart={startsGroup}
                fresh={fresh && !firstPaint.current}
                receipt={receiptFor(m)}
                onReply={onReply}
                onZoom={setZoom}
                onJumpTo={jumpTo}
              />
            )}
            {m.runId !== undefined && !m.system ? (
              <button
                className="why-btn"
                onClick={() => setTraceRunId(m.runId ?? null)}
                title="See the context, the tools and the constitution checks behind this reply"
              >
                Why did it say that?
              </button>
            ) : null}
          </div>
        );
      })}

      {chat.typing && (
        <div className="row in start" aria-label="Typing">
          {isGroup && (
            <div className="slot-avatar">
              <Avatar contact={(chat.typingBy && state.contacts[chat.typingBy]) || people[0]} />
            </div>
          )}
          <div className="stack">
            <div className="typing-bubble">
              <i />
              <i />
              <i />
            </div>
          </div>
        </div>
      )}

      <div style={{ height: 6 }} />
      </div>

      {!atBottom && (
        <button className="jump-bottom" onClick={scrollToBottom} aria-label="Scroll to latest message">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M19 12l-7 7-7-7" />
          </svg>
        </button>
      )}

      {dragging && (
        <div className="drop-hint" aria-hidden="true">
          <div className="drop-card">Drop to send</div>
        </div>
      )}

      {zoom && <Lightbox items={photos} startSrc={zoom} onClose={() => setZoom(null)} />}
      {traceRunId !== null && (
        <TraceSheet runId={traceRunId} onClose={() => setTraceRunId(null)} />
      )}
    </div>
  );
}
