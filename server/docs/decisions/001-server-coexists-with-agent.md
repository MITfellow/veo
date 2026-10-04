# 001 — `server/` coexists with the existing `agent/`; it does not evolve it

**Status:** accepted
**Date:** 2026-10-03

## Context

The specification is written for a greenfield repository. This repository is
not greenfield. It already contains a complete personal-agent platform at
`agent/` — nine milestones, 1035 passing unit tests, an HTTP interface, a
capability registry of 31 tools, and a live integration with the Veo client.

That prior platform violates several of this specification's absolutes:

* **It has a model.** `agent/src/providers/openai-compatible.ts` is a real
  provider that makes a real inference call when given an API key. §2 and §6
  of this specification forbid that outright.
* **Veo has been modified far beyond the eleven files of §49.** The client
  carries an agent chat panel, a notification bell, calendar, tasks, proof and
  memory panels, and changes to the store and its persistence layer.
* **The specification's own figures for Veo are out of date.** §49 describes
  Veo as having 131 unit tests and 50 e2e tests. It currently has 167 unit
  tests and 163 e2e tests.

So the instruction "build it in a new `server/` directory" cannot mean "port
`agent/` across". The two platforms disagree about the single most important
constraint in the document.

## Decision

`server/` is built from nothing, to this specification, as a second and
independent platform. It does not import from `agent/`, from `../src`, or
from anywhere else in the repository. `agent/` is left exactly as it is and
is not deleted, not modified, and not used as a reference implementation.

Where the specification and the existing `agent/` disagree, the specification
wins inside `server/` and is silent outside it.

## Consequences

* The repository holds two agent platforms at once. This is accepted
  deliberately rather than resolved by deletion, because deleting a working,
  tested, integrated subsystem is not a decision to take inside a scaffolding
  commit.
* **The §49 Veo integration is a genuine collision and is deferred to M7.**
  Three of the eleven files §49 says to *create* already exist and are wired
  to `agent/`: `src/components/MemoryPanel.tsx`, `src/lib/store.tsx` and
  `src/data/seed.ts` among them. `vite.config.ts` already proxies to
  `127.0.0.1:7777`, not `8787`. M7 therefore cannot be executed as literally
  written, and the conflict must be put to the user before M7 starts, not
  discovered during it. M0 through M6 touch zero files outside `server/`, so
  nothing is blocked today.
* No part of `agent/` counts toward any completion gate in `server/`. The
  `server/` suite is the only evidence for `server/`.
