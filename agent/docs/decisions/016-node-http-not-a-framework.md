# 016 — The HTTP layer is `node:http`, not a framework

**Status:** accepted · **Milestone:** M2

## Context

§29 defines about twenty routes. The obvious move is express or fastify.

## Options

1. **express** — ubiquitous, but a large transitive dependency tree, a
   CVE cadence, and a middleware ecosystem this project does not use.
2. **fastify** — faster and better typed; still a framework with plugins,
   lifecycle hooks and a major-version migration every couple of years.
3. **`node:http` with a small route table.**

## Decision

Option 3. Routing is a method + pattern table and a loop (~40 lines). SSE is
written directly against `ServerResponse`, which is what a framework would
make harder, not easier — streaming is where framework abstractions leak
most (buffering middleware, response wrappers, compression that defeats
`text/event-stream`).

## Consequences

- Zero HTTP dependencies for a ten-year runtime. The Node HTTP API is one of
  the most stable interfaces in the ecosystem.
- Things written by hand that a framework would provide: body size limits,
  bearer parsing with a constant-time compare, 404/401/500 shapes. All are
  small, all are tested, and all are now explicit rather than configured.
- If the API grows past roughly fifty routes this should be revisited.
