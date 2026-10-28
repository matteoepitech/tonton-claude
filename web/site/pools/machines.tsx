// The pool's machines (docs/pool-autopilot.md), one row each: whose it is, what it brings (its Claude plan, how many
// sessions at once), what it works on now, and the rest in its menu. A member opens its own sessions from here; the owner
// and admins, or the session's owner, stop one, and its machine puts the task back on the board. A machine's owner, the
// pool's owner and admins stop it or take it out; its owner chooses the models it runs on (#283) and, as an admin, makes
// it run the orchestrator.
import { BotIcon, EllipsisIcon, MessageSquareIcon, PowerIcon, PowerOffIcon, SparklesIcon, XIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  DEFAULT_TIER_MODELS,
  MODEL_TIERS,
  type ModelPolicyForm,
  type ModelTier,
  machinePlanLabel,
  modelPolicyForm,
  modelPolicyFromForm,
  type OpenPool,
  type PoolState,
  poolAbilities,
  routeView,
  type SessionStatus,
  sessionName,
  TASK_STATE_LABELS,
} from '../../../shared'
import { StatusDot } from '../common'
import { useStore } from '../store'
import { Button } from '../ui/button'
import { Badge } from '../ui/card'
import { cn } from '../ui/cn'
import { Confirm, Dialog, DialogContent, DialogFooter, DialogHeader } from '../ui/dialog'
import { Field, Input } from '../ui/fields'
import { Checkbox, Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/menu'
import { NativeSelect } from '../ui/select'
import { type MachineCard, type MachineSlot, machineCards, type SlotPhase } from './machines-model'
import type { TabProps } from './page'

const TIER_TEXTS: Record<ModelTier, string> = {
  light: 'Light: routine work',
  balanced: 'Balanced: ordinary features',
  strong: 'Strong: demanding work',
}

/** A slot without a session in the pool. */
const PHASE_TEXTS: Record<SlotPhase, string> = {
  working: '',
  starting: 'Its machine is starting a session',
  waiting: 'Waiting for its machine',
  left: 'Its session left the pool',
  none: 'No session on it',
}
const PHASE_DOTS: Record<SlotPhase, SessionStatus | null> = {
  working: null,
  starting: 'starting',
  waiting: null,
  left: 'ended',
  none: null,
}

/** Every machine of the pool, theirs first, each on one row: the team's machines at a glance. */
export function MachineList({ pool, state, account }: TabProps & { account?: string }) {
  const store = useStore()
  const names = new Map(store.state?.machines.map(machine => [machine.id, machine.name]))
  const cards = machineCards(state, store.account, names).filter(card => !account || card.machine.account === account)
  if (!cards.length) return null
  return (
    <div className="flex flex-col divide-y rounded-lg border bg-card">
      {cards.map(card => (
        <MachineRow key={`${card.machine.account}/${card.machine.machine}`} card={card} pool={pool} state={state} />
      ))}
    </div>
  )
}

/** Stops every machine of the pool, or starts them again: the owner and admins. */
export function StopEveryMachine({ pool, state }: TabProps) {
  const store = useStore()
  const machines = state.machines ?? []
  const stopped = machines.filter(machine => machine.stopped).length
  if (!poolAbilities(pool.role).kick || !machines.length) return null
  return stopped === machines.length ? (
    <Button
      variant="outline"
      size="sm"
      title="The dispatch stays off: accept a plan or ask the orchestrator to start it."
      onClick={() => store.client?.sendPool({ t: 'pool_stop_machine', poolId: pool.id, machine: null, stopped: false })}
    >
      <PowerIcon />
      Start every machine
    </Button>
  ) : (
    <Confirm
      trigger={
        <Button variant="outline" size="sm" className="text-destructive">
          <PowerOffIcon />
          Stop everything
        </Button>
      }
      title="Stop every machine?"
      description="The dispatch stops, and every machine ends its pool sessions and puts their tasks back on the board. Nothing starts again until you start the machines and the dispatch."
      action="Stop every machine"
      onConfirm={() => void store.pools?.stopAllMachines(pool.id)}
    />
  )
}

function MachineRow({ card, pool, state }: { card: MachineCard; pool: OpenPool; state: PoolState }) {
  const store = useStore()
  const can = poolAbilities(pool.role)
  // The relay lets its owner, and the pool's owner and admins, stop a machine or take it out.
  const manages = card.mine || can.kick
  const { machine } = card
  const profile = machine.profile
  const [asking, setAsking] = useState<'stop' | 'remove' | 'models' | null>(null)
  const status = machine.stopped ? 'stopped' : !machine.online ? 'offline' : machine.ready ? null : 'update the agent'
  const busy = card.slots.length
  return (
    <div className="flex flex-col gap-2 px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <StatusDot status={machine.stopped || !machine.online ? 'offline' : busy ? 'working' : 'idle'} />
        <strong className="truncate text-sm font-medium">{card.name}</strong>
        {card.orchestrator && (
          <Badge title="It runs the orchestrator, and takes tasks too">
            <BotIcon className="size-3" />
            orchestrator
          </Badge>
        )}
        {status && <Badge variant={machine.stopped ? 'destructive' : machine.online ? 'warning' : 'secondary'}>{status}</Badge>}
        {profile?.mode === 'full' && (
          <Badge variant="outline" title="Its owner lets its sessions run commands without asking.">
            no prompts
          </Badge>
        )}
        <span className="ms-auto shrink-0 text-xs text-muted-foreground">
          {profile ? `${machinePlanLabel(profile)} · ${busy}/${profile.capacity} busy` : 'its settings could not be read'}
        </span>
        {manages && (
          <Menu>
            <MenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7" aria-label={`What to do with ${card.name}`}>
                <EllipsisIcon />
              </Button>
            </MenuTrigger>
            <MenuContent align="end">
              {card.mine && profile && (
                <MenuItem onSelect={() => setAsking('models')}>
                  <SparklesIcon />
                  Models…
                </MenuItem>
              )}
              {card.mine && can.chooseOrchestrator && (
                <MenuItem
                  onSelect={() =>
                    store.pools?.setOrchestratorMachine(
                      pool.id,
                      card.orchestrator ? null : { account: machine.account, machine: machine.machine },
                    )
                  }
                >
                  <BotIcon />
                  {card.orchestrator ? 'Not the orchestrator' : 'Run the orchestrator here'}
                </MenuItem>
              )}
              {machine.stopped ? (
                <MenuItem onSelect={() => store.pools?.stopMachine(pool.id, machine.machine, false)}>
                  <PowerIcon />
                  Start it
                </MenuItem>
              ) : (
                <MenuItem variant="destructive" onSelect={() => setAsking('stop')}>
                  <PowerOffIcon />
                  Stop it
                </MenuItem>
              )}
              <MenuItem variant="destructive" onSelect={() => setAsking('remove')}>
                <XIcon />
                Remove from the pool
              </MenuItem>
            </MenuContent>
          </Menu>
        )}
      </div>
      {card.slots.length > 0 && (
        <div className="flex flex-col gap-1 ps-4">
          {card.slots.map(slot => (
            <Slot key={slot.task.id} slot={slot} pool={pool} state={state} />
          ))}
        </div>
      )}
      {machine.online && !machine.ready && !machine.stopped && (
        <p className="ps-4 text-xs text-warning">
          Its agent is too old to take tasks: its owner clicks Update agent in Settings › Machines.
        </p>
      )}
      <Confirm
        open={asking === 'stop'}
        onOpenChange={open => setAsking(open ? 'stop' : null)}
        title={`Stop ${card.name}?`}
        description="Its pool sessions end, and it puts their tasks back on the board. It takes no tasks until it is started again."
        action="Stop it"
        onConfirm={() => store.pools?.stopMachine(pool.id, machine.machine, true)}
      />
      <Confirm
        open={asking === 'remove'}
        onOpenChange={open => setAsking(open ? 'remove' : null)}
        title={`Take ${card.name} out of the pool?`}
        description={`Its pool sessions end and it takes no more tasks. The control loop puts the tasks it held back on the board while the dispatch is on.${card.orchestrator ? ' It stops running the orchestrator.' : ''}`}
        action="Remove"
        onConfirm={() => store.pools?.removeMachine(pool.id, machine.machine)}
      />
      {card.mine && profile && (
        <ModelsDialog card={card} pool={pool} open={asking === 'models'} onOpenChange={open => setAsking(open ? 'models' : null)} />
      )}
    </div>
  )
}

/**
 * The models one of this account's machines runs its tasks on. Saving seals a new order for its agent with the account
 * key, as the Mac app does when it adds the machine: only its owner can, and the pool sees the new profile.
 */
function ModelsDialog({
  card,
  pool,
  open,
  onOpenChange: setOpen,
}: {
  card: MachineCard
  pool: OpenPool
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const store = useStore()
  const profile = card.machine.profile
  const [form, setForm] = useState<ModelPolicyForm>(() => modelPolicyForm(profile?.models))
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Opened from the machine's menu: filled in afresh each time.
  const models = profile?.models
  useEffect(() => {
    if (!open) return
    setForm(modelPolicyForm(models))
    setProblem(null)
  }, [open, models])
  if (!profile) return null

  const reopen = (next: boolean) => setOpen(next)
  const allow = (tier: ModelTier, on: boolean) =>
    setForm(form => ({ ...form, allowed: on ? [...form.allowed, tier] : form.allowed.filter(other => other !== tier) }))
  const save = async () => {
    const models = modelPolicyFromForm(form)
    if (typeof models === 'string') return setProblem(models)
    const { models: _, ...rest } = profile
    setBusy(true)
    const sent = await store.pools?.addMachine(pool.id, card.machine.machine, models ? { ...rest, models } : rest)
    setBusy(false)
    if (!sent) return setProblem('Not connected to the relay: try again in a moment.')
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={reopen}>
      <DialogContent>
        <DialogHeader
          title={`Models on ${card.name}`}
          description="Each task runs on the least costly tier that can do it. Choose the tiers this machine may use and the model each one stands for."
        />
        <div className="flex flex-col gap-4">
          <Field label="Tier">
            <NativeSelect
              className="h-9"
              value={form.lock}
              onChange={event => setForm({ ...form, lock: event.target.value as ModelPolicyForm['lock'] })}
            >
              <option value="auto">By task: the tier each task needs</option>
              {MODEL_TIERS.map(tier => (
                <option key={tier} value={tier}>
                  Always {tier}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <div className="flex flex-col gap-2">
            {MODEL_TIERS.map(tier => (
              <div key={tier} className="grid grid-cols-[1fr_minmax(0,12rem)] items-center gap-3">
                <span className="flex items-center gap-2 text-sm">
                  <Checkbox
                    id={`models-${tier}`}
                    checked={form.allowed.includes(tier)}
                    disabled={form.lock !== 'auto'}
                    onCheckedChange={checked => allow(tier, checked === true)}
                  />
                  <label htmlFor={`models-${tier}`}>{TIER_TEXTS[tier]}</label>
                </span>
                <Input
                  aria-label={`The model for ${tier}`}
                  className="font-mono"
                  value={form.tiers[tier]}
                  placeholder={DEFAULT_TIER_MODELS[tier]}
                  onChange={event => setForm({ ...form, tiers: { ...form.tiers, [tier]: event.target.value } })}
                />
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              A Claude Code alias or model id, or an OpenCode provider/model. Empty: {Object.values(DEFAULT_TIER_MODELS).join(', ')}.
            </p>
          </div>
          <Field label="After a session fails a task">
            <NativeSelect
              className="h-9"
              value={form.escalations}
              disabled={form.lock !== 'auto'}
              onChange={event => setForm({ ...form, escalations: Number(event.target.value) })}
            >
              <option value={0}>Stay on the same tier</option>
              <option value={1}>Climb one tier</option>
              <option value={2}>Climb up to two tiers</option>
            </NativeSelect>
          </Field>
          {problem && <p className="text-sm text-destructive">{problem}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Slot({ slot, pool, state }: { slot: MachineSlot; pool: OpenPool; state: PoolState }) {
  const store = useStore()
  const task = slot.task.task
  const session = slot.session
  const assignee = task?.assignee
  const own = assignee?.account === store.account
  // The owner and admins stop anyone's pool session; a member its own. Only one in the pool: the relay refuses others.
  const canStop = session !== null && (poolAbilities(pool.role).kick || own)
  const status = session ? (session.status ?? (session.online ? 'idle' : 'offline')) : PHASE_DOTS[slot.phase]
  const model = task?.route ? (task.route.confirmed ?? task.route.model) : undefined
  return (
    <div className="group flex min-w-0 items-center gap-2 text-xs">
      <StatusDot status={status} className="size-1.5" />
      <span className="truncate text-sm">{task?.title ?? 'A task'}</span>
      <span
        className={cn('shrink-0', task?.state === 'blocked' ? 'text-destructive' : 'text-muted-foreground')}
        title={[session ? sessionName(state, session) : PHASE_TEXTS[slot.phase], task?.branch, task?.route && routeView(task.route)]
          .filter(Boolean)
          .join(' · ')}
      >
        {task ? TASK_STATE_LABELS[task.state] : ''}
        {model ? ` · ${model}` : ''}
        {task?.attempts ? ` · attempt ${task.attempts + 1}` : ''}
      </span>
      <span className="ms-auto flex shrink-0 gap-1">
        {own && assignee && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2"
            onClick={() => {
              store.setMode('sessions')
              store.select(assignee.session)
            }}
          >
            <MessageSquareIcon />
            Open
          </Button>
        )}
        {canStop && assignee && (
          <Confirm
            trigger={
              <Button variant="ghost" size="sm" className="h-6 px-2 text-destructive">
                Stop
              </Button>
            }
            title="Stop this session's pool work?"
            description="Its session ends and leaves the pool. Its machine puts the task back on the board, for another slot, once it is online."
            action="Stop"
            onConfirm={() => store.client?.sendPool({ t: 'pool_stop', poolId: pool.id, target: assignee })}
          />
        )}
      </span>
    </div>
  )
}
