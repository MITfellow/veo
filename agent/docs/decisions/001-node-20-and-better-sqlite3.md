# 001 — Node 20 and better-sqlite3, not Node 22 and node:sqlite

**Status:** accepted · **Date:** 2026-10-02

## Context

The specification says Node 22+. The machine this is being built on runs Node
20.20.2. The only M0-relevant thing Node 22 adds is the built-in `node:sqlite`.

## Decision

Target Node >= 20.11 and use `better-sqlite3`.

## Why

- `node:sqlite` is marked experimental and its API is still moving. A runtime
  meant to last ten years should not have its storage layer pinned to a
  stability-1 API.
- It does not ship FTS5. Lexical recall is half of hybrid memory search (§22.4),
  so losing it would mean shipping an embeddings-only recall path — exactly the
  thing §22 warns against.
- `better-sqlite3` is synchronous, which the event log needs: the append, the
  hash and the projections must commit in one transaction, and an async driver
  makes that an interleaving problem at every call site.

## Cost

A native module, so `npm install` compiles or downloads a prebuilt binary, and
a Docker image needs build tools. Accepted: it is a single well-maintained
dependency doing something we cannot do ourselves.

## If the spec is right and I am wrong

Nothing above the `Storage` port knows which engine is underneath. Moving to
`node:sqlite` on Node 22 is one adapter file plus a `Dialect`, and the FTS5
question would need answering separately.
