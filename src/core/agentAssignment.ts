import type { JsoncEdit } from "./jsoncEditor";
import type { JsonPath } from "./types";

/**
 * The canonical 4-edit assignment for one agent/category entry: set the model,
 * set-or-remove the target's reasoning key, and drop the sibling reasoning key plus
 * any `models` chain — otherwise the single-model assignment would silently lose to
 * them. Shared by PresetService.apply() and ConfigStore.setAgentModel() (both import
 * it from this leaf module) so the conflict-key cleanup rules cannot drift between
 * the two write paths.
 */
export function agentAssignmentEdits(
  sectionPath: JsonPath,
  reasoningKey: "reasoning" | "variant",
  section: string,
  name: string,
  model: string,
  variant: string | null,
): JsoncEdit[] {
  const base = [...sectionPath, section, name];
  const otherReasoningKey = reasoningKey === "reasoning" ? "variant" : "reasoning";
  return [
    { path: [...base, "model"], value: model, op: "set" },
    variant === null
      ? { path: [...base, reasoningKey], value: undefined, op: "remove" }
      : { path: [...base, reasoningKey], value: variant, op: "set" },
    { path: [...base, otherReasoningKey], value: undefined, op: "remove" },
    { path: [...base, "models"], value: undefined, op: "remove" },
  ];
}
