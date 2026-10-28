# Pool autopilot

The goal: one person runs a hackathon alone. They talk to the orchestrator in a chat on the website; the orchestrator
plans, creates the tasks and dispatches them to every machine of the pool; each machine starts the sessions that do the
work; nobody moves a card by hand. This builds on [pools.md](pools.md) (keys, sealing, tasks, tools) and
[pool-orchestrator.md](pool-orchestrator.md) (the rules). Issue #253; the website is #254.

## What changes from today

| Today | Autopilot |
|---|---|
| A person puts each session in the pool | A member puts a whole **machine** in the pool; its agent starts sessions itself |
| Tasks are assigned to sessions, and wait for an Accept | Tasks are **dispatched to machines**; the machine starts a session per task, which starts at once |
| Someone picks the orchestrator session and talks to it in its terminal | The admin picks the **orchestrator machine**; its agent starts the orchestrator session; the admin talks to it in the **website's chat** |
| The orchestrator assigns when asked | A **control loop** in the orchestrator's agent dispatches by itself, like a Kubernetes controller |

Sessions joined by hand (#219) keep working as they do.

## Pool machines

A member adds one of its machines to a pool (website › pool › Machines › Add, or Settings › Machines in the app), with a
profile sealed with the pool key:

| Field | Meaning |
|---|---|
| `tool` | `claude` or `opencode`: what its sessions run |
| `capacity` | How many sessions it runs at once for the pool, 1 to 8 (default 1) |
| `workdir` | Folder on the machine where the pool's work goes: the repository is cloned there once, and each task gets a git worktree under it |
| `mode` | What its sessions may do without asking: `ask` (permission prompts go to the machine owner, as today), `edits` (file edits and read-only tools pass, the rest asks), `full` (everything passes: only for a machine or VM given to the hackathon) |
| `takes`, `areas` | As for sessions: simple or large tasks, and the areas it prefers |

The order that adds the machine is sealed with the owner's **account key** and names the machine: only its owner can put
it in a pool, and the relay can't move it to another one (like the session order of #216). The relay keeps
`pool_machines` (account, machine id, sealed profile, the order, added at) with a cap, and forwards pool traffic to the
machine's **service** connection. A machine's online state is the relay's (as for Settings › Machines).

`mode` is the machine owner's choice, never the pool's: the agent's PermissionRequest hook (Claude Code) and the OpenCode
bridge answer the requests of a pool worker session by it. `full` shows a warning when it is chosen.

## Workers

When a task is dispatched to a machine (`task.assignee = { account, machine }`), its agent service:

1. Claims it once (a claim file, like `claimOnce` for starts), and refuses past its capacity.
2. Makes sure `workdir/repo` is a clone of the pool's repository (`info.repo`), then
   `git worktree add workdir/tasks/<task-id> -B pool/<task-id>-<slug> origin/<base>` after a fetch. The agent runs these git
   commands itself: adding the machine to a pool with a `workdir` is the owner's consent. It never runs any other command.
3. Starts a session there with the existing launch code (`agent/src/launch.ts`): Claude Code in a detached tmux with the
   channel, or OpenCode through its service. The session joins the pool as a worker of that machine, with `autoStart`.
4. Hands it the task as its first message (the `<pool kind="task">` envelope, with the branch, the criteria, the notes'
   contracts), so it starts at once.
5. Follows it: `task_done` moves the task on (review or done); the session is then ended (tmux session killed, OpenCode
   session left idle), and the slot is free. A session that ends without `task_done` puts the task back to `todo` with a
   note, and the orchestrator hears of it.

Workers push their branch when done (it is in the task's instructions and allowed by `edits` + the pool's accepted git
rules, or by `full`).

## The orchestrator

- The admin picks one of **their own** machines as the orchestrator machine (`pool_orchestrator` now names a machine as
  well as a session). Its agent starts the orchestrator session in `workdir/repo`, Claude Code, with the orchestrator role
  and guide. Since it is the admin's session, sealed with the admin's account key, only the admin's account reads it and
  writes to it: the website's chat is that session's conversation. Nobody else can drive the orchestrator.
- The admin talks to it in plain words: "build this app" → it writes the plan (notes: contracts, areas) and creates the
  tasks with `plan_create` and `task_create`, without assigning them. "Go" → it calls `dispatch_start`. "Pause" →
  `dispatch_stop`. It answers questions about the pool from `pool_overview`.
- It merges finished branches into main (`git` through its own session, on the admin's machine), keeps main working, and
  re-plans when tasks fail.

## The control loop

In the orchestrator machine's agent, while dispatch is on (a pool setting, sealed, set by `dispatch_start` /
`dispatch_stop` or the website):

- Every 10 seconds and on every pool change, it reconciles: each `todo` task whose dependencies are done goes to the best
  free slot of an online machine that fits it (tool and size as in pool-orchestrator.md: simple tasks to OpenCode first,
  large to Claude Code; area; the account's limits and the budgets of #249; capacity), one change at a time, through the
  same revisions as everything else.
- It notices tasks stalled (no move for 30 minutes), sessions that ended without finishing, machines that went offline
  with a task: the task goes back to `todo` and is dispatched again, at most three times, then `blocked` with the reason.
- It tells the orchestrator session what it did, in short notices, so the chat shows it.
- When every task is done, it says so and stops.

The loop is plain code, not Claude: it costs no tokens and never forgets. Claude plans, merges and answers the admin.

## Stopping

A machine's owner, or the pool's owner and admins, stop a machine (`pool_stop_machine`, #260): the sessions it started
for the pool's tasks end, their tasks go back to the board as they were, uncounted, and it takes no work until one of
them starts it again. The owner and admins stop every machine at once, and the dispatch with them. The orchestrator
session goes on, so the admin can still talk to it. A machine owner can always take their machine out of the pool,
stopped or not. Each of these is a line of the audit log (docs/pools.md, Control).

## Models

Each task runs on the least costly model that can reliably do it (#283, `shared/pool-model.ts`). Models come in three
tiers: **light** for routine work, **balanced** for ordinary features, **strong** for demanding work. By default they are
Claude Code's `haiku`, `sonnet` and `opus`; for OpenCode, the latest model of those families its catalog has.

When a machine starts a task's session, its agent chooses the tier:

1. The machine owner's **lock**, if any: every task runs on it, whatever else says.
2. Else the tier the orchestrator or an admin set on the task (`task_create`'s `model`).
3. Else the task's **assessment**, from what the task says, not from the tool that runs it: a feature, many criteria,
   many hours, several dependencies or parts of the code, and words for demanding work (redesign, migration, protocol,
   concurrency, debugging, security…) raise it; routine words (docs, typos, rename, translation…) and a short task lower
   it. Plain code, so no model is asked to classify each task.
   - **Escalation**: one tier up for each time a session failed the task itself (`setbacks`: it ended or stalled before
     the task was done, or its branch fails main's checks), at most one tier unless the owner allows two. A machine going
     offline or a session that could not start is not a setback. The escalation stays with that task: the next one is
     assessed on its own.
   - While the account is close to its plan's limit, strong becomes balanced, unless the task already failed.
4. The nearest tier the owner **allows**: up first, since a weaker model would fail the task, else down.

The owner's choices are the machine profile's `models`, sealed in its order: `lock`, `allowed` (tiers), `tiers` (the
model each tier stands for: a Claude Code alias or id, an OpenCode `provider/model`), `escalations` (0 to 2). The owner
sets them in the Mac app when adding the machine (Settings › Machines › Add to pool…, Models), and changes them later on
the website: **Models** on the machine's card in the Machines tab seals a new order for its agent. What is left as the
default is not sealed, so a machine its owner never changed follows the defaults as they change.

The model is applied before the task starts: Claude Code is started with `--model`, as `/model` would switch it; OpenCode
is switched by its bridge, the same switch as the notch's model menu (OpenCode 1 takes it with the next message, which is
the task). The agent then waits up to 20 seconds for the session to say what it runs on (Claude Code's status line, the
bridge), and only then hands it the task. The task's `route` keeps the tier, the model, the reason, any escalation, and
the model the session confirmed or why it could not be applied; the timeline gets a `model` event (`model_problem` when
the switch failed or was not confirmed). The session runs either way, on what its tool chose. `pool_overview` and
`pool_tasks` show the route.

The budgets, the plan limits and the control loop's rules for who takes a task are unchanged: the model is chosen on the
machine the loop picked.

## The website

The pool page (#254) puts the orchestrator chat first, for the admin: the conversation with its live status, a box to
write, and what the loop did. Next to it: machines with their slots and what each runs, the task board (read only for
everyone but the orchestrator and the admin), the control center graph.

## Try it on one computer

The autopilot needs several machines and accounts. `scripts/pool-demo.ts` runs the whole of it on one computer, in a
temporary folder, without touching your own Tonton or Claude Code setup:

```sh
bun scripts/pool-demo.ts          # the relay on :7777; another port: bun scripts/pool-demo.ts 7788
```

It starts:

- a relay, and an account on it;
- three machines, each with its real background service, its own `TONTON_HOME` and a tmux server of its own: **Lead**,
  the orchestrator machine, which also takes the simple tasks; **Studio** (two sessions at once) and **Laptop**, which
  take the features;
- a sample project, a small shop on `main` of a local git repository;
- a pool on that repository, with the three machines in it and Lead chosen as the orchestrator machine.

From there, nobody moves a card. The orchestrator session writes the plan (the goal, the contracts, the areas) and four
tasks, one of which waits for another, then starts the dispatch. The control loop hands each task to the machine that
fits it; each machine starts a session per task in its own worktree, which claims it, commits on its branch, pushes it
and finishes it. When every task is done, the loop says so and stops. The terminal shows the board as it moves.

The sessions are stand-ins for Claude Code (`test/stand-in-claude.ts`) that run the real channel and the real pool
tools, so the demo spends no tokens: what you watch is the autopilot itself, not what Claude writes. To see it on the
website, open the relay's address and sign in with the account token the script prints. It needs tmux, on macOS or
Linux. Ctrl+C stops everything and deletes the folder.

`test/pool-demo.test.ts` runs the demo to the end in `bun test`.

## Versions

Pool machines need a relay with `pool_machines`, and agents of this version on every machine. Older agents ignore the
machine order; the website shows such machines as "update the agent".
