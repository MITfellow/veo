import { useCallback, useEffect, useState } from 'react';
import {
  agent,
  AgentUnavailableError,
  PANIC_CONFIRMATION,
  VaultLockedError,
  type SecretView,
  type VaultView,
} from '../lib/agent';

/**
 * §13 — the vault, which until now the UI could not reach at all.
 *
 * The consequence of that gap was concrete: the only way to give the
 * agent a model API key was an environment variable, which is why every
 * install anyone actually ran sat at L2 ("no model") and answered from
 * the offline provider. A secrets store with no way to put a secret in
 * it is a secrets store in name only.
 *
 * Three rules this panel is built around.
 *
 * **A value goes up and never comes down.** The server has no route that
 * returns plaintext — deliberately, because a value reachable over HTTP
 * is a value outside the vault the moment someone adds a logger. So this
 * component has no state that could hold one after the submit, and the
 * `SecretView` type it renders has no `value` field to render.
 *
 * **Locked is a state, not an error.** Every read answers 423 while the
 * keyring is sealed. That is recoverable and the panel says how, instead
 * of showing a status code.
 *
 * **Destruction is typed, not clicked.** Panic destroys the keyring and
 * every secret in every backup that already exists. The server demands a
 * literal sentence; the panel demands the user type that same sentence,
 * so the client is not the place where irreversible became easy.
 */

const when = (at: number | null): string =>
  at === null ? 'never' : new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export default function VaultPanel({ onNotice }: { onNotice: (message: string) => void }) {
  const [vault, setVault] = useState<VaultView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  /**
   * Until the first answer comes back the panel knows nothing, and
   * saying "No vault yet" before asking is a small lie that becomes a
   * real one the moment someone acts on it.
   */
  const [loaded, setLoaded] = useState(false);

  const [passphrase, setPassphrase] = useState('');
  const [recovery, setRecovery] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [rotating, setRotating] = useState<string | null>(null);

  const [panicking, setPanicking] = useState(false);
  const [confirm, setConfirm] = useState('');

  /**
   * Fetching and applying stay apart, like every other panel here: the
   * effect subscribes to a promise instead of calling something that
   * sets state synchronously, which is both the honest description of
   * what happens and what keeps the React compiler able to optimise it.
   *
   * A locked vault is a resolved value rather than a rejection — it is a
   * state the user can fix, not a failure.
   */
  const load = useCallback(
    async (): Promise<VaultView | 'locked'> =>
      agent.vault().catch((cause: unknown) => {
        if (cause instanceof VaultLockedError) return 'locked' as const;
        throw cause;
      }),
    [],
  );

  const apply = useCallback((result: VaultView | 'locked') => {
    setLocked(result === 'locked');
    if (result !== 'locked') setVault(result);
    setError(null);
    setLoaded(true);
  }, []);

  const fail = useCallback((cause: unknown) => {
    setError(
      cause instanceof AgentUnavailableError
        ? 'The agent is not running, so there is no vault to open.'
        : (cause as Error).message,
    );
    setLoaded(true);
  }, []);

  const refresh = useCallback(async () => {
    try {
      apply(await load());
    } catch (cause) {
      fail(cause);
    }
  }, [load, apply, fail]);

  useEffect(() => {
    let live = true;
    load().then(
      (result) => {
        if (live) apply(result);
      },
      (cause: unknown) => {
        if (live) fail(cause);
      },
    );
    return () => {
      live = false;
    };
  }, [load, apply, fail]);

  const guard = async (work: () => Promise<void>) => {
    try {
      await work();
    } catch (cause) {
      if (cause instanceof VaultLockedError) setLocked(true);
      onNotice((cause as Error).message);
    }
  };

  const unlock = () =>
    guard(async () => {
      const result = await agent.unlockVault(passphrase);
      setPassphrase('');
      // Shown once, stored nowhere. If the user closes this without
      // writing it down it is gone, and saying so is the honest thing.
      if (result.recoveryCode !== undefined) setRecovery(result.recoveryCode);
      await refresh();
      onNotice(result.recoveryCode === undefined ? 'Unlocked.' : 'Vault created and unlocked.');
    });

  const save = () =>
    guard(async () => {
      if (name.trim() === '' || value === '') {
        onNotice('A secret needs a name and a value.');
        return;
      }
      if (rotating === null) await agent.putSecret(name.trim(), value);
      else await agent.rotateSecret(rotating, value);
      // Drop the plaintext from component state the instant it is sent.
      setValue('');
      setName('');
      setAdding(false);
      setRotating(null);
      await refresh();
      onNotice(rotating === null ? 'Stored.' : 'Rotated. The old version is unreadable.');
    });

  const panic = () =>
    guard(async () => {
      await agent.panicVault();
      setPanicking(false);
      setConfirm('');
      await refresh();
      onNotice('The keyring is destroyed. Every secret is permanently unreadable.');
    });

  if (error !== null) {
    return (
      <>
        <div className="panel-label" style={{ marginTop: 6 }}>
          Secrets
        </div>
        <div className="vlt-empty">{error}</div>
      </>
    );
  }

  const state = locked ? 'locked' : (vault?.state ?? 'uninitialized');
  const live: SecretView[] = (vault?.secrets ?? []).filter(
    (secret) => secret.destroyedAt === null,
  );

  return (
    <>
      <div className="panel-label" style={{ marginTop: 6 }}>
        Secrets
      </div>
      <div className="vlt-note">
        Keys and tokens the agent uses on your behalf. Values are encrypted with a key derived
        from your passphrase, are never sent back out, and never appear in the log, a trace or an
        export — only the reference <code>secret://name</code> does.
      </div>

      <div
        className={`vlt-state is-${loaded ? state : 'unknown'}`}
        data-testid="vault-state"
        data-loaded={loaded ? 'true' : 'false'}
      >
        <span className="vlt-dot" aria-hidden="true" />
        {!loaded
          ? 'Checking…'
          : state === 'unlocked'
            ? 'Unlocked — the agent can use these for as long as this session lasts.'
            : state === 'locked'
              ? 'Locked. Nothing can read a secret, including the agent.'
              : 'No vault yet. Pick a passphrase and one will be created.'}
      </div>

      {!loaded ? null : state === 'unlocked' ? (
        <button
          className="vlt-btn"
          onClick={() =>
            void guard(async () => {
              await agent.lockVault();
              await refresh();
              onNotice('Locked.');
            })
          }
        >
          Lock it
        </button>
      ) : (
        <div className="vlt-unlock">
          <input
            className="vlt-input"
            type="password"
            autoComplete="current-password"
            placeholder={state === 'locked' ? 'Passphrase' : 'Choose a passphrase'}
            aria-label="Vault passphrase"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void unlock();
            }}
          />
          <button className="vlt-btn is-primary" onClick={() => void unlock()}>
            {state === 'locked' ? 'Unlock' : 'Create the vault'}
          </button>
        </div>
      )}

      {recovery !== null ? (
        <div className="vlt-recovery">
          <div className="vlt-recovery-label">
            Write this down now. It is the only way back in if you forget the passphrase, and it
            will not be shown again.
          </div>
          <code className="vlt-code">{recovery}</code>
          <button className="vlt-btn" onClick={() => setRecovery(null)}>
            I have written it down
          </button>
        </div>
      ) : null}

      {loaded && state === 'unlocked' ? (
        <>
          <div className="vlt-list">
            {live.length === 0 ? (
              <div className="vlt-empty">
                Nothing stored. An <code>api_key</code> here is what moves the agent off its
                offline fallback and onto a real model.
              </div>
            ) : (
              live.map((secret) => (
                <div key={`${secret.name}#${secret.version}`} className="vlt-row">
                  <div className="vlt-main">
                    <div className="vlt-name">{secret.name}</div>
                    <div className="vlt-meta">
                      version {secret.version} · added {when(secret.createdAt)} · read{' '}
                      {secret.readCount} time{secret.readCount === 1 ? '' : 's'}, last{' '}
                      {when(secret.lastReadAt)}
                    </div>
                  </div>
                  <div className="vlt-row-actions">
                    <button
                      className="vlt-btn"
                      onClick={() => {
                        setRotating(secret.name);
                        setName(secret.name);
                        setValue('');
                        setAdding(true);
                      }}
                    >
                      Rotate
                    </button>
                    <button
                      className="vlt-btn is-danger"
                      onClick={() =>
                        void guard(async () => {
                          await agent.deleteSecret(secret.name);
                          await refresh();
                          onNotice(`${secret.name} destroyed.`);
                        })
                      }
                    >
                      Destroy
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {adding ? (
            <div className="vlt-add">
              <input
                className="vlt-input"
                placeholder="Name it — api_key"
                aria-label="Secret name"
                value={name}
                disabled={rotating !== null}
                onChange={(event) => setName(event.target.value)}
              />
              <input
                className="vlt-input"
                type="password"
                autoComplete="off"
                placeholder={rotating === null ? 'The value' : 'The new value'}
                aria-label="Secret value"
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
              <div className="vlt-actions">
                <button className="vlt-btn is-primary" onClick={() => void save()}>
                  {rotating === null ? 'Store it' : 'Rotate it'}
                </button>
                <button
                  className="vlt-btn"
                  onClick={() => {
                    setAdding(false);
                    setRotating(null);
                    setValue('');
                    setName('');
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button className="vlt-btn" onClick={() => setAdding(true)}>
              Add a secret
            </button>
          )}
        </>
      ) : null}

      {loaded && state !== 'uninitialized' ? (
        <>
          <div className="vlt-section">If something has gone badly wrong</div>
          {panicking ? (
            <div className="vlt-panic">
              <div className="vlt-note">
                This destroys the keyring. Every secret becomes permanently unreadable — not just
                here, but in every backup and export that already exists. There is no undo and no
                recovery code for it. Type <code>{PANIC_CONFIRMATION}</code> to go ahead.
              </div>
              <input
                className="vlt-input"
                placeholder={PANIC_CONFIRMATION}
                aria-label="Type the confirmation"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
              />
              <div className="vlt-actions">
                <button
                  className="vlt-btn is-danger"
                  disabled={confirm !== PANIC_CONFIRMATION}
                  onClick={() => void panic()}
                >
                  Destroy everything
                </button>
                <button
                  className="vlt-btn"
                  onClick={() => {
                    setPanicking(false);
                    setConfirm('');
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button className="vlt-btn is-danger" onClick={() => setPanicking(true)}>
              Destroy the keyring
            </button>
          )}
        </>
      ) : null}
    </>
  );
}
