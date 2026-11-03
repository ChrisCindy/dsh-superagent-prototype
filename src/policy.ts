/**
 * Runtime settings schemas, assessment validation, and policy gate evaluation.
 * Who may originate work is configured per Source in that Source's own identities; the Policy never maps a person across Sources.
 */
import { LIMITS } from './limits.ts'
import { z } from 'zod'
import { ADMISSION_DEFAULTS, type Admission, type AdmissionCell, type AdmissionRow } from './admission.ts'
import { globPattern, key, MANDATE_ACTIONS, type AssessmentOutcome, type Mandate, type MandateLimits, type Policy, type PolicyEffect, type SourceScope,
  type Strength, type Thread, type Ticket, type Trigger, type ActorRef, type GateResult } from './core/index.ts'
import { sameName } from './infra/text.ts'
import { WORKER_COMMANDS } from './infra/environment.ts'

export const RuleIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)
/** The name of an Executor, such as `dsh`, the DshExecutor's. */
export const ExecutorNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)
export const RuleMatchSchema = z.object({ rule_id: RuleIdSchema, reason: z.string().trim().min(1).max(500) }).strict()
export type RuleMatch = z.infer<typeof RuleMatchSchema>
export const RuleAssessmentSchema = RuleMatchSchema.extend({ matched: z.boolean() }).strict()
export type RuleAssessment = z.infer<typeof RuleAssessmentSchema>
export const AdmissionDirectionSchema = z.object({
  implementation_requested: z.boolean(),
  target_basis: z.enum(['specified', 'existing-standard', 'undetermined']),
  requires_design_decision: z.boolean(),
  evidence: z.string().trim().min(1).max(700),
}).strict()
export type AdmissionDirection = z.infer<typeof AdmissionDirectionSchema>
/** Check whether an assessment established implementation intent and a settled target without open design decisions. */
export function directionAllowed(value: unknown): value is AdmissionDirection {
  const result = AdmissionDirectionSchema.safeParse(value)
  return result.success && result.data.implementation_requested && result.data.target_basis !== 'undetermined' && !result.data.requires_design_decision
}
/** A glob over repository-relative paths, as `globPattern` reads it, such as `locale/**`. */
export const GlobSchema = z.string().trim().max(200).refine(glob => { try { globPattern(glob); return true } catch { return false } },
  'A repository-relative glob such as locale/**: no leading /, no . or .. segments, balanced braces')
const PathsSchema = z.array(GlobSchema).min(1).max(20)
/** Mandate limits a rule presets for the tickets accepted under it (see `mandateLimits`); a field it leaves out sets no limit. */
export const LimitsSchema = z.object({
  paths: PathsSchema.optional(),
  actions: z.array(z.enum(MANDATE_ACTIONS)).refine(actions => new Set(actions).size === actions.length, 'Duplicate actions').optional(),
}).strict()
export interface Assessment {
  decision: 'accept' | 'ignore' | 'unavailable'; rule_assessments: RuleAssessment[]; direction: unknown
  title: string; scope: string; reason: string; intent_evidence?: string | null; acknowledgement?: string | null; worktree_name?: string
  paths?: string[] | null
}
/**
 * The limits of a Mandate accepted under `rules` with the assessment's `paths`. A field is limited only when every matched
 * rule presets it, to the union of what they allow, since the work may be any of theirs; a matched rule without it, like an
 * explicit request, which matches none, sets no limit. The rules' paths take precedence over the assessment's, which limit
 * the files only when the rules do not.
 */
export function mandateLimits(rules: readonly Rule[], paths?: readonly string[] | null): MandateLimits | undefined {
  const preset = <T>(field: (limits: z.infer<typeof LimitsSchema>) => readonly T[] | undefined): T[] | undefined =>
    rules.length && rules.every(rule => rule.limits && field(rule.limits)) ? [...new Set(rules.flatMap(rule => field(rule.limits!)!))] : undefined
  const files = preset(limits => limits.paths) ?? (paths?.length ? [...new Set(paths)] : undefined)
  const actions = preset(limits => limits.actions)
  return files || actions ? { ...files ? { paths: files } : {}, ...actions ? { actions } : {} } : undefined
}
/**
 * Validate an assessment against enabled rules and convert it into an engine `AssessmentOutcome`.
 * Acceptance requires a settled direction, at least one matched enabled rule, and `intent_evidence`, and accepts an
 * inferred candidate only in `auto` mode (otherwise recording it as `would_accept`).
 * @throws when `rule_assessments` does not cover every enabled rule exactly once, or an accept omits `intent_evidence`.
 */
export function assessmentOutcome(assessment: Assessment, settings: Pick<Settings, 'policy' | 'eval'>, strength: Strength): AssessmentOutcome {
  const enabled = settings.policy.rules.filter(rule => rule.enabled)
  const judged = assessment.rule_assessments
  const ids = new Set(judged.map(item => item.rule_id))
  if (judged.length !== enabled.length || ids.size !== judged.length || enabled.some(rule => !ids.has(rule.id))) {
    throw new Error('Exactly one assessment for every enabled rule is required; disabled, unknown or missing rule IDs are not allowed')
  }
  const matches = judged.filter(item => item.matched).map(({ rule_id, reason }) => ({ rule_id, reason }))
  const evidence = assessment.intent_evidence ? { intent_evidence: assessment.intent_evidence } : {}
  const audit = { matches, rule_assessments: judged, direction: assessment.direction, ...evidence }
  if (assessment.decision !== 'accept') return { kind: assessment.decision, reason: assessment.reason, audit }
  if (!directionAllowed(assessment.direction)) return { kind: 'ignore', audit, reason: { code: 'directionUnsettled' } }
  if (!matches.length) return { kind: 'ignore', audit, reason: { code: 'noRuleMatched' } }
  if (!assessment.intent_evidence) throw new Error('Acceptance requires intent_evidence')
  const { title, scope, worktree_name: name } = assessment
  const limits = mandateLimits(enabled.filter(rule => matches.some(match => match.rule_id === rule.id)), assessment.paths)
  if (strength === 'inferred' && settings.eval.mode !== 'auto') {
    const proposal = { title, scope, worktree_name: name, ...limits ? { limits } : {} }
    return { kind: 'ignore', audit: { ...audit, would_accept: true, proposal }, reason: { code: 'observed', values: { text: assessment.reason } } }
  }
  return { kind: 'accept', title, scope, reason: assessment.reason, ...(assessment.acknowledgement ? { acknowledgement: assessment.acknowledgement } : {}),
    rules: matches.map(match => match.rule_id), audit, ...(name ? { name } : {}), ...(limits ? { limits } : {}) }
}
const DEFAULT_RULES = [
  { id: 'copy', name: 'Copy fixes', enabled: true, instruction: 'Explicit requests to correct a typo, wording, punctuation or existing translation. Preserve product promises and business meaning.' },
  { id: 'visual', name: 'Visual fixes', enabled: true, instruction: 'Explicit implementation requests for local spacing, alignment, overflow or styling, with a specified target or an objectively established existing standard/correct state to restore. Locating an element or calling it inconsistent, unattractive or hard to understand does not establish a target. Do not invent visual style, information hierarchy, rendering or interaction decisions. No redesign, new interaction or behavior. A known spacing defect does not authorize adjacent undefined restyling; assess only a clearly separable authorized scope. If direction or scope is unsettled, observe only: no acknowledgement, worker or unsolicited question.' },
]
const limit = (bounds: { min: number; max: number }) => z.number().int().min(bounds.min).max(bounds.max).nullable()
/**
 * What one Assignment of a ticket may use before its Executor stops it and asks a person whether to go on: `turns`, the
 * responses of its worker's model; `minutes`, the time its worker's turns run, not the time it waits; and `tokens`, what those
 * responses used as the model reported it. `null` sets no limit.
 */
export const BudgetSchema = z.object({
  turns: limit(LIMITS.budgetTurns).default(300),
  minutes: limit(LIMITS.budgetMinutes).default(120),
  tokens: limit(LIMITS.budgetTokens).default(null),
}).strict()
export type Budget = z.infer<typeof BudgetSchema>
/** A rule's budget for the tickets accepted under it: each field it sets replaces the Executor's default. */
export const RuleBudgetSchema = z.object({ turns: limit(LIMITS.budgetTurns).optional(), minutes: limit(LIMITS.budgetMinutes).optional(),
  tokens: limit(LIMITS.budgetTokens).optional() }).strict()
/**
 * An assessment rule; its instruction may also specify PR reviewers and whether to wait for their approval. Its `limits` preset
 * what the Mandates of tickets accepted under it let the work change and do (see `mandateLimits`), which is part of
 * authorization. Its `budget` sets what each Assignment of such a ticket may use, and its `executor` which Executor runs such a
 * ticket (see `chosenExecutor` in `src/app/executors.ts`), which are not.
 */
export const RuleSchema = z.object({ id: RuleIdSchema, name: z.string().trim().min(1).max(LIMITS.ruleName), enabled: z.boolean(),
  instruction: z.string().trim().min(1).max(LIMITS.ruleInstruction), limits: LimitsSchema.optional(), budget: RuleBudgetSchema.optional(),
  executor: ExecutorNameSchema.optional() }).strict()
export type Rule = z.infer<typeof RuleSchema>
/** A rule as it bears on authorization: without its budget and its Executor. */
const authorizing = ({ budget: _budget, executor: _executor, ...rule }: Rule) => rule
/**
 * The budget of each Assignment of a ticket: the Executor's default, where each rule the ticket was accepted under that sets a
 * field replaces it; of several such rules, the largest wins, and no limit is the largest.
 */
export function ticketBudget(ticket: Pick<Ticket, 'mandate'>, settings: Pick<Settings, 'policy' | 'executor'>): Budget {
  const rules = settings.policy.rules.filter(rule => ticket.mandate.basis.rules?.includes(rule.id) && rule.budget)
  const field = (name: keyof Budget): number | null => {
    const set = rules.flatMap((rule): (number | null)[] => rule.budget![name] === undefined ? [] : [rule.budget![name] ?? null])
    if (!set.length) return settings.executor.budget[name]
    return set.includes(null) ? null : Math.max(...set as number[])
  }
  return { turns: field('turns'), minutes: field('minutes'), tokens: field('tokens') }
}
export const RoleModelSchema = z.object({ provider: z.string().trim().min(1), model: z.string().trim().min(1), reasoningEffort: z.string().trim().min(1).optional() }).strict()
export type RoleModel = z.infer<typeof RoleModelSchema>

export const AllowedSchema = z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict()
const Weak = z.enum(['inferred', 'ignore'])
export const AdmissionRowSchema: z.ZodType<AdmissionRow> = z.object({ listedUnaddressed: Weak.optional(), unlistedAddressed: z.enum(['explicit', 'inferred', 'ignore']).optional(), unlistedUnaddressed: Weak.optional() }).strict()
export const AdmissionTableSchema = z.record(z.string(), AdmissionRowSchema)
export const SourcePolicySchema = z.object({ allowed: z.array(AllowedSchema).default([]), admission: AdmissionTableSchema.default({}) }).catchall(z.unknown())
export type SourcePolicy = z.infer<typeof SourcePolicySchema>
export const PolicyConfigSchema = z.object({
  rules: z.array(RuleSchema).refine(rules => new Set(rules.map(rule => rule.id)).size === rules.length, 'Duplicate rule IDs').default(DEFAULT_RULES),
  sources: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), SourcePolicySchema).default({}),
}).strict()
export const EvalConfigSchema = z.object({
  mode: z.enum(['off', 'observe', 'auto']).default('observe'),
  timeoutSeconds: z.number().int().min(LIMITS.evalTimeoutSeconds.min).max(LIMITS.evalTimeoutSeconds.max).default(120),
  /** Inferred Evals per Source and hour; one over it is recorded `rateLimited` without the assessor. */
  maxInferredPerHour: z.number().int().min(LIMITS.maxInferredPerHour.min).max(LIMITS.maxInferredPerHour.max).default(20),
  model: RoleModelSchema.nullable().default(null),
}).strict()
const CommandNameSchema = z.string().regex(/^[A-Za-z0-9._-]+$/).refine(name => name !== '.' && name !== '..', 'Not a command name')
  .refine(name => !WORKER_COMMANDS.includes(name), `${WORKER_COMMANDS.join(', ')} cannot be blocked`)
/**
 * How `orchestrator_merge_request` enables auto-merge: the CLI of an account other than the agent's that enables it (a command
 * name or an absolute path; empty means people merge every PR), the merge method, the largest change it accepts (additions plus
 * deletions), and the approvals of the head commit it requires from accounts other than the agent's.
 */
export const MergeConfigSchema = z.object({
  cli: z.string().trim().refine(cli => cli === '' || cli.startsWith('/') || !cli.includes('/'), 'A command name or an absolute path, or empty')
    .default(''),
  method: z.enum(['squash', 'merge', 'rebase']).default('squash'),
  maxLines: z.number().int().min(LIMITS.mergeMaxLines.min).max(LIMITS.mergeMaxLines.max).default(200),
  requireApprovals: z.number().int().min(LIMITS.mergeApprovals.min).max(LIMITS.mergeApprovals.max).default(1),
}).strict()
export type MergeConfig = z.infer<typeof MergeConfigSchema>
/** An absolute path without `.` or `..` segments, written without a trailing slash (except `/` itself). */
const WritableRootSchema = z.string().trim().max(LIMITS.writableRoots.chars)
  .refine(path => path.startsWith('/') && !path.split('/').some(part => part === '.' || part === '..'), 'An absolute path without . or ..')
  .transform(path => path.replace(/(.)\/+$/, '$1'))
/**
 * How Executor Sessions are confined: `workspace` (the default) lets their shell and file tools write only their Ticket directory,
 * the platform temporary areas and `writableRoots`; `full`, the escape hatch for a toolchain the sandbox breaks, lets every
 * managed Session, the main Session too, write anywhere the operator's OS user can.
 */
export const SANDBOXES = ['workspace', 'full'] as const
export type Sandbox = typeof SANDBOXES[number]
/**
 * Executor settings: worker model, concurrency, ticket directory root (empty defaults to `<stateDir>/work`), `prepare` command,
 * blocked commands, the `sandbox` of managed Sessions, the extra `writableRoots` of an Executor Session, merging, and the
 * default `budget` of an Assignment.
 */
export const ExecutorConfigSchema = z.object({
  model: RoleModelSchema.nullable().default(null),
  maxWorkers: z.number().int().min(LIMITS.maxWorkers.min).max(LIMITS.maxWorkers.max).default(3),
  directory: z.string().trim().refine(path => path === '' || path.startsWith('/'), 'An absolute path, or empty for <stateDir>/work').default(''),
  prepare: z.string().max(LIMITS.prepareCommand).default(''),
  blockedCommands: z.array(CommandNameSchema).default([]),
  sandbox: z.enum(SANDBOXES).default('workspace'),
  writableRoots: z.array(WritableRootSchema).max(LIMITS.writableRoots.count)
    .refine(roots => new Set(roots).size === roots.length, 'Duplicate writable roots').default([]),
  merge: MergeConfigSchema.default(() => MergeConfigSchema.parse({})),
  budget: BudgetSchema.default(() => BudgetSchema.parse({})),
}).strict()
/**
 * A stored Source instance: the kind that runs it, whether it is on, its configuration, which the kind validates, and the
 * Executor that runs the tickets its Triggers start, when it names one.
 */
export const SourceInstanceSchema = z.object({ kind: z.string().regex(/^[a-z][a-z0-9-]*$/), enabled: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).default({}), executor: ExecutorNameSchema.optional() }).strict()
/**
 * Source instances by ID. An instance stored without `kind` is its kind's first instance, whose ID is the kind's; another
 * instance's ID starts with its kind and a hyphen.
 */
export const SourcesSchema = z.preprocess(value => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).map(([id, stored]) =>
    [id, stored && typeof stored === 'object' && !Array.isArray(stored) && !('kind' in stored) ? { kind: id, ...stored } : stored]))
  : value, z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), SourceInstanceSchema).superRefine((sources, ctx) => {
  for (const [id, { kind }] of Object.entries(sources)) {
    if (id !== kind && !id.startsWith(`${kind}-`)) ctx.addIssue({ code: 'custom', path: [id], message: `The ID of a ${kind} Source instance starts with ${kind}-` })
  }
}))
export const SettingsSchema = z.object({
  paused: z.boolean().default(false),
  sources: SourcesSchema.default({}),
  policy: PolicyConfigSchema.default(() => PolicyConfigSchema.parse({})),
  eval: EvalConfigSchema.default(() => EvalConfigSchema.parse({})),
  executor: ExecutorConfigSchema.default(() => ExecutorConfigSchema.parse({})),
}).strict()
export type Settings = z.infer<typeof SettingsSchema>
export type SettingsBlock = 'policy' | 'eval' | 'executor' | `source:${string}`
export type SettingsSave = SettingsBlock | 'pause'
export type SettingsOrigin = 'panel' | 'tool' | 'sync'

export const POLICY_REVISION = 'mandate-v3'
/**
 * Compute a version hash for settings that affect work authorization.
 * Changes to models, concurrency, pause state, or polling intervals do not invalidate existing decisions.
 */
export function policyVersion(settings: Settings): string {
  return key(POLICY_REVISION, JSON.stringify({ rules: settings.policy.rules.map(authorizing), mode: settings.eval.mode, sources: settings.policy.sources }))
}
export function allowedSender(settings: Settings, actor: ActorRef): z.infer<typeof AllowedSchema> | undefined {
  return settings.policy.sources[actor.source]?.allowed.find(entry => sameName(entry.id, actor.id))
}
/**
 * Look up `actor` in the Source's `bots` policy list (validated by the Source's kind), whose messages are admitted as inferred
 * candidates at most: bots, or, on the schedule Source, the entries whose hits may become candidates.
 */
export function listedBot(settings: Settings, actor: ActorRef): z.infer<typeof AllowedSchema> | undefined {
  const bots = z.array(AllowedSchema).catch([]).parse(settings.policy.sources[actor.source]?.bots ?? [])
  return bots.find(entry => sameName(entry.id, actor.id))
}
export const anyoneAllowed = (settings: Settings): boolean => Object.values(settings.policy.sources).some(part => part.allowed.length > 0)
const senderName = (entry: z.infer<typeof AllowedSchema>): string => entry.name || entry.id

/** Check whether a thread has tickets of its own (excluding context-only subscriptions). */
const participating = (thread: Thread, tickets: Ticket[]): boolean =>
  [...thread.subscriptions, ...tickets.map(ticket => ticket.id)].some(id => !thread.context?.includes(id))
const listened = (sources: SourceScope, source: string, meta: Record<string, unknown>) => sources.scope({ source, meta })

function admissionCell(allowed: boolean, addressed: boolean): AdmissionCell | undefined {
  return allowed ? addressed ? undefined : 'listedUnaddressed' : addressed ? 'unlistedAddressed' : 'unlistedUnaddressed'
}
function admissionOf(settings: Settings, source: string, row: string | undefined, cell: AdmissionCell): Admission {
  return (row === undefined ? undefined : settings.policy.sources[source]?.admission[row]?.[cell]) ?? ADMISSION_DEFAULTS[cell]
}
const STRENGTH: Readonly<Record<Admission, number>> = { ignore: 0, inferred: 1, explicit: 2 }

/** Compute how a settings change from `old` to `now` affects the authorization or matched rules of each open ticket. */
export function policyEffects(tickets: readonly Ticket[], old: Settings, now: Settings, scope: (settings: Settings) => SourceScope):
  Map<string, PolicyEffect> {
  const before = settingsPolicy(old, scope(old)), after = settingsPolicy(now, scope(now))
  const effects = new Map<string, PolicyEffect>()
  for (const ticket of tickets) {
    const rules = (ticket.mandate.basis.rules ?? []).flatMap((id): NonNullable<PolicyEffect['rules']> => {
      const was = old.policy.rules.find(rule => rule.id === id), is = now.policy.rules.find(rule => rule.id === id)
      if (!is?.enabled) return was?.enabled ? [{ id, name: was.name, change: 'disabled' }] : []
      return JSON.stringify(was && authorizing(was)) === JSON.stringify(authorizing(is)) ? []
        : [{ id, name: is.name, change: 'changed', instruction: is.instruction }]
    })
    const effect: PolicyEffect = rules.length ? { rules } : {}
    if (before.revalidate(ticket.mandate) && !after.revalidate(ticket.mandate)) {
      // With the previous accept mode and rules, the Mandate holds unless the sender or receiving scope lost authorization.
      const asBefore = { ...now, eval: old.eval, policy: { ...now.policy, rules: old.policy.rules } }
      if (!settingsPolicy(asBefore, scope(now)).revalidate(ticket.mandate)) {
        Object.assign(effect, { requesterAllowed: false, requester: ticket.mandate.actor })
      } else if (ticket.mandate.strength === 'inferred' && old.eval.mode === 'auto' && now.eval.mode !== 'auto') effect.proactive = false
    }
    if (Object.keys(effect).length) effects.set(ticket.id, effect)
  }
  return effects
}
/** Build the active Policy for gating incoming Triggers and revalidating existing Ticket Mandates. */
export function settingsPolicy(settings: Settings, sources: SourceScope): Policy {
  const version = policyVersion(settings)
  const mode = settings.eval.mode
  /**
   * Gate non-human triggers: only listed bots and schedule entries (as inferred candidates) and senderless system/CI events may
   * pass; other bots are rejected.
   */
  const machineGate = (trigger: Trigger): GateResult => {
    const bot = trigger.actor.id ? listedBot(settings, trigger.actor) : undefined
    if (trigger.actor.id && !bot) return { admissible: false, reason: 'not_human' }
    const scope = listened(sources, trigger.source, trigger.meta)
    if (!scope.listened || !(trigger.addressed || scope.observed)) return { admissible: false, reason: 'not_human' }
    const recorded = { source: trigger.source, scope: trigger.meta, ...scope.row === undefined ? {} : { row: scope.row } }
    const addressed = trigger.addressed ? { addressed: trigger.addressed } : {}
    if (bot) {
      if (mode === 'off') return { admissible: false, reason: 'admission_ignored' }
      const basis = { ...recorded, via: 'bot' as const, sender: senderName(bot), ...addressed, observation: { mode } }
      return { admissible: true, strength: 'inferred', basis }
    }
    const cell = 'unlistedUnaddressed' as const
    if (admissionOf(settings, trigger.source, scope.row, cell) !== 'inferred' || mode === 'off') {
      return { admissible: false, reason: 'admission_ignored' }
    }
    return { admissible: true, strength: 'inferred', basis: { ...recorded, via: 'admission', cell, observation: { mode } } }
  }
  return {
    version, paused: settings.paused, evalTimeoutMs: settings.eval.timeoutSeconds * 1000, maxInferredPerHour: settings.eval.maxInferredPerHour,
    gate(trigger: Trigger, thread, tickets) {
      if (!trigger.human) return machineGate(trigger)
      const allowed = allowedSender(settings, trigger.actor)
      const scope = listened(sources, trigger.source, trigger.meta)
      const row = scope.listened ? scope.row : undefined
      const recorded = { source: trigger.source, scope: trigger.meta, ...row === undefined ? {} : { row }, ...allowed ? { sender: senderName(allowed) } : {} }
      if (allowed && trigger.addressed) return { admissible: true, strength: 'explicit', basis: { ...recorded, via: 'addressed', addressed: trigger.addressed } }
      const cell = admissionCell(!!allowed, !!trigger.addressed)!
      // Unaddressed messages only use the admission table when the Source observes all messages in that scope.
      const receivable = !!trigger.addressed || (scope.listened && scope.observed)
      const admission = receivable ? admissionOf(settings, trigger.source, row, cell) : 'ignore'
      const basis = { ...recorded, via: 'admission' as const, cell, ...trigger.addressed ? { addressed: trigger.addressed } : {} }
      // Check explicit admission cells before thread follow-ups so a thread's tickets never weaken an explicit request to a follow-up.
      if (admission === 'explicit') return { admissible: true, strength: 'explicit', basis }
      // Direct-message threads belong to one sender (no follow-up for others), and inferred follow-ups require an accept mode other than off (when off, the table decides).
      if (!(trigger.addressed === 'direct' && !allowed) && (allowed || mode !== 'off') && participating(thread, tickets)) {
        return { admissible: true, strength: allowed ? 'explicit' : 'inferred', basis: { ...recorded, via: 'followup' } }
      }
      if (admission === 'inferred' && mode !== 'off') return { admissible: true, strength: 'inferred', basis: { ...basis, observation: { mode } } }
      return { admissible: false, reason: !allowed ? 'not_a_member' : receivable && admission === 'ignore' ? 'admission_ignored' : 'no_mention' }
    },
    admitsInferred: rules => mode === 'auto' && rules.length > 0 && rules.every(id => settings.policy.rules.some(rule => rule.enabled && rule.id === id)),
    revalidate(mandate: Mandate) {
      // Revalidation rules follow docs/002 (Eval path; Resume revalidates).
      const { basis } = mandate
      const { source } = basis
      const current = source && basis.scope ? listened(sources, source, basis.scope) : undefined
      if (current && !current.listened) return false
      const rulesOn = (rules: string[] | undefined) => (rules ?? []).every(id => settings.policy.rules.some(rule => rule.enabled && rule.id === id))
      // Explicit follow-ups remain valid; inferred follow-ups require auto mode and enabled matched rules.
      if (basis.via === 'followup') return mandate.strength === 'explicit' || (mode === 'auto' && rulesOn(basis.rules))
      // A bot's candidate holds only while the bot remains on its Source's bot list and passes the observation checks below.
      if (basis.via === 'bot' && !listedBot(settings, mandate.actor)) return false
      // An admission-table Mandate holds while the sender's current cell still grants at least the original strength.
      if (basis.via === 'admission') {
        const { cell } = basis
        const listed = !!allowedSender(settings, mandate.actor)
        // A listed sender who addresses the agent is always explicit and uses no table cell.
        if (cell === 'unlistedAddressed' && listed) return true
        // A sender added to the allowed list since acceptance moves to the listed cell, and still undergoes observation checks below.
        const now = cell === 'unlistedUnaddressed' && listed ? 'listedUnaddressed' : cell
        if (now === 'listedUnaddressed' && !listed) return false
        const admission = admissionOf(settings, source ?? '', current?.listened ? current.row : undefined, now)
        if (STRENGTH[admission] < STRENGTH[mandate.strength]) return false
        if (mandate.strength === 'explicit') return true
      } else if (basis.via !== 'bot' && !allowedSender(settings, mandate.actor)) return false
      // Observed/inferred Mandates hold only while auto mode is active and all matched rules remain enabled.
      if ((basis.via === 'admission' || basis.via === 'listed' || basis.via === 'bot') && basis.observation) return mode === 'auto' && rulesOn(basis.rules)
      return true
    },
  }
}
