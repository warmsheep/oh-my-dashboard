import type { ExtToWebview, SkillSummary } from "@shared/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";

import { groupSkillsByLocation, skillDescriptionLabel, skillScopeLabel, type SkillGroup } from "./helpers";

/** One read-only skills location group (collapsible; the list itself has no controls). */
function SkillLocationGroup({
  group,
  collapsed,
  onToggle,
}: {
  group: SkillGroup;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <section className="block">
      <button type="button" className="block-head" onClick={onToggle} aria-expanded={!collapsed}>
        <span className={`chev${collapsed ? "" : " open"}`} aria-hidden="true">
          ▸
        </span>
        <span className="block-title skill-group-title" title={group.locationLabel}>
          {group.locationLabel}
        </span>
        <span className="scope-pill">{skillScopeLabel(group.scope)}</span>
        <span className="block-count">{group.skills.length} 项</span>
      </button>
      {!collapsed && (
        <ul className="block-body skill-list">
          {group.skills.map((skill) => (
            <li className="skill-row" key={skill.name}>
              <span className="skill-name" title={skill.name}>
                {skill.name}
              </span>
              <span className="skill-desc">{skillDescriptionLabel(skill.description)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * 技能 tab: the read-only skills list moved out of the OMO tab. Skills data still
 * rides the configInit pushes (no own channel) — the tab renders from payload.skills
 * and keeps its collapsed-state local. State comes from pushes only.
 */
export default function SkillApp() {
  const [skills, setSkills] = useState<readonly SkillSummary[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const msg = event.data as ExtToWebview | undefined;
      if (!msg || typeof msg !== "object") {
        return;
      }
      if (msg.type === "configInit") {
        setSkills(msg.payload.skills);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const toggleCollapsed = useCallback((key: string) => {
    setCollapsed((c) => ({ ...c, [key]: !(c[key] ?? false) }));
  }, []);

  const groups = useMemo(() => groupSkillsByLocation(skills), [skills]);

  return (
    <div className="cfg-tab">
      {/* Read-only by construction: the skills list renders no interactive elements.
          (aria-readonly is NOT set — it is invalid ARIA on non-widget containers.) */}
      <section className="cfg-block" aria-label="Skills">
        <header className="cfg-block-head">
          <h2>Skills</h2>
        </header>
        {groups.length === 0 ? (
          <div className="empty">未发现 Skills</div>
        ) : (
          groups.map((group) => (
            <SkillLocationGroup
              key={group.locationLabel}
              group={group}
              collapsed={collapsed[group.locationLabel] ?? false}
              onToggle={() => toggleCollapsed(group.locationLabel)}
            />
          ))
        )}
      </section>
    </div>
  );
}
