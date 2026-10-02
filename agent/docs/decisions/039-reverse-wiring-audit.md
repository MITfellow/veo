# 039 — The wiring audit runs in both directions, and an exemption must be argued for

## The ambiguity

§36 says the layers depend inward only and §34 says a milestone is done
when its tests are green. Neither says anything about whether anybody can
*reach* what was built. M9 added a wiring test that checks the client's
calls against the server's route table — but only in one direction: it
catches a route the client calls and the server does not serve.

That direction catches a rename. It cannot catch the failure that had
actually happened twelve times: the server grows a capability, the
capability is correct, unit-tested, integration-tested, constructed by
the composition root — and no client ever asks for it.

## The decision

The audit runs both ways. `test/integration/wiring.test.ts` now also
asserts that **every route the agent serves is called by the Veo
client**, with an `UNSURFACED` allowlist in which each entry carries a
written reason. The allowlist is itself checked: a name in it that the
server no longer serves fails the test, so it cannot rot into a list
nobody reads.

Four routes are exempted today, with these reasons on the record:

- `GET /health` — called by the dev proxy and the e2e harness. A health
  probe a user has to read is a health probe that already failed.
- `GET /sessions` — Veo owns conversation identity. The agent's session
  is an implementation detail reached through `chat.agentSessionId`; a
  second list would be a competing source of truth about what
  conversations exist.
- `PUT /constitution` — replaces the whole document in one write, which
  defeats the article-level amendment history the constitution panel
  exists to show. The UI amends; it does not overwrite.
- `GET /runs/:id/stream` — not a `call()`. `follow()` opens it with a raw
  fetch because it is an SSE body, not JSON.

## What it found immediately

Twelve routes with no client method: the whole of `/vault/*` (seven),
`/events`, `/jobs/dead-letter`, `/jobs/:id/replay`, `/import`, and the
JSON form of `/runs/:id/trace`. Plus `/memory/identity-card`, which the
first run of the finished test caught after the first eleven had been
wired — exactly the kind of thing that is invisible to every other test.

The vault one had a user-visible consequence that had been mistaken for a
configuration quirk: there was no way to store a model API key except an
environment variable, which is why every install anyone actually ran sat
at **L2** and answered from the offline fallback.

## Why an allowlist rather than a coverage number

A percentage would let the number drift down one route at a time, with
nobody ever making a decision. A named exemption with a reason next to it
forces the question "why can nobody reach this?" to be answered in
writing, once, by the person adding it.

## Cost

The test reads both files as text and matches route patterns with
regexes, which is crude and has already needed two fixes for template
literals the capture could not see (`/memory${…}` with a nested
template). A regex that silently matches nothing would make the test pass
by vacuum, so both directions assert a floor on how many routes they
found — `> 40` served, `> 15` called — and the test fails if the parse
rots.
