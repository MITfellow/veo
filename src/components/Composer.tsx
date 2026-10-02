import { useCallback, useEffect, useRef, useState } from 'react';
import type { Attachment, BubbleEffect, Chat, Message, ScreenEffect } from '../types';
import { BUBBLE_EFFECTS, SCREEN_EFFECTS } from '../types';
import { useStore } from '../lib/context';
import { EMOJI } from '../data/emoji';
import { mmss } from '../lib/time';
import { Floating } from './Floating';
import {
  IconCamera,
  IconLocation,
  IconMic,
  IconPhotos,
  IconPlus,
  IconSend,
  IconSmiley,
  IconSparkle,
  IconStop,
  IconSubject,
  IconWave,
  IconX,
} from './Icons';
import { AttachTray, type Staged } from './AttachTray';
import { Lightbox } from './Lightbox';
import {
  MAX_BYTES,
  MAX_FILES,
  classify,
  decodeImage,
  describeType,
  fileKey,
  humanSize,
  isImageFile,
  rejectReason,
  totalReason,
} from '../lib/files';
import CameraSheet from './CameraSheet';
import {
  AudioRecording,
  cameraSupported,
  currentPosition,
  locationSupported,
  MediaError,
  micSupported,
  type Capture,
} from '../lib/media';
import { accuracyLabel } from '../lib/mapart';
import { consumeLaunchFiles } from '../lib/install';

/** A voice memo longer than this is almost certainly a forgotten tap. */
const MAX_RECORDING_SECONDS = 180;

let aid = 0;
const attId = () => `att${Date.now().toString(36)}${aid++}`;

export function Composer({
  chat,
  replyTo,
  clearReply,
}: {
  chat: Chat;
  replyTo: Message | null;
  clearReply: () => void;
}) {
  const { state, dispatch, send, chatTitle, runningRun, cancelRun } = useStore();
  const [staged, setStaged] = useState<Staged[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [zoom, setZoom] = useState<string | null>(null);
  const dragDepth = useRef(0);
  // mirrors `staged` so addFiles can compute the next tray synchronously —
  // collecting notices inside a setState updater loses them, because the
  // updater runs after the call that would have read them (and twice in
  // StrictMode)
  const stagedRef = useRef<Staged[]>([]);
  const [subject, setSubject] = useState<string | null>(null);
  const [bubbleFx, setBubbleFx] = useState<BubbleEffect>('none');
  const [screenFx, setScreenFx] = useState<ScreenEffect>('none');
  const [pop, setPop] = useState<null | { kind: 'emoji' | 'apps' | 'fx'; x: number; y: number }>(null);
  // real microphone capture: `rec` is the live take, `elapsed`/`level` drive
  // the meter, and the whole thing is torn down on unmount so the mic light
  // never stays on after the composer goes away
  const recRef = useRef<AudioRecording | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [busy, setBusy] = useState<null | 'mic' | 'location'>(null);
  const [camera, setCamera] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /**
   * Typing is local. Pushing every keystroke into the global store re-renders
   * the whole window — 40 sidebar rows and every bubble — which measured ~127ms
   * per key on a big account. The store is updated on a trailing debounce (and
   * flushed on send, blur, and chat switch) so drafts still survive reloads.
   */
  const [localDraft, setLocalDraft] = useState(chat.draft);
  const draft = localDraft;
  const draftRef = useRef(chat.draft);
  const flushRef = useRef<number | null>(null);
  const chatIdRef = useRef(chat.id);

  const autosize = () => {
    const el = ta.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(160, el.scrollHeight)}px`;
  };
  useEffect(autosize, [draft, subject]);
  useEffect(() => {
    ta.current?.focus();
  }, [chat.id]);

  const flushDraft = useCallback(() => {
    if (flushRef.current !== null) {
      window.clearTimeout(flushRef.current);
      flushRef.current = null;
    }
    const chatId = chatIdRef.current;
    const value = draftRef.current;
    dispatch({ type: 'draft', chatId, value });
  }, [dispatch]);

  const setDraft = (value: string) => {
    setLocalDraft(value);
    draftRef.current = value;
    if (flushRef.current !== null) window.clearTimeout(flushRef.current);
    flushRef.current = window.setTimeout(flushDraft, 400);
  };

  // switching threads: commit the old draft, then adopt the new one
  useEffect(() => {
    if (chatIdRef.current !== chat.id) {
      flushDraft();
      chatIdRef.current = chat.id;
      draftRef.current = chat.draft;
      setLocalDraft(chat.draft);
    }
  }, [chat.id, chat.draft, flushDraft]);

  // and never lose one on unmount
  useEffect(() => () => flushDraft(), [flushDraft]);

  useEffect(() => {
    stagedRef.current = staged;
  }, [staged]);

  const ready = staged.filter((f) => f.status === 'ready' && f.att);
  const canSend = draft.trim().length > 0 || ready.length > 0;
  /** Non-null while an agent run is streaming into this conversation. */
  const inFlight = runningRun(chat.id);

  const doSend = () => {
    if (!canSend) return;
    send(chat.id, {
      text: draft.trim(),
      subject: subject?.trim() || undefined,
      attachments: ready.map((f) => f.att!),
      replyTo: replyTo?.id,
      bubbleEffect: bubbleFx,
      screenEffect: screenFx,
    });
    setLocalDraft('');
    draftRef.current = '';
    if (flushRef.current !== null) {
      window.clearTimeout(flushRef.current);
      flushRef.current = null;
    }
    setStaged([]);
    setNotice(null);
    setSubject(null);
    setBubbleFx('none');
    setScreenFx('none');
    clearReply();
    window.requestAnimationFrame(autosize);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      doSend();
    }
    if (e.key === 'Escape' && replyTo) clearReply();
  };

  /** stage something we built ourselves (a memo, a stock photo, a location) */
  /**
   * The media callbacks must stay stable — re-creating them mid-recording
   * would restart the metering effect — so they reach the current `stage`
   * through a ref that is kept in sync by an effect below.
   */
  const stageRef = useRef<(att: Attachment, name: string, bytes?: number, detail?: string) => void>(
    () => {},
  );

  /* ── real microphone ─────────────────────────────────────────── */

  const startRecording = useCallback(async () => {
    if (recRef.current) return;
    setBusy('mic');
    try {
      recRef.current = await AudioRecording.start();
      setElapsed(0);
      setLevel(0);
      setRecording(true);
    } catch (e) {
      setNotice(e instanceof MediaError ? e.message : 'Could not start recording.');
    } finally {
      setBusy(null);
    }
  }, []);

  const finishRecording = useCallback(async () => {
    const rec = recRef.current;
    if (!rec) return;
    recRef.current = null;
    setRecording(false);
    try {
      const take = await rec.finish();
      stageRef.current(
        {
          id: attId(),
          kind: 'audio',
          src: take.src,
          duration: take.duration,
          waveform: take.waveform,
          mimeType: take.mimeType,
          size: humanSize(take.bytes),
        },
        'Voice memo',
        take.bytes,
        `${mmss(take.duration)} · ${humanSize(take.bytes)}`,
      );
    } catch (e) {
      setNotice(e instanceof MediaError ? e.message : 'The recording failed.');
    } finally {
      setElapsed(0);
      setLevel(0);
    }
  }, []);

  const cancelRecording = useCallback(() => {
    recRef.current?.cancel();
    recRef.current = null;
    setRecording(false);
    setElapsed(0);
    setLevel(0);
  }, []);

  /**
   * While a take is running, poll the recorder once per frame for its real
   * elapsed time and input level. Sampling here (rather than on a 1s timer)
   * is what lets the meter move with the speaker's voice.
   */
  useEffect(() => {
    if (!recording) return;
    let raf = 0;
    const tick = () => {
      const rec = recRef.current;
      if (rec) {
        setLevel(rec.level());
        const e = rec.elapsed;
        setElapsed(e);
        if (e >= MAX_RECORDING_SECONDS) {
          void finishRecording();
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [recording]); // eslint-disable-line react-hooks/exhaustive-deps

  // the microphone must not stay open if this composer unmounts mid-take
  useEffect(
    () => () => {
      recRef.current?.cancel();
      recRef.current = null;
    },
    [],
  );

  /* ── real camera ─────────────────────────────────────────────── */

  const onCapture = useCallback((shot: Capture) => {
    stageRef.current(
      {
        id: attId(),
        kind: 'image',
        src: shot.src,
        width: shot.width,
        height: shot.height,
        size: humanSize(shot.bytes),
      },
      `Photo · ${shot.width}×${shot.height}`,
      shot.bytes,
    );
  }, []);

  /* ── real location ───────────────────────────────────────────── */

  const shareLocation = useCallback(async () => {
    setBusy('location');
    try {
      const place = await currentPosition();
      stageRef.current(
        {
          id: attId(),
          kind: 'location',
          lat: place.lat,
          lon: place.lon,
          accuracy: place.accuracy,
          name: 'Current Location',
        },
        'Current Location',
        0,
        accuracyLabel(place.accuracy),
      );
    } catch (e) {
      setNotice(e instanceof MediaError ? e.message : 'Could not share your location.');
    } finally {
      setBusy(null);
    }
  }, []);

  const stage = (att: Attachment, name: string, bytes = 0, detail?: string) =>
    setStaged((a) => [
      ...a,
      {
        id: att.id,
        name,
        bytes,
        detail,
        status: 'ready',
        att,
        preview: att.kind === 'image' ? att.src : undefined,
      },
    ]);

  // refs cannot be written during render
  useEffect(() => {
    stageRef.current = stage;
  });

  /**
   * Stage files for sending. Images are decoded and downscaled off the main
   * send path so the tray can show a real thumbnail (and so a 12-megapixel
   * photo doesn't go into localStorage at full size); everything else lands
   * immediately as a typed chip.
   */
  /**
   * Double-clicking a photo or PDF in Finder/Explorer launches the installed
   * app with the file attached. The consumer is registered once; `addFilesRef`
   * keeps it pointed at the live handler (assigned below, after `addFiles`).
   */
  const addFilesRef = useRef<(files: File[]) => void>(() => {});

  const addFiles = (files: FileList | File[] | null) => {
    if (!files) return;
    const incoming = Array.from(files);
    if (!incoming.length) return;

    const notes: string[] = [];
    const prev = stagedRef.current;
    const commit = (next: Staged[]) => {
      stagedRef.current = next;
      setStaged(next);
      setNotice(notes[0] ?? null);
    };

    {
      const seen = new Set(prev.map((f) => fileKey({ name: f.name, size: f.bytes })));
      const room = MAX_FILES - prev.length;
      if (room <= 0) {
        notes.push(`You can attach ${MAX_FILES} files at a time`);
        commit(prev);
        return;
      }

      const next: Staged[] = [];
      let skipped = 0;
      for (const file of incoming) {
        if (next.length >= room) {
          skipped++;
          continue;
        }
        const key = fileKey(file);
        if (seen.has(key)) {
          notes.push(`${file.name} is already attached`);
          continue;
        }
        seen.add(key);

        const id = attId();
        const bad = rejectReason(file);
        if (bad) {
          next.push({ id, name: file.name, bytes: file.size, status: 'error', error: bad });
          continue;
        }

        const cls = classify(file.type, file.name);

        if (cls === 'image' && isImageFile(file.type, file.name)) {
          // images get a downscaled preview for the thread, but the original
          // file is kept alongside it so it can be downloaded intact
          next.push({ id, name: file.name, bytes: file.size, status: 'loading' });
          void decodeImage(file)
            .then(({ src, width, height }) =>
              setStaged((cur) =>
                cur.map((f) =>
                  f.id === id
                    ? {
                        ...f,
                        status: 'ready',
                        preview: src,
                        att: {
                          id,
                          kind: 'image',
                          src,
                          blob: file,
                          type: file.type,
                          bytes: file.size,
                          name: file.name,
                          size: humanSize(file.size),
                          width: width || undefined,
                          height: height || undefined,
                        },
                      }
                    : f,
                ),
              ),
            )
            .catch(() =>
              setStaged((cur) =>
                cur.map((f) =>
                  f.id === id ? { ...f, status: 'error', error: "Couldn't read this image" } : f,
                ),
              ),
            );
        } else {
          // everything else keeps its bytes verbatim — a PDF used to be sent
          // as nothing but a filename
          const kind = cls === 'video' ? 'video' : cls === 'audio' ? 'audio' : 'file';
          next.push({
            id,
            name: file.name,
            bytes: file.size,
            detail: `${describeType(file.type, file.name)} · ${humanSize(file.size)}`,
            status: 'ready',
            att: {
              id,
              kind,
              blob: file,
              type: file.type || 'application/octet-stream',
              bytes: file.size,
              name: file.name,
              size: humanSize(file.size),
            },
          });
        }
      }

      if (skipped) notes.push(`${skipped} file${skipped > 1 ? 's' : ''} skipped — ${MAX_FILES} at a time`);

      // one send must not swallow the whole storage quota
      const merged = [...prev, ...next];
      const total = merged.reduce((n, f) => n + (f.status === 'error' ? 0 : f.bytes), 0);
      const tooMuch = totalReason(total);
      if (tooMuch) {
        notes.unshift(tooMuch);
        commit(prev);
        return;
      }

      commit(merged);
    }
  };

  // kept in sync after `addFiles` exists, so the ref never reads it mid-init
  useEffect(() => {
    addFilesRef.current = addFiles;
  });

  useEffect(() => {
    consumeLaunchFiles((files) => addFilesRef.current(files));
  }, []);


  // the notice is transient; it should never outstay the thing it describes
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(t);
  }, [notice]);

  const openPop = (kind: 'emoji' | 'apps' | 'fx') => (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPop({ kind, x: r.left, y: r.top - 8 });
  };

  /** always hand focus back to the field so Return still sends */
  const closePop = () => {
    setPop(null);
    window.setTimeout(() => ta.current?.focus(), 0);
  };

  const fxActive = bubbleFx !== 'none' || screenFx !== 'none';

  return (
    <div
      className={`composer-wrap ${dragging ? 'dropping' : ''}`}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        dragDepth.current++;
        setDragging(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => {
        // dragleave fires for every child; only the last one counts
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        addFiles(e.dataTransfer.files);
      }}
      onMouseDown={(e) => {
        // clicking the empty area around the field always lands in the field
        if (e.target === e.currentTarget) {
          e.preventDefault();
          ta.current?.focus();
        }
      }}
    >
      {replyTo && (
        <div className="reply-banner">
          <span className="bar" />
          <div className="rb-text">
            <b style={{ color: 'var(--text)' }}>
              Replying to {replyTo.authorId === 'me' ? 'yourself' : state.contacts[replyTo.authorId]?.name}
            </b>
            {' · '}
            {replyTo.text || 'Attachment'}
          </div>
          <button className="icon-btn plain" style={{ width: 20, height: 20 }} onClick={clearReply}>
            <IconX size={12} />
          </button>
        </div>
      )}

      {fxActive && (
        <div className="reply-banner" style={{ background: 'rgba(10,132,255,.12)' }}>
          <IconSparkle size={13} />
          <div className="rb-text">
            Sending with{' '}
            <b style={{ color: 'var(--text)' }}>
              {[
                BUBBLE_EFFECTS.find((b) => b.id === bubbleFx)?.label,
                SCREEN_EFFECTS.find((s) => s.id === screenFx)?.label,
              ]
                .filter(Boolean)
                .join(' + ')}
            </b>
          </div>
          <button
            className="icon-btn plain"
            style={{ width: 20, height: 20 }}
            onClick={() => {
              setBubbleFx('none');
              setScreenFx('none');
            }}
          >
            <IconX size={12} />
          </button>
        </div>
      )}

      <AttachTray
        items={staged}
        notice={notice}
        onRemove={(id) => setStaged((x) => x.filter((y) => y.id !== id))}
        onClear={() => {
          setStaged([]);
          setNotice(null);
        }}
        onPreview={setZoom}
      />

      {recording && (
        <div className="rec-bar" role="status" aria-live="polite">
          <span className="rec-dot" />
          <div className="rb-text">
            Recording <span className="rec-time">{mmss(elapsed)}</span>
          </div>
          {/* a live meter off the real input level: silence looks like silence */}
          <div className="rec-meter" aria-hidden="true">
            {Array.from({ length: 18 }, (_, i) => (
              <i
                key={i}
                style={{
                  height: `${Math.max(8, Math.min(100, level * 130 * (0.55 + Math.sin(i * 1.7 + elapsed * 6) * 0.45)))}%`,
                }}
              />
            ))}
          </div>
          <button className="btn primary" onClick={() => void finishRecording()}>
            <IconStop size={11} /> Stop
          </button>
          <button className="btn" onClick={cancelRecording}>
            Cancel
          </button>
        </div>
      )}

      <div className="composer">
        <button className="round" title="Apps & attachments" onClick={openPop('apps')}>
          <IconPlus />
        </button>

        <div className="field">
          <div className="field-col">
            {subject !== null && (
              <>
                <input
                  className="subject-input"
                  placeholder="Subject"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && ta.current?.focus()}
                />
                <div className="subject-divider" />
              </>
            )}
            <textarea
              ref={ta}
              rows={1}
              value={draft}
              placeholder={chat.sms ? 'Text Message' : 'Veo message'}
              aria-label={chat.sms ? 'Text Message' : 'Veo message'}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={(e) => {
                const items = e.clipboardData.files;
                if (items?.length) {
                  e.preventDefault();
                  addFiles(items);
                }
              }}
            />
          </div>
          {inFlight !== null ? (
            // A run that has gone wrong should be stoppable, not waited
            // out. `POST /runs/:id/cancel` has existed since M2 and
            // nothing in the UI called it.
            <button
              className="stop-btn"
              onClick={() => cancelRun(chat.id)}
              title="Stop this run"
              aria-label="Stop"
            >
              <span className="stop-square" aria-hidden="true" />
            </button>
          ) : canSend ? (
            <button className={`send-btn ${chat.sms ? 'sms' : ''}`} onClick={doSend} title="Send (Return)">
              <IconSend />
            </button>
          ) : (
            <button
              className="round bare"
              title={micSupported() ? 'Record an audio message' : 'No microphone available'}
              aria-label="Record an audio message"
              disabled={!micSupported() || recording || busy === 'mic'}
              onClick={() => void startRecording()}
            >
              <IconWave size={16} />
            </button>
          )}
        </div>

        <button className="round bare" title="Emoji & stickers" onClick={openPop('emoji')}>
          <IconSmiley size={18} />
        </button>
      </div>

      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          addFiles(e.target.files);
          e.target.value = '';
        }}
      />

      {pop?.kind === 'emoji' && (
        <Floating x={pop.x} y={pop.y} place="top-start" onClose={closePop} className="emoji-pop">
          {EMOJI.map((group) => (
            <div key={group.cat}>
              <div className="emoji-cat">{group.cat}</div>
              <div className="emoji-grid">
                {group.list.map((e, i) => (
                  <button
                    key={`${e}${i}`}
                    onClick={() => {
                      setDraft(draft + e);
                      ta.current?.focus();
                    }}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </Floating>
      )}

      {pop?.kind === 'apps' && (
        <Floating x={pop.x} y={pop.y} place="top-start" onClose={closePop} className="apps-pop">
          <div className="apps-grid">
            <button
              className="app-tile"
              onClick={() => {
                fileRef.current?.click();
                closePop();
              }}
            >
              <span className="glyph" style={{ background: 'linear-gradient(160deg,#ffd166,#ef476f)' }}>
                <IconPhotos size={17} />
              </span>
              Photos
            </button>
            <button
              className="app-tile"
              disabled={!cameraSupported()}
              title={cameraSupported() ? 'Take a photo' : 'No camera available'}
              onClick={() => {
                setCamera(true);
                closePop();
              }}
            >
              <span className="glyph" style={{ background: 'linear-gradient(160deg,#8e8e93,#48484a)' }}>
                <IconCamera size={17} />
              </span>
              Camera
            </button>
            <button
              className="app-tile"
              disabled={!micSupported() || recording}
              title={micSupported() ? 'Record a voice memo' : 'No microphone available'}
              onClick={() => {
                closePop();
                void startRecording();
              }}
            >
              <span className="glyph" style={{ background: 'linear-gradient(160deg,#ff6b6b,#c9184a)' }}>
                <IconMic size={16} />
              </span>
              Audio
            </button>
            <button
              className="app-tile"
              disabled={!locationSupported() || busy === 'location'}
              title={locationSupported() ? 'Share your current location' : 'Location is unavailable'}
              onClick={() => {
                closePop();
                void shareLocation();
              }}
            >
              <span className="glyph" style={{ background: 'linear-gradient(160deg,#5ac8fa,#0a84ff)' }}>
                <IconLocation size={15} />
              </span>
              Location
            </button>
            <button
              className="app-tile"
              onClick={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setPop({ kind: 'fx', x: r.left, y: r.top - 8 });
              }}
            >
              <span
                className="glyph"
                style={{ background: fxActive ? 'var(--blue)' : 'linear-gradient(160deg,#ffd60a,#ff9f0a)' }}
              >
                <IconSparkle size={16} />
              </span>
              Effects
            </button>
            <button
              className="app-tile"
              onClick={() => {
                setSubject(subject === null ? '' : null);
                closePop();
              }}
            >
              <span className="glyph" style={{ background: 'linear-gradient(160deg,#a78bfa,#6c4dff)' }}>
                <IconSubject size={15} />
              </span>
              Subject
            </button>
          </div>
        </Floating>
      )}

      {pop?.kind === 'fx' && (
        <Floating x={pop.x} y={pop.y} place="top-start" onClose={closePop} className="effects-pop">
          <h4>Bubble Effects</h4>
          <div className="effect-grid">
            {BUBBLE_EFFECTS.map((b) => (
              <button
                key={b.id}
                className={`effect-chip ${bubbleFx === b.id ? 'on' : ''}`}
                onClick={() => setBubbleFx(bubbleFx === b.id ? 'none' : b.id)}
              >
                {b.label}
              </button>
            ))}
          </div>
          <h4 style={{ marginTop: 12 }}>Screen Effects</h4>
          <div className="effect-grid">
            {SCREEN_EFFECTS.map((s) => (
              <button
                key={s.id}
                className={`effect-chip ${screenFx === s.id ? 'on' : ''}`}
                onClick={() => setScreenFx(screenFx === s.id ? 'none' : s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
            <button
              className="btn"
              style={{ flex: 1 }}
              onClick={() => {
                setBubbleFx('none');
                setScreenFx('none');
              }}
            >
              Clear
            </button>
            <button className="btn primary" style={{ flex: 1 }} onClick={closePop}>
              Done
            </button>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 8, lineHeight: 1.4 }}>
            Tip: effects play when the message is sent — and Invisible Ink stays hidden until clicked.
          </div>
        </Floating>
      )}

      <div className="send-hint">{canSend ? 'Return to send · ⇧Return for a new line' : `To: ${chatTitle(chat)}`}</div>

      {dragging && (
        <div className="drop-veil" aria-hidden="true">
          <div className="drop-card">
            <IconPhotos size={22} />
            <div className="drop-title">Drop to attach</div>
            <div className="drop-sub">
              Any file, up to {MAX_FILES} at a time · {humanSize(MAX_BYTES)} each
            </div>
          </div>
        </div>
      )}

      {camera && <CameraSheet onCapture={onCapture} onClose={() => setCamera(false)} />}

      {zoom && (
        <Lightbox items={[{ src: zoom, caption: 'Not sent yet' }]} startSrc={zoom} onClose={() => setZoom(null)} />
      )}
    </div>
  );
}
