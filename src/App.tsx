import { useCallback, useEffect, useMemo, useState } from 'react';
import { StoreProvider } from './lib/store';
import { useStore } from './lib/context';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { DetailsPanel } from './components/DetailsPanel';
import { Lightbox, type LightboxItem } from './components/Lightbox';
import { Effects } from './components/Effects';
import { NewMessageModal, SettingsModal, ShortcutsModal } from './components/Modals';
import { applyUpdate } from './lib/sw';

function Shell() {
  const { state, dispatch, activeChat, booted, effect, fireEffect, messagesFor, online, storageIssue, dismissStorageIssue } =
    useStore();
  // the PWA "New conversation" shortcut lands on /?compose=1
  const [modal, setModal] = useState<null | 'new' | 'settings' | 'shortcuts'>(() =>
    new URLSearchParams(window.location.search).get('compose') ? 'new' : null,
  );
  const [mobileList, setMobileList] = useState(() => window.innerWidth <= 720);
  const [zoom, setZoom] = useState<string | null>(null);
  const [updateReady, setUpdateReady] = useState(false);
  useEffect(() => {
    const fn = () => setUpdateReady(true);
    window.addEventListener('app-update-ready', fn);
    return () => window.removeEventListener('app-update-ready', fn);
  }, []);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('compose')) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  const showDetails = state.settings.showDetails && !!activeChat;

  // the details panel's photo grid pages through the same chat's photos
  const detailPhotos = useMemo<LightboxItem[]>(() => {
    if (!activeChat) return [];
    return messagesFor(activeChat.id).flatMap((m) =>
      (m.attachments ?? [])
        .filter((a) => a.kind === 'image' && a.src)
        .map((a) => ({
          src: a.src!,
          caption: m.authorId === 'me' ? 'You' : state.contacts[m.authorId]?.name,
        })),
    );
  }, [activeChat, messagesFor, state.contacts]);
  const unread = state.chats.reduce((n, c) => n + (c.muted ? 0 : c.unread), 0);

  // on phones, *opening* a conversation slides the list away (but not on first
  // paint); losing the active chat — reset, or deleting the last one — must
  // slide back to the list instead of stranding the user on an empty pane
  const [lastChatId, setLastChatId] = useState(state.activeChatId);
  const [slideReady, setSlideReady] = useState(booted);
  if (!slideReady && booted) {
    // the store arrives from the database after the first render, so the
    // conversation it restores must be adopted silently — otherwise booting
    // looks like a tap and the phone slides straight into the thread
    setSlideReady(true);
    setLastChatId(state.activeChatId);
  } else if (lastChatId !== state.activeChatId) {
    setLastChatId(state.activeChatId);
    if (window.innerWidth <= 720) setMobileList(!state.activeChatId);
  }

  // unread badge in the tab title, like the Dock badge
  useEffect(() => {
    document.title = unread > 0 ? `Veo (${unread})` : 'Veo';
  }, [unread]);

  const toggleDetails = useCallback(
    () => dispatch({ type: 'settings', patch: { showDetails: !state.settings.showDetails } }),
    [dispatch, state.settings.showDetails],
  );

  // global shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        (document.getElementById('sidebar-search') as HTMLInputElement | null)?.focus();
      }
      if (meta && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        setModal('new');
      }
      if (meta && e.key === '/') {
        e.preventDefault();
        setModal((m) => (m === 'shortcuts' ? null : 'shortcuts'));
      }
      if (meta && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        toggleDetails();
      }
      if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        const order = [...state.chats]
          .map((c) => {
            const m = messagesFor(c.id);
            return { id: c.id, at: m[m.length - 1]?.at ?? 0, pinned: c.pinned };
          })
          .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.at - a.at)
          .map((c) => c.id);
        const i = order.indexOf(state.activeChatId ?? '');
        const next = order[Math.min(order.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (next) dispatch({ type: 'select', chatId: next });
      }
      if (e.key === 'Escape') setModal(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch, state.chats, state.activeChatId, messagesFor, toggleDetails]);

  // reading the database takes a few milliseconds; showing the window in its
  // empty state first would flash "No Conversations" at someone who has
  // hundreds of them
  if (!booted) {
    return (
      <div className="desktop">
        <div className="boot" role="status" aria-live="polite">
          <span className="boot-spinner" aria-hidden="true" />
          <span className="boot-label">Loading your messages…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="desktop">
      <a className="skip-link" href="#main">Skip to conversation</a>
      <div className={`window ${showDetails ? 'with-details' : ''} ${mobileList ? 'show-list' : ''}`}>
      <Sidebar
        onCompose={() => setModal('new')}
        onSettings={() => setModal('settings')}
        onOpen={() => setMobileList(false)}
      />
      <ChatView onBack={() => setMobileList(true)} onToggleDetails={toggleDetails} />
      {showDetails && activeChat && <DetailsPanel chat={activeChat} onZoom={setZoom} />}

      <Effects effect={effect} onDone={() => fireEffect('none')} />

      <div className="banners" role="status" aria-live="polite">
        {!online && (
          <div className="banner offline">
            <span className="dot" aria-hidden="true" />
            You're offline — new messages will show as Not Delivered.
          </div>
        )}
        {storageIssue && (
          <div className="banner warn">
            {storageIssue}
            <button className="banner-action" onClick={dismissStorageIssue}>
              Dismiss
            </button>
          </div>
        )}
        {updateReady && (
          <div className="banner update">
            A new version of Veo is available.
            <button className="banner-action" onClick={applyUpdate}>
              Reload
            </button>
          </div>
        )}
      </div>

      {modal === 'new' && <NewMessageModal onClose={() => setModal(null)} />}
      {modal === 'settings' && <SettingsModal onClose={() => setModal(null)} />}
      {modal === 'shortcuts' && <ShortcutsModal onClose={() => setModal(null)} />}
      {zoom && (
        <Lightbox
          items={detailPhotos.length ? detailPhotos : [{ src: zoom }]}
          startSrc={zoom}
          onClose={() => setZoom(null)}
        />
      )}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
