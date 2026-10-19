# ut-tiny: instructions for Claude Code sessions

A tiny-scale Unreal Tournament-style arena shooter in the browser (TypeScript, Vite,
Three.js, Rapier, Vitest), hosted on Netlify.

## First actions on every packet

1. **Verify your model.** Call `get_session` (no arguments) and compare
   `session_context.model` with the issue's `tier:*` label (`tier:fable` =
   `claude-fable-5-1`, `tier:opus` = `claude-opus-5-5`, `tier:sonnet` =
   `claude-sonnet-5-5`, `tier:haiku` = `claude-haiku-5-5`). If they differ, **stop**,
   comment on the issue with both values, and do no other work. See `docs/DESIGN.md` §18.5.
2. **Read `docs/STATUS.md` first**: what is merged, in flight, broken, and next.
3. Read the design sections the issue cites.

## Rules learned the hard way

- Netlify's checks are not CI. A PR is green only when the GitHub Actions jobs
  `check` and `owned-paths` have run and passed on its head commit and it has no
  merge conflict. GitHub skips CI on a conflicted PR.
- Merge `origin/main` into your branch right before pushing.
- When your PR merges, close its issue if it is still open (auto-merge does not).
- **Sign-off means a playable demo on Netlify that works on a phone.** Every demo
  must also run under `npm run dev` and `npm run preview`. Never add a page that
  only exists on the dev server: Netlify only serves pages in the production
  build. Follow `docs/DESIGN.md` §18.8 and the Worker section of
  `docs/AUTOMATION.md`.

## Where the plan is

- `docs/DESIGN.md`: the full design (architecture §8, deployment §14, model routing §17,
  work breakdown §18).
- `docs/BACKLOG.md`: the packet list (P1, P2, ...) with tiers, owned paths, acceptance.
- `.github/ISSUE_TEMPLATE/work-packet.md`: the packet issue template.
- `docs/AUTOMATION.md`: dispatcher, worker and digest procedures.

Do not edit `DESIGN.md` or `BACKLOG.md` unless your packet says so.

## Run, test, build

Node is pinned in `.nvmrc` (22). `npm install` runs automatically via the SessionStart hook.

| Command             | What it does                                                                      |
| ------------------- | --------------------------------------------------------------------------------- |
| `npm run dev`       | Vite dev server; demos at `/demos/` (`dev:lan` to open from a phone on Wi-Fi)     |
| `npm run preview`   | Serve the production build; use for performance (`preview:lan` for a phone)       |
| `npm run typecheck` | `tsc --noEmit`                                                                    |
| `npm run lint`      | ESLint                                                                            |
| `npm run format`    | Prettier (write); `format:check` verifies                                         |
| `npm test`          | Vitest (`tests/**/*.test.ts`, `src/**/*.test.ts`)                                 |
| `npm run build`     | Vite production build into `dist/`                                                |
| `npm run check`     | typecheck + lint + format check + vitest + build; must be green before every push |

## Owned-paths rule

Every packet lists its owned paths. Change only files under them, plus your line in
`docs/STATUS.md`. CI fails a PR that touches anything else. Never change contracts
(`src/sim/types.ts` and friends) as a side effect; that is its own packet.

## Commits and PRs

- Branch: `packet/<n>-<slug>` (for example `packet/1-scaffold`).
- Commits: short imperative subject, mention the packet (`P1: ...`).
- PR title includes the packet id (`P1: Repo scaffold`); the description references the
  issue and lists acceptance results. Use the PR template if one exists.
- Run `npm run check` before pushing. Never force-push, never merge your own PR.
- Update your line in `docs/STATUS.md` in the same PR.
- After opening the PR, subscribe to it and drive it to green: fix CI, answer review
  comments, merge the base branch on conflicts.
