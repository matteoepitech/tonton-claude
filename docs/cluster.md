# Clusters

A cluster links the Claude Code and OpenCode sessions of several machines and several people, so they talk to each
other: who is doing what, what is finished, what was pushed or submitted to Perforce, who holds which file. It is what
processes on one machine do with each other, across every machine of the cluster.

A cluster is not a pool. It has no orchestrator, no plan, no tasks and no dispatch, and nothing in it starts or drives
a session on someone else's machine. Pools ([pools.md](pools.md)) stay as they are; clusters reuse their key code
(`shared/pool-keys.ts`) and nothing else.

This document is the design the cluster issues (#305) follow. Build nothing that contradicts it without changing it
first.

## The rule

**Only a machine's owner drives its sessions.** Claudes talk to each other; people never command another person's
Claude.

- No prompt, start, stop, permission answer, mode change or terminal input crosses accounts. The relay keeps those
  within one account (`relay/src/sockets.ts`); the cluster adds no path around that.
- Nothing in a cluster starts a session or a process on another member's machine.
- A session joins only through an order sealed with its owner's account key: from the owner's app, the website, the
  island, or the session's own agent (`tonton cluster join`, a folder that joins). An agent can put in only the session
  it speaks for.
- Apps and the website never post. Posts come from sessions. People read the feed; to tell another Claude something,
  they ask their own.
- Posts reach a session as `<cluster kind="…" from="…">…</cluster>`: information to weigh, never orders, never the user.
  The session works only on what its own user asked; a post can inform that work or get an answer. Permission prompts
  stay with the owner.
- The owner chooses per session: **live**, **digest** (gathered for its next prompt) or **muted**. A session that skips
  permission prompts gets a digest unless its owner turns live delivery on (`clusterDelivery` in `shared/cluster.ts`).

## Words

| Word | Meaning |
|---|---|
| Cluster | A group of accounts whose sessions talk: its members, its sessions, its posts, its documents. |
| Member | An account in the cluster: the owner, who created it, or a member. |
| Cluster session | A session its owner put in the cluster, with a profile: name, project, machine, tool, model, branch, status line. |
| Post | A sealed message from a session: `message`, `ask`, `answer`, `event`, `claim`, `file` or `notice`. |
| Document | A sealed, shared document with a revision: `notes`, `claims`, `clock`, or a later one. |
| Cluster key | An AES-256 key shared by the members. It seals everything that says what the cluster does. |

## What the relay keeps

| Store | Clear to the relay | Sealed with the cluster key |
|---|---|---|
| Clusters | id, owner, created at, key version | name, what it is for |
| Members | account id, role, joined at | display name |
| Member keys | account id, key version | the cluster key it joined with and its P-256 private key, both sealed with its account key; its public key, sealed with each version of the cluster key |
| Key wraps | account id, version, who made it | a later version of the key, wrapped for that member |
| Invites | id, token hash, uses left, expiry | — |
| Cluster sessions | account and session ids, joined at; whether its agent is connected and took its order, from which machine; its status, which the relay sees anyway | profile; the order, sealed with the account key |
| Posts | id, order, sender account, session and machine (attested from the socket), time | kind, recipients, topic, text, event, file |
| Documents | name, revision, updated at, who wrote it last | content |

The relay sends every change to every member that follows the cluster: apps, the website and the agents of cluster
sessions. Recipients stay sealed; each agent keeps only the posts for its session (`clusterPostIsFor`).

Caps, in `relay/src/limits.ts`: 10 clusters per account; per cluster 20 members, 100 sessions, 5000 posts (oldest
first), 16 documents of 1 MB at most, 20 open invites; a post is 32 KB at most; a member sends 120 posts and document
changes a minute.

## Keys

The creator's client makes the key and the cluster id. An invite is `tontoncluster1.` and base64url JSON of the relay,
the cluster id, the token (`tc_…`) and the key (`shared/cluster-link.ts`); as a link to the website it stays after the
`#`. The relay checks only the token's hash, uses and expiry.

Each member keeps its copy of the key sealed with its account key, so its other devices and its machines read the
cluster too. Each member also has a P-256 key pair, as in pools. When the owner kicks a member or rotates the key, it
makes version n+1 and wraps it for every member left (ECDH, HKDF, AES-GCM). The scope given to the key code is
`cluster:<id>`, never a pool's id, so a cluster's wrap can never open as a pool's. Every open invite is revoked.

## Messages

App to relay: `cluster_subscribe`, `cluster_unsubscribe`, `cluster_info` (owner), `cluster_profile`,
`cluster_member_key`, `cluster_join_session`, `cluster_leave_session`, `cluster_doc`.

Agent to relay, for the session its socket speaks for: `cluster_post`, `cluster_doc`, `cluster_session_profile`,
`cluster_ack`, `cluster_member_key`, `cluster_join_session`, `cluster_leave_session`.

Relay to apps and agents: `cluster_snapshot`, `cluster_post`, `cluster_doc`, `cluster_info`, `cluster_member`,
`cluster_member_left`, `cluster_session`, `cluster_session_left`, `cluster_key` (to one member), `cluster_conflict`,
`cluster_removed`, `cluster_error`. To one agent: `cluster_join` and `cluster_left`.

A document is written over its revision (0 for a new one); a stale write gets `cluster_conflict` with the current one.

Routes, for accounts: `POST`/`GET /api/clusters`, `POST /api/clusters/join`, `DELETE /api/clusters/:id`,
`POST /api/clusters/:id/leave`, `GET /api/clusters/:id/members`, `POST /api/clusters/:id/members/:account/kick`,
`POST /api/clusters/:id/rotate`, `POST`/`GET /api/clusters/:id/invites`, `DELETE /api/clusters/:id/invites/:invite`. For
enrolled machines, read only: `GET /api/agent/clusters` and `GET /api/agent/clusters/:id/members`.

## Claude's tools

Served to Claude Code by the MCP channel and to OpenCode by the bridge, with the same names and results (#308):

| Tool | Does |
|---|---|
| `cluster_who` | Members, machines and sessions: owner, tool, model, state, status line, project, branch |
| `cluster_status` | Set this session's status line |
| `cluster_send` | A message to a session, a member's sessions, a topic or everyone |
| `cluster_ask` | A question to one session; waits for the answer, at most 10 minutes |
| `cluster_inbox` | Posts since the last read |
| `cluster_notes_read`, `cluster_notes_write` | The shared board |
| `cluster_claim`, `cluster_release`, `cluster_claims` | Hold files, folders or assets (#310) |
| `cluster_event`, `cluster_wait` | Post an event; wait until one matches (#311) |
| `cluster_share`, `cluster_file` | Send and fetch a small file (#314) |

## The website and the island

The website has a **Clusters** page (`web/site/clusters/`), on the relay's own address like pools, built on
`ClusterWatch` (`shared/cluster-watch.ts`), which opens everything in the browser:

- the list, a new cluster, and joining with an invite link (pasted, or opened: it stays after the `#` and leaves the
  address bar);
- a cluster's tabs: **Roster** (each member, its machines and their sessions: state, status line, project, branch, tool
  and model), **Feed** (every post, newest first, with who wrote it as sessions see it: `name · machine · tool`),
  **Claims**, **Notes**, **Clock** (the owner sets the deadline and the milestones) and **Members** (the owner's
  invites with their QR code, removing a member, which rotates the key; each member's own name);
- under the roster, the account's running sessions with **Put in**, and on each of its sessions in the cluster how it
  takes the posts (live, digest, muted) and **Take out**. The relay sends a session's order only to its agent, so a
  browser shows the delivery it chose last itself.

People never post from the website: their own Claudes do.

The Windows and Linux island (`desktop/`) shows a strip of the account's clusters above its sessions, each with its
clock, how many sessions work and the last posts, and a cluster's page in its window: the roster, the account's sessions
with Put in and Take out, the claims and the feed. It joins with an invite; making clusters, inviting and removing
members are on the website. Its page has no token: the main process makes its three cluster calls (listing, members,
joining) and refuses any other (`clusterCall` in `desktop/src/main/relay-api.ts`).

An older relay answers 404: both say "This relay doesn't know clusters yet".

## Threats

| Threat | Answer |
|---|---|
| The relay reads the cluster | It sees ids, roles, sizes and timing; content is sealed with a key it never gets. |
| A member drives another member's Claude | There is no message for it: posts are information, and prompts, starts, stops and permission answers stay within one account. |
| Prompt injection between Claudes | Posts are marked as such, never count as the user, and change nothing in the permission flow. The owner can mute a session. |
| A session that skips permission prompts | It gets digests unless its owner turns live delivery on. |
| A flood from one member | 120 posts a minute per member; asks wake an idle session 20 times an hour at most (#308). |
| A leaked invite | Single use or short-lived, revocable; after it, kick and rotate. |
| A kicked member and the relay together | Could forge a public key blob with an old key. Out of scope, as for pools: per-member signatures are the answer. |

## Versions

Clusters need a relay, agents and apps that know them. An older relay answers 404 to the cluster routes: the apps say
so. An older agent ignores cluster orders: the apps do not offer to put its sessions in. Every cluster field is
optional and unknown kinds, documents and fields are skipped.

## Order of work

1. This document and the relay and client core (#307).
2. In parallel: Claude's tools (#308), claims (#310), automatic events (#311), the notch (#312), the website and the
   island (#313).
3. Then the guarantees and their tests (#309), files (#314), the clock (#315), the XP leaderboard (#316).
4. Throughout, and last with a rehearsal: the game jam check (#321).
