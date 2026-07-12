export const disabledActions = new Set([
  "send_email",
  "delete_note",
  "rewrite_diary",
  "merge_people",
  "merge_projects",
  "expose_vault_over_network",
  "execute_arbitrary_shell",
  "write_outside_allowlisted_paths",
  "store_secrets_in_vault",
]);

export function enforceHardInvariant(actionName: string): void {
  if (disabledActions.has(actionName)) {
    throw new Error(`hard safety invariant disables action: ${actionName}`);
  }
}

