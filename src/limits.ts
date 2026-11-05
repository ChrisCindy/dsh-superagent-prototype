/** The limits of the values a person sets, which the settings schemas check and the panel's fields offer */
export const LIMITS = {
  ruleName: 100,
  ruleInstruction: 2000,
  evalTimeoutSeconds: { min: 30, max: 600 },
  /** Inferred Evals one Source may start in an hour. */
  maxInferredPerHour: { min: 1, max: 1000 },
  maxWorkers: { min: 1, max: 16 },
  prepareCommand: 4000,
  /** Extra writable roots of an Executor Session: how many, and the longest path. */
  writableRoots: { count: 16, chars: 1000 },
  mergeMaxLines: { min: 1, max: 100_000 },
  mergeApprovals: { min: 1, max: 10 },
  /** The budget of one Assignment: its worker's model turns, the minutes its turns run, and the tokens they use. */
  budgetTurns: { min: 1, max: 100_000 },
  budgetMinutes: { min: 1, max: 10_080 },
  budgetTokens: { min: 1000, max: 10_000_000_000 },
  /**
   * Retention: the days ended work is kept, at least one more than the Sources' two-week polling horizon, so a pruned Thread is
   * never one a Source still polls; and how many settings and prompt versions are kept.
   */
  retentionDays: { min: 15, max: 3650 },
  retentionVersions: { min: 10, max: 100_000 },
  promptMaxChars: { min: 1000, max: 1_000_000 },
  admissionContextMaxPages: { min: 1, max: 100 },
  admissionContextTimeoutMs: { min: 1, max: 90_000 },
} as const
