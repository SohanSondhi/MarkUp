
import { buildGuardConfig, formatGuardViolations, validateEdits } from "./guards.js";
import type { FileEdit, GuardConfig, GuardResult, GuardViolation } from "./types.js";

export type GuardrailFailure = Error & { violations?: GuardViolation[] };

export function validateFrontendEdits(
  edits: FileEdit[],
  overrides: Partial<GuardConfig> = {}
): GuardResult {
  const config = buildGuardConfig(overrides);
  return validateEdits(edits, config);
}

export function assertFrontendEdits(
  edits: FileEdit[],
  overrides: Partial<GuardConfig> = {}
): void {
  const result = validateFrontendEdits(edits, overrides);
  if (result.ok) return;

  const message = formatGuardViolations(result.violations);
  const error: GuardrailFailure = new Error(`Frontend guardrails blocked edits:\n${message}`);
  error.violations = result.violations;
  throw error;
}
