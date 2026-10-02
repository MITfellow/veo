import { useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/context';
import StoragePanel from './StoragePanel';
import MemoryPanel from './MemoryPanel';
import ConstitutionPanel from './ConstitutionPanel';
import SchedulePanel from './SchedulePanel';
import ProofPanel from './ProofPanel';
import { Avatar } from './Avatar';
import { MemojiPicker } from './MemojiPicker';
import { Memoji } from './Memoji';
import { useMemojiSpec } from '../lib/useMemoji';
import { isAddressable, makeContact } from '../lib/contacts';
import { IconCheck, IconPlus, IconSearch } from './Icons';

/* Injected at build time (see vite.config.ts). The guard keeps the component
   renderable under any runner that does not define them. */
const VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
const BUILD_DATE = typeof __BUILD_DATE__ === 'string' ? __BUILD_DATE__ : 'locally';

export function NewMessageModal({ onClose }: { onClose: () => void }) {
  const { state, startChatWith, dispatch } = useStore();
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string[]>([]);

  const list = useMemo(() => {
    const all = Object.values(state.contacts);
    const needle = q.trim().toLowerCase();
    return all
      .filter((c) => !needle || c.name.toLowerCase().includes(needle) || c.handle.toLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [state.contacts, q]);

  const typed = q.trim();
  // a number or an email that matches nobody is still a valid destination
  const adHoc =
    isAddressable(typed) &&
    !Object.values(state.contacts).some((c) => c.handle.replace(/\s/g, '') === typed.replace(/\s/g, ''));

  const open = (ids: string[]) => {
    const id = startChatWith(ids);
    dispatch({ type: 'select', chatId: id });
    onClose();
  };

  const messageTyped = () => {
    const contact = makeContact({ handle: typed });
    dispatch({ type: 'add-contact', contact });
    open([...picked, contact.id]);
  };

  const go = () => {
    if (adHoc) return messageTyped();
    if (!picked.length) return;
    open(picked);
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <header>New Message</header>
        <div className="body">
          <div className="search">
            <IconSearch />
            <input autoFocus value={q} placeholder="To: name or number" onChange={(e) => setQ(e.target.value)} />
          </div>
          {picked.length > 1 && (
            <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
              Group message with {picked.length} people
            </div>
          )}
          {adHoc && (
            <button className="contact-pick adhoc" onClick={messageTyped}>
              <span className="adhoc-glyph" aria-hidden="true">
                <IconPlus size={16} />
              </span>
              <div style={{ flex: 1 }}>
                <div className="nm">Message “{typed}”</div>
                <div className="hd">Add as a new contact</div>
              </div>
            </button>
          )}
          {list.map((c) => {
            const on = picked.includes(c.id);
            return (
              <button
                key={c.id}
                className="contact-pick"
                onClick={() => setPicked((p) => (on ? p.filter((x) => x !== c.id) : [...p, c.id]))}
                onDoubleClick={() => {
                  const id = startChatWith([c.id]);
                  dispatch({ type: 'select', chatId: id });
                  onClose();
                }}
              >
                <Avatar contact={c} size={34} />
                <div style={{ flex: 1 }}>
                  <div className="nm">{c.name}</div>
                  <div className="hd">{c.handle}</div>
                </div>
                <span className={`check ${on ? 'on' : ''}`}>{on && <IconCheck size={12} />}</span>
              </button>
            );
          })}
          {list.length === 0 && !adHoc && (
            <div style={{ fontSize: 12.5, color: 'var(--text-2)', padding: '8px 4px' }}>
              {q.trim()
                ? 'No contact matches — type a full phone number or email to message someone new.'
                : 'No contacts yet. Type a phone number or email to start.'}
            </div>
          )}
        </div>
        <footer>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={go} disabled={!picked.length && !adHoc}>
            Start {picked.length > 1 ? 'Group' : 'Chat'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Seg({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { id: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        background: 'var(--search-bg)',
        borderRadius: 9,
        padding: 2,
        gap: 2,
      }}
    >
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          style={{
            flex: 1,
            padding: '5px 8px',
            borderRadius: 7,
            fontSize: 12.5,
            background: value === o.id ? 'var(--bg-elevated)' : 'transparent',
            boxShadow: value === o.id ? '0 1px 3px rgba(0,0,0,.14)' : 'none',
            fontWeight: value === o.id ? 600 : 400,
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="gc-row" style={{ borderBottom: 'none', padding: '8px 2px' }}>
      <span style={{ fontSize: 13.5 }}>{label}</span>
      <span className="spacer" />
      {children}
    </div>
  );
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      className={`switch ${on ? 'on' : ''}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
    >
      <i />
    </button>
  );
}

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const { state, dispatch, reset, exportData, importData, enableNotifications } = useStore();
  const s = state.settings;
  const fileRef = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const myMemoji = useMemojiSpec(state.me.avatar);
  const [editingMemoji, setEditingMemoji] = useState(false);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <header>Settings</header>
        <div className="body">
          <div className="panel-label">Your Memoji</div>
          <button
            className="me-card"
            onClick={() => setEditingMemoji((v) => !v)}
            aria-expanded={editingMemoji}
          >
            <div className="me-avatar">
              {myMemoji ? (
                <Memoji spec={myMemoji} size={52} />
              ) : (
                <div className="avatar" style={{ width: 52, height: 52, fontSize: 19, background: 'linear-gradient(160deg,#9ea3ab,#73787f)' }}>
                  ME
                </div>
              )}
            </div>
            <div className="me-meta">
              <div className="nm">{state.me.name}</div>
              <div className="hd">{state.me.handle}</div>
            </div>
            <span className="me-edit">{editingMemoji ? 'Done' : 'Edit'}</span>
          </button>
          {editingMemoji && (
            <MemojiPicker
              label=""
              value={state.me.avatar}
              onPick={(avatar) => dispatch({ type: 'me', patch: { avatar } })}
              onClear={() => dispatch({ type: 'me', patch: { avatar: undefined } })}
            />
          )}

          <div className="panel-label" style={{ marginTop: 6 }}>
            Appearance
          </div>
          <Seg
            value={s.theme}
            options={[
              { id: 'light', label: 'Light' },
              { id: 'dark', label: 'Dark' },
              { id: 'system', label: 'System' },
            ]}
            onChange={(v) => dispatch({ type: 'settings', patch: { theme: v as typeof s.theme } })}
          />
          <Seg
            value={s.density}
            options={[
              { id: 'comfortable', label: 'Comfortable' },
              { id: 'compact', label: 'Compact' },
            ]}
            onChange={(v) => dispatch({ type: 'settings', patch: { density: v as typeof s.density } })}
          />

          <div className="panel-label" style={{ marginTop: 6 }}>
            Behaviour
          </div>
          <Row label="Message sounds">
            <Switch on={s.sounds} onChange={(v) => dispatch({ type: 'settings', patch: { sounds: v } })} />
          </Row>
          <Row label="Play sound when sending">
            <Switch
              on={s.sendWithSound}
              onChange={(v) => dispatch({ type: 'settings', patch: { sendWithSound: v } })}
            />
          </Row>
          <Row label="Send read receipts">
            <Switch
              on={s.readReceipts}
              onChange={(v) => dispatch({ type: 'settings', patch: { readReceipts: v } })}
            />
          </Row>
          <Row label="Contacts reply automatically">
            <Switch on={s.autoReply} onChange={(v) => dispatch({ type: 'settings', patch: { autoReply: v } })} />
          </Row>

          <Row label="Desktop notifications">
            <Switch
              on={s.notifications}
              label="Desktop notifications"
              onChange={async (v) => {
                if (!v) return dispatch({ type: 'settings', patch: { notifications: false } });
                const granted = await enableNotifications();
                if (!granted) setNotice('Your browser blocked notifications for this site.');
              }}
            />
          </Row>

          <ConstitutionPanel onNotice={setNotice} />

          <SchedulePanel onNotice={setNotice} />

          <MemoryPanel onNotice={setNotice} />

          <ProofPanel onNotice={setNotice} />

          <StoragePanel onNotice={setNotice} />

          <div className="panel-label" style={{ marginTop: 6 }}>
            Data
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" style={{ flex: 1 }} onClick={() => void exportData()}>
              Export backup
            </button>
            <button className="btn" style={{ flex: 1 }} onClick={() => fileRef.current?.click()}>
              Import backup
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                try {
                  await importData(file);
                  setNotice('Backup restored.');
                } catch (err) {
                  setNotice(err instanceof Error ? err.message : 'That backup could not be read.');
                }
              }}
            />
          </div>
          {notice && (
            <div style={{ fontSize: 12.5, color: 'var(--text-2)', paddingTop: 2 }} role="status">
              {notice}
            </div>
          )}

          <div className="panel-label" style={{ marginTop: 6 }}>
            Keyboard
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.7 }}>
            <div>⌘K — search · ⌘N — new message</div>
            <div>↩ send · ⇧↩ new line · ⌥↑ / ⌥↓ switch conversation</div>
            <div>Right-click a bubble for tapbacks, reply, forward, edit & unsend</div>
          </div>

          <div className="panel-label" style={{ marginTop: 6 }}>
            About
          </div>
          <div className="about-row">
            <div>
              <div className="about-name">Veo</div>
              <div className="about-meta">
                Version {VERSION} · built {BUILD_DATE}
              </div>
              <div className="about-meta">
                Every message, photo and file stays on this device.
              </div>
            </div>
          </div>
        </div>
        <footer>
          <button
            className="btn danger"
            onClick={() => {
              if (confirm('Delete every conversation and start over? This cannot be undone.')) {
                reset();
                onClose();
              }
            }}
          >
            Reset Data
          </button>
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}

const SHORTCUTS: { keys: string; label: string }[] = [
  { keys: '⌘K', label: 'Search conversations and messages' },
  { keys: '⌘N', label: 'New message' },
  { keys: '⌘I', label: 'Show or hide conversation details' },
  { keys: '⌘/', label: 'This shortcut list' },
  { keys: '↩', label: 'Send' },
  { keys: '⇧↩', label: 'New line' },
  { keys: '⌥↑ / ⌥↓', label: 'Previous / next conversation' },
  { keys: '↑', label: 'Edit your last message' },
  { keys: 'Esc', label: 'Close a sheet, cancel a reply or clear search' },
  { keys: 'Right-click', label: 'Tapbacks, reply, edit, undo send, delete' },
  { keys: 'Drag & drop', label: 'Drop files on a thread to send them' },
];

export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Keyboard shortcuts">
        <header>Keyboard Shortcuts</header>
        <div className="body">
          <div className="shortcut-grid">
            {SHORTCUTS.map((s) => (
              <div className="shortcut-row" key={s.keys}>
                <kbd>{s.keys}</kbd>
                <span>{s.label}</span>
              </div>
            ))}
          </div>
        </div>
        <footer>
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
