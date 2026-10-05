# Browser use — what was built

Out of band, like the onboarding work before it, and for the same reason:
the user asked for it directly. Decision 009 holds the argument; this note
holds the inventory, the gaps, and the things I am not sure about.

**Verified by running:** `npm run check` → **362 tests, 28 files, 11.9 s**
(60 s budget), `tsc --noEmit` clean, `eslint . --max-warnings 0` clean,
every function within the complexity-10 limit. Then driven in headless
Chromium through eleven screenshots with **zero console errors**.

---

## Built

### An HTML stack, because there isn't one in two dependencies

`src/capability/browser/html/` — about 450 lines, no new dependencies.

- `entities.ts` — named and numeric references, with the CP1252 remap real
  pages need. Obfuscating an instruction as `&#73;&#103;...` is in the
  attack corpus, and decoding it is the only way the hidden-text signal
  counts it.
- `tokenize.ts` — lenient by design. Raw-text elements (`script`, `style`,
  `textarea`, `title`) are not parsed as markup; `>` inside a quoted
  attribute does not end a tag; comments are **retained and marked**,
  because a comment is invisible to a human and perfectly visible to a
  naive agent.
- `parse.ts` — tree builder with void elements, implied ends and scope
  boundaries, so one unclosed `<div>` does not swallow the document.
  `textOf` excludes comments and non-rendered elements. `isHidden` is a
  table of the crude tricks — `display:none`, a 0px font, an off-screen
  absolute position, `clip-path:inset(100%)`.

### The agent view — `view.ts`

`buildAgentView(html, url)` returns affordances (`e1`, `e2`, …), forms,
headings, **counts** of body text, and `PageSignals`. It does not return
prose. The planner is given an enumerable set of things it can do and some
statistics about what it cannot see; the prose goes down the other path.

`buildObservation` additionally returns a **private side table** mapping
each ref to its real href and field name. The planner names a ref; the
session dereferences it. A label can therefore never carry a destination.

### Plan and gate — `plan.ts`

Eight action kinds across three tiers (`observe` / `interact` / `effect`),
sealed with an injected digest, and a gate ordered so the most fundamental
refusal is the one you see. `RefusalCode` is a closed union. A ref that is
not in the **current** observation is refused — stale and invented are the
same failure.

### Driver port — `driver.ts`

```ts
type BrowserDriver = (request: FetchRequest) => Promise<FetchResponse>;
```

`StaticDriver` ships and works. `unattachedDriver` turns the absence of a
network into a clear refusal at the point of use. **No network driver is
compiled in** (§2).

### Session — `session.ts`

Commit, navigate, observe, act. Approval arrives as a **separate argument**,
never as a field on the action, so it cannot be smuggled inside a payload a
page influenced — and `.strict()` turns the attempt into a parse error.
`readForUser()` is named for its audience and nothing in the planning path
calls it.

### Surface — `interface/browser-api.ts` + `web/browser.{html,js,css}`

Seven endpoints and a three-column page: the plan on the left, the page in
the middle, the transcript on the right. The middle column has three tabs —
*Open a page*, *What the planner sees*, *What you see* — which is the whole
argument made visible. Five demo documents, **two of them hostile and
labelled as hostile**, because a shield you cannot watch working is a shield
you are trusting on faith.

---

## Tested

| File | Tests | What it is for |
| --- | --- | --- |
| `test/unit/browser-html.test.ts` | 25 | entities, tokenizer, parser, the view |
| `test/adversarial/browser.test.ts` | 74 | the hostile corpus and every gate |
| `test/integration/browser-api.test.ts` | 19 | the HTTP surface end to end |

`test/fixtures/hostile-pages.ts` holds **15 attack shapes** — direct
instruction, hidden text, comments, an instruction as a link label, an
off-site link, `javascript:` and `data:` hrefs, a forged approval, a
credential harvest, an invisible form, entity obfuscation, text split
across tags, a spoofed ref, a disabled trap, a step burner — each naming
the mechanism that is supposed to stop it.

It also holds **3 benign pages as the negative control**, including an
article *about* prompt injection that contains the phrase "ignore all
previous instructions" in its body. A defence that refuses that article is
not a defence, it is an outage. The suite asserts it reads cleanly.

---

## Deferred

- **Browser events are not appended to the event log yet.** The session
  emits a `SessionEvents` record per step and the API keeps a transcript,
  but nothing reaches `substrate/events`. Decision 009 claims a browsing
  session is replayable; today it is only *observable*. Wiring this needs
  event types in the closed registry, which is a migration.
- **No live driver, by §2.** Deliberate, and the demo corpus exists so the
  absence is the only thing you cannot see.
- **Interaction against a static document does not move the page.** `type`,
  `select` and `check` record field state locally; `click` on a link
  genuinely navigates; `submit` and `download` report that they were
  authorised and that there is no transport. Nothing is simulated — an
  agent that invents the page a click would have produced is worse than one
  that cannot click.
- **No auth on the HTTP surface.** Unchanged from the onboarding work and
  still wrong for anything but loopback.

## Unsure

- **`MAX_LABEL = 80` is a guess.** Long enough for real link text, short
  enough to bound the set. I have no evidence for 80 over 60 or 120.
- **`isHidden` is a heuristic and always will be.** It cannot see a
  stylesheet. A page can hide text in a way it does not catch; the
  `hiddenTextChars` signal is a floor, not a count.
- **The entry-navigation exception is the one place the origin rule bends.**
  I believe it is safe because the destination comes from the planner
  before any page is read. It is still an exception, and exceptions are
  where things go wrong.
- **Is a sealed plan actually usable by a model later?** The baseline
  planner works on affordances, which is why a deterministic planner is
  possible at all. Whether a model will tolerate being handed `e1…e9` and
  no prose, and still plan well, is untested and unknowable without one.
- **Five demo pages may be too few to be convincing and too many to
  maintain.** Unresolved.

## Run it

```bash
cd server
npm install && npm run build
npm start -- serve --data-dir /tmp/arish-browser
# then open http://127.0.0.1:8787/browser.html
bash docs/progress/BROWSER-demo.sh      # the same journey, from the shell
```
