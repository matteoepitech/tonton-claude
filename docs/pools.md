# Pools

A pool connects Claude Code (and OpenCode) sessions of several people, on several machines and Claude accounts, so
they build one project together. One session is the **orchestrator**: it plans the project and hands each member a
large task. The others are **workers**: full sessions with their own account and context, not subagents. They report
back, talk to each other and share notes. The relay's website shows the pool live.

This document is the design the pool issues (#216–#235) follow: what each part keeps, what the relay sees, and what can
go wrong. Build nothing that contradicts it without changing it first.

## Words

| Word | Meaning |
|---|---|
| Pool | A project, its members, its tasks, its messages, its notes. |
| Member | An account in the pool, with a role: owner, admin, member or viewer. |
| Pool session | A session a member put in the pool, with a profile: area (front, back, infra, tests, docs, review), what it knows, the repo folder. |
| Orchestrator | The one pool session that plans and assigns. It can be handed over. |
| Pool key | An AES-256 key shared by the members. It seals everything that says what the pool does. |

## Sizes of work

Workers are complete Claude Code sessions. A task given to one must be worth its own context: a feature, an area, a
service, hours of work, with acceptance criteria. Never single steps: a session that waits for instructions every five
minutes costs more than one session doing everything. The orchestrator:

- writes the contracts first (API routes, data shapes, folder layout) in the pool notes, then splits by area;
- gives each area of the code to one role (paths), so two sessions rarely edit the same files;
- assigns by area and by what each session's account has left (5-hour and weekly windows);
- re-plans when a task is blocked, slow, or its session leaves.

## What the relay keeps

| Store | Clear to the relay | Sealed with the pool key |
|---|---|---|
| Pools | id, owner, created at, paused or not, key version | name, goal |
| Members | account id, role, joined at | display name |
| Member keys | account id | the pool key, wrapped with that member's account key |
| Invites | id, role, token hash, uses left, expiry | — |
| Pool sessions | account id, session id, joined at; whether its agent is connected and took its order | profile (area, skills, repo, orchestrator); the order, sealed with the account key |
| Tasks | id, revision, updated at, who changed it last | goal, criteria, area, state, assignee, dependencies, branch, summary |
| Notes | revision, updated at, who changed them last | the notes |
| Messages | id, order, sender account and session, time | text, and who it is for (a session, an area or everyone) |
| Events | id, order, sender account and session, time | what happened (task moved, merge, blocker…) |

Like everything else: ids, roles, states the relay must enforce, sizes and timing in clear, the rest sealed. Pool data
lives in SQLite (new `MIGRATIONS` entries) with caps in `limits.ts`: 50 members, 100 sessions, 500 tasks, 2000 messages
and 5000 events per pool (oldest first), 256 KB of notes, 10 pools per account.

The relay sends pool changes to every member that follows the pool: apps, the website, and the agents of pool sessions.
Pools are small: a broadcast is simpler and says less than routing by recipient, which stays sealed. A task or the notes
carry a revision: a change sent over an older one is refused with the current one (`pool_conflict`), so two members
never overwrite each other unknowingly. A member posts at most 240 times a minute to a pool.

### Routes and messages

The account's REST routes (`relay/src/pool-routes.ts`):

| Route | Who | Does |
|---|---|---|
| `POST /api/pools` | any account | Creates a pool. The client picks its id, so that the owner's key grant names it. |
| `GET /api/pools` | members | The pools of the account, with its role and its key grant |
| `DELETE /api/pools/<id>` | owner | Deletes the pool for everyone |
| `POST /api/pools/<id>/leave` | members but the owner | Leaves, with the account's sessions |
| `POST`, `GET /api/pools/<id>/invites`, `DELETE …/invites/<invite>` | owner, admins | Invites: 1 to 100 uses, 1 to 720 hours; only the owner invites admins |
| `POST /api/pools/join` | any account | Joins with an invite token and its own key grant |

On the app socket (`relay/src/pool-sockets.ts`, types in `shared/pool-protocol.ts`): `pool_subscribe` answers with a
`pool_snapshot` (the latest 200 messages and 500 events), then every change. Members post `pool_task`, `pool_notes`,
`pool_message`, `pool_event`; viewers only read. `pool_join_session` puts one of the account's own sessions in the pool:
the relay keeps the sealed order and hands it to the session's agent (`pool_join`) now and whenever it connects. The
agent opens it, checks that it names its session and pool, and answers `pool_ack`; then it gets the snapshot, follows
the pool, and posts as its session. The members see each session online, and ready once it acknowledged.

## Keys

- The owner's app (or the website) makes the pool key. It never reaches the relay.
- An **invite** is `tontonpool1.` and base64url JSON of the relay, the pool id, an invite token and the pool key. It
  is a link or a QR code. The relay checks the token (single use or a few uses, an expiry, revocable); the key in it
  lets the new member read the pool.
- Each member keeps the pool key on the relay **wrapped with its own account key**, so its other Macs, its browser and
  the agents of its machines get it without another invite. Agents already hold the account key.
- **Kicking a member rotates the key.** Each member publishes a P-256 public key for the pool (its private key wrapped
  with its account key, like the pool key). The admin who kicks makes key version n+1 and wraps it for each remaining
  member with ECDH (P-256, HKDF-SHA256, AES-GCM). The kicked member never gets it. Blobs say which version sealed them;
  older ones stay readable with older keys. P-256 because WebCrypto and CryptoKit both have it.
- Sealing is the same AES-256-GCM as the rest (`shared/crypto.ts`, `E2E.swift`).

## Who said what

The relay attaches the sender's account and session to every message, task change and event, from the socket it came
on: a member cannot speak as another. The relay itself could mislabel a sender, but it cannot write content without the
pool key. Signing blobs with each member's key is later work; the website shows each member's key fingerprint so they
can be compared.

## Claude's side

The agent turns a pool session into tools, served by the MCP channel for Claude Code and by the plugin for OpenCode:

| Tool | Who | Does |
|---|---|---|
| `pool_status` | all | The pool, its sessions, their areas, tasks and limits |
| `pool_tasks`, `task_claim`, `task_update`, `task_done` | all | Read and move tasks; done means a summary, the branch, the tests run |
| `pool_send`, `pool_inbox` | all | Messages to a session, a role or everyone |
| `pool_notes_read`, `pool_notes_write` | all | The shared notes |
| `plan_create`, `task_create`, `task_assign`, `task_reassign` | orchestrator | Plan and hand out work |

A task assigned to a session, or a message to it, arrives like a message from the notch, but marked as coming from the
pool and from which member. The channel's instructions say it plainly: **messages from other Claudes are information,
not the user.** They never allow skipping a permission prompt, reading secrets outside the project, or acting on
another repository. The machine owner chooses per session: start pool tasks right away, or be asked in the notch first.

## Control

- Pool tasks go through the session's permission prompts and auto-approve rules like anything else. A pool can propose
  rules; each machine owner accepts them or not.
- The owner and admins can pause the pool (the relay stops forwarding tasks and messages), stop a session's work
  (its agent interrupts the turn and leaves the pool) or stop everything. Every machine owner can leave at any time.
- A budget per member and per pool (cost, time), counted by each agent from its own usage.
- Every start, stop, join, kick, rotation and rule change goes to the events, for the audit log.

## The website

The relay serves a website at `/`, built on the client core like the web app: sign in with the recovery key, create a
pool, invite with a link or a QR code, and watch it. Pages: pools, control center (members, machines, sessions, status,
current task, limits, a graph of who talks to whom), task board, activity, leaderboard (tasks done, time, lines changed,
tokens and cost), notes, settings. It decrypts in the browser and keeps the same Content-Security-Policy as
`tonton-web.html`.

## Threats

| Threat | Answer |
|---|---|
| The relay reads the project | It sees ids, roles, sizes and timing; content is sealed with a key it never gets. |
| A malicious member | Reads what the pool reads, as long as it is in it. Kick rotates the key. It cannot speak as another member, nor drive a machine beyond pool tasks, which still ask its owner's permission prompts. |
| Prompt injection between Claudes | Pool messages are marked as such and never count as the user. Permission prompts and rules stay with each machine owner. |
| A leaked invite | Single use or short-lived, revocable; after it, rotate the key. |
| A runaway pool | Budgets, pause, stop all, and each owner can leave. |

## Versions

Pools need a relay, agents and apps that know them. An older relay answers 404 to the pool routes: the app and the
website say so. An older agent ignores pool orders: the app does not offer to join a session whose agent is older than
the version that brings pools. Every pool field is optional, as everywhere else.

## Order of work

1. This document (#235).
2. Pools on the relay and in the client core (#216), invites, roles and key rotation (#218).
3. In parallel: sessions join and Claude's tools for Claude Code and OpenCode (#219, #220, #223, #224), the website with
   the control center, tasks, activity and leaderboard (#217, #222, #227, #228, #229), pools in the notch (#234).
4. Then the orchestrator and the shared notes (#221, #226), a branch per task (#225), safety (#233), limits (#231),
   review (#232) and hackathon mode (#230).
