# 004 — The hash chain uses node:crypto, not webcrypto

**Status:** accepted · **Date:** 2026-10-02

## Context

§6 says "Node webcrypto only" for cryptography. But `crypto.subtle.digest` is
async, and the chain hash must be computed inside the synchronous transaction
that assigns `seq` and inserts the row.

## Decision

Split the concern into two ports. `Hashing.sha256Hex` is synchronous and backed
by `node:crypto.createHash`. `CryptoPort` — encryption, KDF, HKDF, random — is
async and will be webcrypto, as specified, from M1 onward.

## Why this is not a real deviation

It is the same primitive (SHA-256) from the same vetted implementation; only
the API shape differs. Making the digest async would push `await` through
`append()`, which would make it possible to interleave two appends between
reading the head and inserting the row — a correctness bug traded for API
purity.

## If the spec meant this strictly

Then `append` would have to become async and take a lock. That is a worse
design, and I would rather say so than quietly do it.
