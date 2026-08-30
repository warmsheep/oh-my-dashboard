import type { SkillSummary } from "@shared/protocol";

/** One skills-location group of the skills tab's read-only list (grouped by locationLabel). */
export interface SkillGroup {
  locationLabel: string;
  scope: SkillSummary["scope"];
  skills: SkillSummary[];
}

/**
 * Group skills by their location label, preserving first-appearance order of
 * both the groups and the skills within a group (mirrors groupModelsByProvider).
 * A location is either global or project, so the group scope comes from its
 * first entry.
 */
export function groupSkillsByLocation(skills: readonly SkillSummary[]): SkillGroup[] {
  const groups: SkillGroup[] = [];
  const byLabel = new Map<string, SkillGroup>();
  for (const skill of skills) {
    let group = byLabel.get(skill.locationLabel);
    if (!group) {
      group = { locationLabel: skill.locationLabel, scope: skill.scope, skills: [] };
      byLabel.set(skill.locationLabel, group);
      groups.push(group);
    }
    group.skills.push(skill);
  }
  return groups;
}

const SKILL_SCOPE_LABELS: Record<SkillSummary["scope"], string> = {
  global: "全局",
  project: "项目",
};

/** Chinese badge label of a skill scope (全局/项目). */
export function skillScopeLabel(scope: SkillSummary["scope"]): string {
  return SKILL_SCOPE_LABELS[scope];
}

/** Display text of a skill description; empty/whitespace degrades to the 无描述 placeholder. */
export function skillDescriptionLabel(description: string): string {
  return description.trim() === "" ? "无描述" : description;
}
