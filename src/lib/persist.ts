import type { Store } from '../types';
import { buildSeedStore } from '../data/seed';
import { dropLegacyDb, idbDelete, idbGet, idbGetLegacy, idbPut, idbSupported } from './db';
import { inlineBlobs, restoreBlobs } from './blobs';

export const STORAGE_KEY = 'veo.app.state';
/** Keys this app wrote under its previous names, newest first. */
const LEGACY_STORAGE_KEYS = ['messages.app.state', 'imessage-clone-v2'];
export const SCHEMA_VERSION = 3;
/** key inside the IndexedDB object store */
export const STATE_KEY = 'state';

interface Envelope {
  version: number;
  savedAt: number;
  state: Store;
}

export type SaveResult = { ok: true } | { ok: false; reason: 'quota' | 'unavailable' };

/** `savedAt` of the last envelope this tab wrote, for clobber detection. */
let lastWriteAt = 0;
export const lastWrittenStamp = () => lastWriteAt;

/**
 * True when storage carries a write this tab didn't make — another tab, or a
 * test fixture, got there after us. Callers use it to avoid stamping a stale
 * snapshot over somebody else's newer one.
 */
export function storageChangedElsewhere(): boolean {
  if (idbSupported()) return false;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return lastWriteAt !== 0;
    const at = JSON.parse(raw)?.savedAt;
    return typeof at === 'number' && at !== lastWriteAt;
  } catch {
    return false;
  }
}

function isQuotaError(e: unknown) {
  return (
    e instanceof DOMException &&
    (e.name === 'QuotaExceededError' ||
      e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      e.code === 22 ||
      e.code === 1014)
  );
}

/** Older payloads are upgraded instead of thrown away. */
function migrate(raw: any): Store | null {
  if (!raw) return null;

  // v1/v2 persisted the bare store under a different key shape
  const state: Store = raw.state ?? raw;
  if (!state || !Array.isArray(state.chats) || !state.contacts) return null;
  if (typeof raw.savedAt === 'number') lastWriteAt = raw.savedAt;

  const seed = buildSeedStore();
  const merged: Store = {
    ...seed,
    ...state,
    settings: { ...seed.settings, ...(state.settings ?? {}) },
    me: { ...seed.me, ...(state.me ?? {}) },
  };

  merged.chats = merged.chats.map((c) => ({
    ...c,
    typing: false, // never restore a stuck indicator
    typingBy: undefined,
    draft: c.draft ?? '',
    unread: Math.max(0, c.unread | 0),
  }));

  merged.messages = (merged.messages ?? []).map((m) => ({
    ...m,
    attachments: m.attachments ?? [],
    reactions: m.reactions ?? [],
    bubbleEffect: m.bubbleEffect ?? 'none',
    screenEffect: m.screenEffect ?? 'none',
    // anything still mid-flight when the tab died is resolved
    status: m.status === 'sending' ? 'sent' : m.status,
  }));

  return merged;
}

/** Read and validate whatever is in localStorage, with its stamp. */
function readLocal(): { state: Store; savedAt: number } | null {
  try {
    let raw = localStorage.getItem(STORAGE_KEY);
    for (const key of LEGACY_STORAGE_KEYS) raw = raw ?? localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const state = migrate(parsed);
    if (!state) return null;
    return { state, savedAt: typeof parsed?.savedAt === 'number' ? parsed.savedAt : 0 };
  } catch {
    return null;
  }
}

/**
 * Load the store.
 *
 * IndexedDB is the home of record, but localStorage is still read because
 * (a) accounts created before the move live there and must be migrated, and
 * (b) it is the fallback when IndexedDB is unavailable. Whichever copy carries
 * the newer `savedAt` wins, so a tab that wrote to localStorage while this one
 * was closed is not silently discarded.
 */
export async function loadState(): Promise<Store> {
  const local = readLocal();
  let idb: Envelope | undefined;
  try {
    idb = await idbGet<Envelope>(STATE_KEY);
  } catch {
    idb = undefined;
  }

  // the app used to be called Messages, and its database with it; an account
  // created back then is carried over rather than orphaned
  let migratedLegacy = false;
  if (!idb?.state) {
    const legacy = await idbGetLegacy<Envelope>(STATE_KEY);
    if (legacy?.state) {
      idb = legacy;
      migratedLegacy = true;
    }
  }

  const idbState = idb?.state ? migrate(idb) : null;
  const idbAt = typeof idb?.savedAt === 'number' ? idb.savedAt : -1;
  const localAt = local?.savedAt ?? -1;

  if (idbState && idbAt >= localAt) {
    lastWriteAt = idbAt;
    if (migratedLegacy) {
      // write it under the new name first, then let the old database go
      void saveState(idbState)
        .then(() => dropLegacyDb())
        .catch(() => {});
    }
    return idbState;
  }

  if (local) {
    lastWriteAt = local.savedAt;
    // carry the older account over so the next write lands in IndexedDB
    void saveState(local.state).catch(() => {});
    return local.state;
  }

  return idbState ?? buildSeedStore();
}

/** Synchronous best-effort read, for code that cannot await (error paths). */
export function loadStateSync(): Store {
  return readLocal()?.state ?? buildSeedStore();
}

/** Strips the heaviest payloads (pasted image data URIs) oldest-first. */
function shrink(state: Store): Store {
  let budget = 12;
  const messages = state.messages.map((m) => {
    if (budget <= 0 || !m.attachments.length) return m;
    const attachments = m.attachments.map((a) => {
      if (a.kind === 'image' && a.src?.startsWith('data:') && budget > 0) {
        budget--;
        return { ...a, src: undefined, name: 'Photo (freed to save space)' };
      }
      return a;
    });
    return { ...m, attachments };
  });
  return { ...state, messages };
}

/**
 * Persist the store. IndexedDB takes a structured clone — no JSON pass, no
 * 5MB ceiling, no deleting the user's photos to make room. localStorage is
 * only used when IndexedDB is unavailable, and keeps the old quota-shrink
 * behaviour because there it really can run out of space.
 */
/**
 * Writes are serialised. Two saves in flight at once can otherwise complete out
 * of order and leave the older snapshot on disk — the migration write kicked
 * off by `loadState` used to land on top of messages sent moments later. A
 * save that is already superseded by a newer one is dropped rather than
 * written, which also coalesces bursts.
 */
let writeSeq = 0;
let writeChain: Promise<unknown> = Promise.resolve();

export function saveState(state: Store): Promise<SaveResult> {
  const seq = ++writeSeq;
  const run = writeChain.then(() =>
    seq === writeSeq ? writeNow(state) : ({ ok: true } as SaveResult),
  );
  // the chain must never reject, or every later save would be skipped
  writeChain = run.catch(() => undefined);
  return run;
}

async function writeNow(state: Store): Promise<SaveResult> {
  const savedAt = Date.now();
  const envelope: Envelope = { version: SCHEMA_VERSION, savedAt, state };

  if (idbSupported()) {
    try {
      await idbPut(STATE_KEY, envelope);
      lastWriteAt = savedAt;
      // the legacy copy would otherwise shadow IndexedDB on the next load
      try {
        localStorage.removeItem(STORAGE_KEY);
        for (const key of LEGACY_STORAGE_KEYS) localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
      return { ok: true };
    } catch {
      /* fall through to localStorage */
    }
  }

  return saveToLocal(state, savedAt);
}

/**
 * `JSON.stringify` turns a Blob into `{}` without complaining, so a file would
 * come back from the localStorage fallback as a name with nothing behind it.
 * The bytes stay in IndexedDB; here the attachment is marked unavailable so
 * the UI can say so instead of offering a download that produces nothing.
 */
function withoutBlobs(state: Store): Store {
  if (!state.messages.some((m) => m.attachments.some((a) => a.blob))) return state;
  return {
    ...state,
    messages: state.messages.map((m) =>
      m.attachments.some((a) => a.blob)
        ? {
            ...m,
            attachments: m.attachments.map((a) =>
              a.blob ? { ...a, blob: undefined, unavailable: true } : a,
            ),
          }
        : m,
    ),
  };
}

/** The pre-IndexedDB path, still used as a fallback and by the sync flush. */
export interface SaveToLocalOptions {
  /**
   * May this write throw away photos to fit?
   *
   * Only when localStorage is the **only** store there is. As the
   * page-hide escape hatch it must be false, and that is not a tuning
   * choice — it is the difference between a fallback and data loss.
   * `shrink()` strips attachment `src`, and the envelope it writes
   * carries a *newer* `savedAt` than the intact copy in IndexedDB, so
   * the next `loadState` prefers the shrunken one and the photos are
   * gone for good. A fallback that outranks the primary is not a
   * fallback.
   *
   * Found when a boot-time contact rename dirtied the state of an
   * eight-megabyte account: nothing about the rename was wrong, it was
   * just the first thing that ever made the flush fire with something
   * that large in memory. Any send would have done it eventually.
   */
  shrinkOnQuota?: boolean;
}

export function saveToLocal(
  original: Store,
  savedAt = Date.now(),
  options: SaveToLocalOptions = {},
): SaveResult {
  const { shrinkOnQuota = true } = options;
  const state = withoutBlobs(original);
  const write = (s: Store) => {
    const envelope: Envelope = { version: SCHEMA_VERSION, savedAt, state: s };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
    lastWriteAt = savedAt;
  };
  try {
    write(state);
    return { ok: true };
  } catch (e) {
    if (isQuotaError(e)) {
      // Write nothing at all rather than a worse copy that wins on date.
      if (!shrinkOnQuota) return { ok: false, reason: 'quota' };
      try {
        write(shrink(state));
        return { ok: false, reason: 'quota' };
      } catch {
        return { ok: false, reason: 'quota' };
      }
    }
    return { ok: false, reason: 'unavailable' };
  }
}

export async function clearState() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem('imessage-clone-v2');
    localStorage.removeItem('imessage-clone-v1');
  } catch {
    /* ignore */
  }
  try {
    await idbDelete(STATE_KEY);
  } catch {
    /* ignore */
  }
  lastWriteAt = 0;
}

export async function exportState(state: Store) {
  // a backup has to carry the actual files, and JSON cannot hold a Blob
  const portable = await inlineBlobs(state);
  const blob = new Blob([JSON.stringify({ version: SCHEMA_VERSION, state: portable }, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `messages-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function importState(file: File): Promise<Store> {
  const text = await file.text();
  const parsed = JSON.parse(text);
  const migrated = migrate(parsed);
  if (!migrated) throw new Error('That file is not a Messages backup.');
  // data URLs in the backup become real bytes again
  return restoreBlobs(migrated);
}
