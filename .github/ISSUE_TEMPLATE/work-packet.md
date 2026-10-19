---
name: Work packet
about: One unit of work a single Claude Code session can finish unattended
title: "P<n>: <short name>"
labels: ["packet", "ready"]
---

## Scope

<!-- What to build. Cite docs/DESIGN.md sections by number. -->

## Owned paths

<!-- Directories/files this packet may change. CI fails the PR if it touches others (docs/STATUS.md is always allowed). The check matches exact file paths and directory prefixes ending in `/` only: no wildcards, no notes after a path. -->

-

## Depends on

<!-- Packet issue numbers that must be merged first, or "none". -->

## Acceptance

- [ ] `npm run check` passes (typecheck, lint, vitest, build)
- [ ] <!-- packet-specific tests, screenshots, smoke runs -->

## Tier

<!-- one of: tier:fable, tier:opus, tier:sonnet (set as a label too) -->

## Sign-off

<!-- signoff:auto or signoff:human (set as a label too). signoff:human only for demo packets that ship a playable, phone-friendly demo on the Netlify deploy preview (docs/DESIGN.md §18.8). Everything else is signoff:auto. -->

## Demo

<!-- signoff:human: demo slug, What-to-check items (3–5). signoff:auto: which hub demo, if any, this packet adds to. -->

## Notes for the session

<!-- Known pitfalls, reference files, screenshots to compare against. -->
