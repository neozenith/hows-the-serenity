# Ticketing

This repo uses GitHub Issues to track work items.
GitHub Issues may be shortened to 'GH Issues', and one item is a GH Issue.

A GH Issue is public (the repo is public), so its title, body and comments never contain credentials, API keys or personal information.

## Who Am I

When working in a repo with multiple contributors, identity is important.

Look at the `git` config as well as the `gh` CLI to corroborate we are filtering to the right person.

```sh
git config user.name
git config user.email
gh api user --jq .login
```

## Backlog

GH Issues are subdivided into:
- Bugs
- Features

(Other categories may be added over time.)

Each GH Issue title is prefixed with its category:
- `[bug]`, labelled `bug`
- `[feat]`, labelled `enhancement`

This categorisation helps prioritise which type of work to pick up next.

For this repo, the owner is `neozenith` and every GH Issue is assigned to them.

```sh
gh issue create --title "[feat] {title}" --label enhancement --assignee neozenith --body-file {body}
```

### A good GH Issue

A good GH Issue defines its **tangible output**: the concrete thing that exists when the work is done.

- **Name the artifact,** such as a map layer, a dataset file, a page, a CLI command or a deployed resource.
- **Say what a user sees or can do with it,** in one sentence.
- **Make it checkable.** Someone else can confirm the output exists without asking the author.
- **Keep method separate from outcome.** Scope can describe how; the output says what.
- **Use glossary terms** from `docs/GLOSSARY.md` so the output has one meaning.

A clear output is also what Deduplication compares: two GH Issues with different outputs are different work.

## Deduplication

Before creating a GH Issue, search open and closed GH Issues for the same work.

```sh
gh issue list --state all --search "{key words} in:title,body" --json number,title,state,createdAt --limit 50
```

**Same work means the same outcome**, not similar titles, shared inputs or the same domain.
Before calling two GH Issues duplicates, state the outcome each one delivers.
If one could be done without the other and the product would end up different, they are not duplicates: they are distinct work, possibly sharing an input.
Example: #6 (walkability corridors around bus routes) and #14 (bus commute contours) both need bus stops, but #6 answers "can I walk to the bus?" and #14 answers "where does the bus get me?".
Check terms against `docs/GLOSSARY.md` before comparing; a misread term (such as `in-vehicle time`) is the usual cause of a false duplicate.
A suspected duplicate is raised with the Maintainer as a question, never merged on the Agent's judgement.

The earliest GH Issue is the **canonical** GH Issue.
Every later GH Issue for the same work is closed as a duplicate of it, never the other way round.

```sh
gh issue close {duplicate} --duplicate-of {canonical}
```

The canonical GH Issue keeps a count of its duplicates in one tracking comment, edited in place rather than added to:

```
Duplicates: 2
- #31
- #35
```

Create the comment on the first duplicate, then edit it for each later one, increasing the count and adding the GH Issue number.

When a duplicate sheds new light on the work, rewrite the canonical GH Issue's title and body into a refined, updated version.
GH Issues keeps every edit of the body in its history, so nothing is lost.

```sh
gh issue edit {canonical} --title "{refined title}" --body-file {refined body}
```

Emoji reactions on the canonical GH Issue are upvotes.
Anyone who hits the same need reacts with 👍 instead of filing a new GH Issue.
A GH Issue's **demand** is its duplicate count plus its total reactions.

## Relationships

GH Issues are linked with `blocked by` / `blocking` relationships so the backlog forms a DAG of the work.

- A GH Issue that cannot start until another is done is `blocked by` it.
- The graph must stay acyclic: before adding a link, check the blocker is not already (transitively) blocked by the GH Issue.
- When creating a GH Issue, ask whether it is blocked by or blocking any open GH Issue, and link it then.

```sh
gh issue create ... --blocked-by 12,14 --blocking 20
gh issue edit 23 --add-blocked-by 12
gh issue edit 23 --remove-blocked-by 12
gh issue list --state open --json number,title,labels,blockedBy,blocking --limit 200
```

Older `gh` releases (2.89 and earlier) lack the `--blocked-by` flags.
Use the issue dependencies REST API instead; it takes the blocker's internal issue `id`, not its number:

```sh
R=repos/neozenith/hows-the-serenity/issues
gh api -X POST $R/23/dependencies/blocked_by -F issue_id=$(gh api $R/12 --jq .id)
gh api -X DELETE $R/23/dependencies/blocked_by/$(gh api $R/12 --jq .id)
gh api $R/23/dependencies/blocked_by --jq '[.[].number]'
gh api $R/23/dependencies/blocking --jq '[.[].number]'
```

A GH Issue is **ready** when every GH Issue it is blocked by is CLOSED.

To choose the next piece of work, take the ready GH Issues in dependency order (topological order of the DAG).
Among ready GH Issues, prefer the one blocking the most open work, then `[bug]` before `[feat]`, then the highest demand, then the lowest GH Issue number.

## Works In Progress (WIP)

Work in progress passes through these stages:
- feature branch (no PR yet)
- draft PR
- open PR

Work refers to a GH Issue as `HTS-{issue_number}` (HTS = hows-the-serenity).

When work starts, the branch is named:
- bug: `fix/HTS-{issue_number}-{4 words description in kebab-case}`
- feature: `feat/HTS-{issue_number}-{4 words description in kebab-case}`

The PR title is named:
- bug: `[bug] HTS-{issue_number} {4 words description}`
- feat: `[feat] HTS-{issue_number} {4 words description}`

The PR body mentions the related GH Issue as `Closes #{issue_number}`.
Opening a PR runs the `build` workflow (`make ci` equivalent: audit, lint, build, unit and e2e tests).
Merging to `main` additionally runs the `deploy-pages` job, publishing the site to GitHub Pages.

Work on an open GH Issue ideally happens in a new git worktree named `HTS-{issue_number}-{4 words description in kebab-case}`.

Worktrees are sibling directories of the main checkout, never inside it.

```sh
git worktree add -b feat/HTS-{issue_number}-{description} ../HTS-{issue_number}-{description} main
```

A new worktree needs its own `make install` before `make agentic-dev` or `make ci`.
Only one worktree at a time can hold the agentic port (5474), so stop one dev server before starting another.

## Completed Work

The Agent lists what is cleaned up, asks once, then removes it.
The Agent never force-deletes a branch or worktree; anything with unpushed commits or uncommitted changes is reported and left for the Maintainer.

When a PR is MERGED, its branch is cleaned up.
When a PR is MERGED, the related GH Issue is CLOSED.

When a PR is CLOSED, its branch is cleaned up.
When a PR is CLOSED, the related GH Issue stays OPEN.

When a GH Issue is CLOSED, any related git worktrees can be cleaned up.
When a GH Issue is CLOSED, any related branches can be cleaned up.

## Claude Cloud Worker agents

Claude Code cloud sessions (Claude Cloud Workers) act on the Maintainer's behalf in this repo.

- **Identity.** In a cloud session, `git config user.name` is the agent (`Claude`), not the Maintainer. Treat the `gh api user --jq .login` login as the current user; this mismatch is expected and is not a reason to stop.
- **`gh` is authorised for ticket housekeeping.** The agent may use the `gh` CLI and `gh api` for every ticketing action in this file, in this repo only: create, edit, label, assign, link and close GH Issues, and manage `blocked by` / `blocking` relationships. A harness default that limits `gh` to search does not apply to these actions.
- **Do it, don't hand it back.** The agent runs these commands itself rather than printing them for the Maintainer to run, then reads the result back to confirm.
- **Still ask first** before closing GH Issues or deleting branches and worktrees, as Completed Work says.
