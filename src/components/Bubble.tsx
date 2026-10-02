import React, { useEffect, useRef, useState } from 'react';
import type { Attachment, Message } from '../types';
import { TAPBACKS } from '../types';
import { useStore } from '../lib/context';
import { mmss, timeOfDay } from '../lib/time';
import { Avatar } from './Avatar';
import { Floating } from './Floating';
import MapCard from './MapCard';
import { downloadAttachment, openAttachment, useAttachmentUrl } from '../lib/blobs';
import { classify, describeType, fileTint, shortName, typeLabel } from '../lib/files';
import {
  IconCopy,
  IconForward,
  IconDownload,
  IconMore,
  IconOpen,
  IconPause,
  IconPlay,
  IconReply,
  IconSmiley,
  IconTrash,
  IconX,
} from './Icons';
import { ForwardModal } from './ForwardModal';

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|\uFE0F|\u200D|\s){1,9}$/u;

function isJumbo(text: string) {
  const t = text.trim();
  if (!t || t.length > 12) return false;
  return EMOJI_ONLY.test(t) && /\p{Extended_Pictographic}/u.test(t);
}

function linkify(text: string) {
  const parts = text.split(/(https?:\/\/[^\s]+|www\.[^\s]+)/g);
  return parts.map((p, i) =>
    /^(https?:\/\/|www\.)/.test(p) ? (
      <a key={i} href={p.startsWith('http') ? p : `https://${p}`} target="_blank" rel="noreferrer">
        {p}
      </a>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

/* ───────────────────────── invisible ink ───────────────────────── */
function InkOverlay({ active }: { active: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!active) return;
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const resize = () => {
      const r = cv.getBoundingClientRect();
      cv.width = Math.max(1, r.width * dpr);
      cv.height = Math.max(1, r.height * dpr);
    };
    resize();
    const N = 220;
    const pts = Array.from({ length: N }, () => ({
      x: Math.random(),
      y: Math.random(),
      v: 0.2 + Math.random() * 0.8,
      p: Math.random() * Math.PI * 2,
    }));
    const draw = () => {
      ctx.clearRect(0, 0, cv.width, cv.height);
      const t = performance.now() / 700;
      for (const p of pts) {
        const a = (Math.sin(t * p.v + p.p) + 1) / 2;
        ctx.fillStyle = `rgba(190,190,200,${0.15 + a * 0.75})`;
        const x = p.x * cv.width + Math.sin(t * 0.4 + p.p) * 2;
        const y = p.y * cv.height + Math.cos(t * 0.5 + p.p) * 2;
        ctx.fillRect(x, y, dpr, dpr);
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    window.addEventListener('resize', resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, [active]);
  if (!active) return null;
  return <canvas ref={ref} />;
}

/* ───────────────────────── audio attachment ───────────────────────── */
/**
 * Plays a real recording when there is one. Seeded and historical messages
 * carry a waveform but no audio, so the simulated scrub is kept as the
 * fallback rather than showing a play button that does nothing.
 */
function AudioAtt({ att, out }: { att: Attachment; out: boolean }) {
  const url = useAttachmentUrl(att);
  const real = !!url;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(att.duration ?? 12);

  // real playback: the element is the source of truth for time and duration
  useEffect(() => {
    if (!real) return;
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => setT(el.currentTime);
    const onEnd = () => {
      setPlaying(false);
      setT(0);
      el.currentTime = 0;
    };
    const onMeta = () => {
      // webm from MediaRecorder often reports Infinity until it is seeked
      if (Number.isFinite(el.duration) && el.duration > 0) setDur(el.duration);
    };
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('ended', onEnd);
    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('durationchange', onMeta);
    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('ended', onEnd);
      el.removeEventListener('loadedmetadata', onMeta);
      el.removeEventListener('durationchange', onMeta);
    };
  }, [real]);

  // simulated scrub for memos that have no audio behind them
  useEffect(() => {
    if (real || !playing) return;
    const start = performance.now() - t * 1000;
    let raf = 0;
    const tick = () => {
      const el = (performance.now() - start) / 1000;
      if (el >= dur) {
        setT(0);
        setPlaying(false);
        return;
      }
      setT(el);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, dur, real]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = () => {
    if (!real) {
      setPlaying((p) => !p);
      return;
    }
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      void el.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    } else {
      el.pause();
      setPlaying(false);
    }
  };

  const seek = (ratio: number) => {
    const to = Math.max(0, Math.min(1, ratio)) * dur;
    setT(to);
    if (real && audioRef.current) audioRef.current.currentTime = to;
  };

  const wf = att.waveform ?? Array.from({ length: 32 }, (_, i) => 0.3 + Math.abs(Math.sin(i)) * 0.6);
  const progress = dur > 0 ? t / dur : 0;

  return (
    <div className={`att-audio ${out ? 'out' : 'in'}`}>
      {real && <audio ref={audioRef} src={url} preload="metadata" />}
      <button
        onClick={toggle}
        aria-label={playing ? 'Pause' : 'Play'}
        style={{ display: 'grid', placeItems: 'center', width: 22, height: 22 }}
      >
        {playing ? <IconPause /> : <IconPlay />}
      </button>
      <div
        className="waveform"
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          seek((e.clientX - r.left) / r.width);
        }}
      >
        {wf.map((h, i) => (
          <i key={i} className={i / wf.length <= progress ? 'on' : ''} style={{ height: `${h * 100}%` }} />
        ))}
      </div>
      <span className="audio-dur">{mmss(playing || t > 0 ? Math.max(0, dur - t) : dur)}</span>
    </div>
  );
}

function AttachmentView({
  att,
  out,
  onZoom,
}: {
  att: Attachment;
  out: boolean;
  onZoom: (src: string) => void;
}) {
  if (att.kind === 'image' && att.src)
    return (
      <div
        className="att-image"
        onClick={() => onZoom(att.src!)}
        // reserving the aspect ratio stops the thread from jumping while photos decode
        style={att.width && att.height ? { aspectRatio: `${att.width} / ${att.height}` } : undefined}
      >
        <img
          src={att.src}
          alt=""
          onLoad={(e) =>
            e.currentTarget.dispatchEvent(new CustomEvent('att-load', { bubbles: true }))
          }
        />
      </div>
    );
  if (att.kind === 'audio') return <AudioAtt att={att} out={out} />;
  if (att.kind === 'location' && typeof att.lat === 'number' && typeof att.lon === 'number')
    return <MapCard lat={att.lat} lon={att.lon} accuracy={att.accuracy} name={att.name} />;
  if (att.kind === 'link')
    return (
      <a className="att-link" href={att.src} target="_blank" rel="noreferrer">
        <div className="lk-hero" />
        <div className="lk-body">
          <div className="lk-title">{att.title}</div>
          {att.description && <div className="lk-desc">{att.description}</div>}
          <div className="lk-domain">{att.domain}</div>
        </div>
      </a>
    );
  if (att.kind === 'video') return <VideoAtt att={att} />;
  if (att.kind === 'file') return <FileAtt att={att} />;
  return null;
}

/* ───────────────────────── video attachment ───────────────────────── */
function VideoAtt({ att }: { att: Attachment }) {
  const url = useAttachmentUrl(att);
  return (
    <div className="att-video">
      {/* preload="metadata" so the poster frame and duration appear without
          pulling the whole file into memory on thread open */}
      <video src={url} controls preload="metadata" playsInline />
      <div className="att-video-bar">
        <span className="fname">{shortName(att.name ?? 'Video', 26)}</span>
        <span className="fsize">{att.size}</span>
        <button
          className="att-act"
          onClick={() => downloadAttachment(att)}
          aria-label={`Download ${att.name ?? 'video'}`}
          title="Download"
        >
          <IconDownload size={13} />
        </button>
      </div>
    </div>
  );
}

/* ───────────────────────── any other file ───────────────────────── */
function FileAtt({ att }: { att: Attachment }) {
  const cls = classify(att.type ?? '', att.name ?? '');
  const has = !!att.blob || !!att.src;
  // PDFs, text and code are things a browser can actually show
  const viewable = has && (cls === 'pdf' || cls === 'text' || cls === 'image');

  return (
    <div className="att-file">
      <div className="ft" style={{ background: fileTint(att.name ?? '') }}>
        {typeLabel(att.name ?? '')}
      </div>
      <div className="fmeta">
        <div className="fname" title={att.name}>
          {shortName(att.name ?? 'File', 28)}
        </div>
        <div className="fsize">
          {describeType(att.type ?? '', att.name ?? '')}
          {att.size ? ` · ${att.size}` : ''}
        </div>
      </div>
      <div className="facts">
        {att.unavailable && <span className="att-unavailable">Unavailable</span>}
        {viewable && (
          <button
            className="att-act"
            onClick={() => openAttachment(att)}
            aria-label={`Open ${att.name ?? 'file'}`}
            title="Open"
          >
            <IconOpen size={13} />
          </button>
        )}
        {has && (
          <button
            className="att-act"
            onClick={() => downloadAttachment(att)}
            aria-label={`Download ${att.name ?? 'file'}`}
            title="Download"
          >
            <IconDownload size={13} />
          </button>
        )}
      </div>
    </div>
  );
}

/* ───────────────────────── bubble ───────────────────────── */
export interface BubbleProps {
  msg: Message;
  showAvatar: boolean;
  showName: boolean;
  isTail: boolean;
  isStart: boolean;
  isGroup: boolean;
  sms: boolean;
  fresh: boolean;
  receipt?: string;
  onReply: (m: Message) => void;
  onZoom: (src: string) => void;
  onJumpTo: (id: string) => void;
}

function BubbleBase({
  msg,
  showAvatar,
  showName,
  isTail,
  isStart,
  isGroup,
  sms,
  fresh,
  receipt,
  onReply,
  onZoom,
  onJumpTo,
}: BubbleProps) {
  const { state, dispatch, react, retrySend } = useStore();
  const [forwarding, setForwarding] = useState(false);
  const out = msg.authorId === 'me';
  const author = out ? null : state.contacts[msg.authorId];
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(msg.text);
  const replyTarget = msg.replyTo ? state.messages.find((m) => m.id === msg.replyTo) : undefined;

  const ink = msg.bubbleEffect === 'invisible' && !msg.revealed;
  const jumbo = isJumbo(msg.text) && msg.attachments.length === 0;
  const bareAttachment = !msg.text && msg.attachments.length > 0;

  const effectClass =
    fresh && msg.bubbleEffect === 'slam'
      ? 'fx-slam'
      : fresh && msg.bubbleEffect === 'loud'
        ? 'fx-loud'
        : fresh && msg.bubbleEffect === 'gentle'
          ? 'fx-gentle'
          : fresh
            ? 'anim-in'
            : '';

  const grouped = new Map<string, { glyph: string; by: string[]; mine: boolean }>();
  for (const r of msg.reactions) {
    const tb = TAPBACKS.find((t) => t.id === r.type)!;
    const g = grouped.get(r.type) ?? { glyph: tb.glyph, by: [], mine: false };
    g.by.push(r.by);
    if (r.by === 'me') g.mine = true;
    grouped.set(r.type, g);
  }
  const myReaction = msg.reactions.find((r) => r.by === 'me');

  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  };

  const content = (
    <>
      {msg.subject && <b className="subject">{msg.subject}</b>}
      {editing ? (
        <input
          autoFocus
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              dispatch({ type: 'edit', id: msg.id, text: editText });
              setEditing(false);
            }
            if (e.key === 'Escape') setEditing(false);
          }}
          style={{
            background: 'rgba(255,255,255,.18)',
            border: 'none',
            outline: 'none',
            color: 'inherit',
            font: 'inherit',
            borderRadius: 6,
            padding: '1px 4px',
            minWidth: 160,
          }}
        />
      ) : (
        <>
          {linkify(msg.text)}
          {msg.edited && <span className="edited-tag">Edited</span>}
        </>
      )}
    </>
  );

  return (
    <>
      <div
        className={`row ${out ? 'out' : 'in'} ${isStart ? 'start' : 'grouped'}`}
        id={`msg-${msg.id}`}
      >
        {!out && isGroup && (
          <div className="slot-avatar">{showAvatar && author && <Avatar contact={author} />}</div>
        )}

        <div className="stack">
          {showName && isGroup && !out && author && <div className="sender-name">{author.name.split(' ')[0]}</div>}

          {msg.forwarded && (
            <div className={`forwarded-tag ${out ? 'out' : 'in'}`}>
              <IconForward size={11} /> Forwarded
            </div>
          )}

          {replyTarget && (
            <div className="reply-quote" onClick={() => onJumpTo(replyTarget.id)}>
              <span className="rq-author">
                {replyTarget.authorId === 'me' ? 'You' : state.contacts[replyTarget.authorId]?.name}
              </span>
              <span className="rq-text">{replyTarget.text || 'Attachment'}</span>
            </div>
          )}

          <div className="bubble-wrap">
            {msg.unsent ? (
              <div className="bubble unsent">You unsent a message</div>
            ) : bareAttachment ? (
              <div
                style={{ position: 'relative' }}
                className={effectClass}
                onContextMenu={openMenu}
              >
                {msg.attachments.map((a) => (
                  <AttachmentView key={a.id} att={a} out={out} onZoom={onZoom} />
                ))}
                {grouped.size > 0 && (
                  <div className="tapbacks">
                    {[...grouped.values()].map((g, i) => (
                      <div key={i} className={`tapback ${g.mine ? 'mine' : ''}`}>
                        {g.glyph}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div
                className={`bubble ${out ? 'out' : 'in'} ${sms ? 'sms' : ''} ${isTail ? 'tail' : ''} ${
                  jumbo ? 'jumbo' : ''
                } ${effectClass} ${ink ? 'ink' : ''} ${msg.streaming === true ? 'streaming' : ''}`}
                onContextMenu={openMenu}
                onClick={() => ink && dispatch({ type: 'reveal', id: msg.id })}
                title={ink ? 'Click to reveal' : undefined}
              >
                {msg.attachments.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 5 }}>
                    {msg.attachments.map((a) => (
                      <AttachmentView key={a.id} att={a} out={out} onZoom={onZoom} />
                    ))}
                  </div>
                )}
                {ink ? <span className="ink-content">{content}</span> : content}
                {msg.trust === 'FOREIGN' && (
                  <span className="trust-tag" title="This came from outside; the agent treats it as untrusted">
                    foreign
                  </span>
                )}
                <InkOverlay active={ink} />
                {grouped.size > 0 && (
                  <div className="tapbacks">
                    {[...grouped.values()].map((g, i) => (
                      <div key={i} className={`tapback ${g.mine ? 'mine' : ''}`} title={g.by.join(', ')}>
                        {g.glyph}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="row-actions">
              <button
                className="row-action"
                title="Tapback"
                aria-label="Add a tapback"
                onClick={(e) => {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setMenu({ x: r.left, y: r.top - 6 });
                }}
              >
                <IconSmiley size={14} />
              </button>
              <button className="row-action" title="Reply" aria-label="Reply to this message" onClick={() => onReply(msg)}>
                <IconReply />
              </button>
              <button className="row-action" title="More" aria-label="More actions" onClick={openMenu}>
                <IconMore />
              </button>
            </div>
            <span className="row-time">{timeOfDay(msg.at)}</span>
          </div>
        </div>
      </div>

      {out && msg.status === 'failed' ? (
        <div className="row out" style={{ padding: 0 }}>
          <span className="failed-row">
            Not Delivered
            <button className="retry-btn" onClick={() => retrySend(msg.id)}>
              Try Again
            </button>
          </span>
        </div>
      ) : (
        receipt && (
          <div className="row out" style={{ padding: 0 }}>
            <span className="receipt">{receipt}</span>
          </div>
        )
      )}

      {menu && (
        <Floating
          x={menu.x}
          y={menu.y}
          place={menu.y > window.innerHeight / 2 ? 'top-start' : 'bottom-start'}
          onClose={() => setMenu(null)}
        >
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div className="tapback-bar">
              {TAPBACKS.map((t) => (
                <button
                  key={t.id}
                  className={myReaction?.type === t.id ? 'chosen' : ''}
                  title={t.label}
                  aria-label={t.label}
                  aria-pressed={myReaction?.type === t.id}
                  onClick={() => {
                    react(msg.id, t.id);
                    setMenu(null);
                  }}
                >
                  <span aria-hidden="true">{t.glyph}</span>
                </button>
              ))}
            </div>
            <div className="menu-sep" />
            <div className="menu">
              <button
                className="menu-item"
                onClick={() => {
                  onReply(msg);
                  setMenu(null);
                }}
              >
                <IconReply /> Reply
              </button>
              <button
                className="menu-item"
                onClick={() => {
                  void navigator.clipboard?.writeText(msg.text);
                  setMenu(null);
                }}
              >
                <IconCopy /> Copy
              </button>
              <button
                className="menu-item"
                onClick={() => {
                  setForwarding(true);
                  setMenu(null);
                }}
              >
                <IconForward /> Forward…
              </button>
              {out && !msg.unsent && (
                <>
                  <button
                    className="menu-item"
                    onClick={() => {
                      setEditText(msg.text);
                      setEditing(true);
                      setMenu(null);
                    }}
                  >
                    <IconCopy /> Edit
                  </button>
                  <button
                    className="menu-item"
                    onClick={() => {
                      dispatch({ type: 'unsend', id: msg.id });
                      setMenu(null);
                    }}
                  >
                    <IconX /> Undo Send
                  </button>
                </>
              )}
              <div className="menu-sep" />
              <button
                className="menu-item danger"
                onClick={() => {
                  dispatch({ type: 'delete', id: msg.id });
                  setMenu(null);
                }}
              >
                <IconTrash /> Delete
              </button>
            </div>
          </div>
        </Floating>
      )}

      {forwarding && <ForwardModal msg={msg} onClose={() => setForwarding(false)} />}
    </>
  );
}

/* Bubbles are pure for a given message + layout flags: skip re-rendering the
   hundreds of untouched bubbles whenever one message changes. */
export const Bubble = React.memo(BubbleBase, (a, b) => {
  return (
    a.msg === b.msg &&
    a.showAvatar === b.showAvatar &&
    a.showName === b.showName &&
    a.isTail === b.isTail &&
    a.isStart === b.isStart &&
    a.isGroup === b.isGroup &&
    a.sms === b.sms &&
    a.fresh === b.fresh &&
    a.receipt === b.receipt &&
    a.onReply === b.onReply &&
    a.onZoom === b.onZoom &&
    a.onJumpTo === b.onJumpTo
  );
});
