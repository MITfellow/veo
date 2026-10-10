/**
 * The help text, kept out of `cli.ts`.
 *
 * It lives here because it is the one part of the CLI that grows with
 * every milestone and the one part that contains no logic. Keeping it in
 * the router pushed that file against its 400-line ceiling for no reason
 * other than prose.
 */

export const HELP = `arish — the personal agent platform

Usage: arish <command> [options]

Commands (M0):
  doctor         environment, config, disk and clock sanity
  status         event count, chain head, schema version, degradation rung
  verify-chain   hash-chain integrity over the whole log
  rebuild        drop every projection and replay the log

Commands (M1):
  vault <cmd>    init, status, set, get, list, forget, panic
                 run 'arish vault help' for detail

Commands (M2):
  memory <cmd>   add, list, recall, history, forget, entities,
                 conflicts, consolidate
                 run 'arish memory help' for detail

Commands (M3):
  tools          every tool, with the rung and capabilities it needs
  run <plan>     execute a sealed plan through the gate chain
                 --dry-run, --autonomy N, --trust T
  approvals      what the agent is waiting to be told
                 approvals grant|deny <id>

Commands (§13):
  effects        external effects: what we intended, what we can prove
                 effects list|pending|attention|reconcile

Commands (onboarding, decision 008):
  serve          the Get Started UI and local JSON API
                 --host, --port (defaults 127.0.0.1:8787)

Options:
  --json         machine-readable output on stdout
  --data-dir     override the data directory

Later milestones add: init, start, replay, backup, restore,
export, import. They are absent rather than stubbed (§61).
`;
