/** Validation bounds shared between host schemas and management panel forms. */
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
  promptMaxChars: { min: 1000, max: 1_000_000 },
  admissionContextMaxPages: { min: 1, max: 100 },
  admissionContextTimeoutMs: { min: 1, max: 90_000 },
} as const
