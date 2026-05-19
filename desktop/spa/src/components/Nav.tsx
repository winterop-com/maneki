/**
 * Two-section sidebar nav. Section headers are clickable - collapse/expand
 * state survives reloads via localStorage. Sections are hidden entirely when
 * the server doesn't advertise that kind.
 */

import { useCallback, useEffect, useState } from "react";
import type { Capabilities } from "../state/capabilities";

const STORAGE_KEY = "mediakit.nav.collapsed";

export type SectionKey = "music" | "video";
export type ViewId = "music.overview" | "video.overview";

interface NavProps {
  capabilities: Capabilities;
  current: ViewId | null;
  onSelect: (view: ViewId) => void;
}

function readCollapsed(): Set<SectionKey> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return new Set();
    return new Set(JSON.parse(raw) as SectionKey[]);
  } catch {
    return new Set();
  }
}

function writeCollapsed(collapsed: Set<SectionKey>): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(collapsed)));
}

export function Nav({ capabilities, current, onSelect }: NavProps): React.ReactElement {
  const [collapsed, setCollapsed] = useState<Set<SectionKey>>(() => readCollapsed());

  useEffect(() => {
    writeCollapsed(collapsed);
  }, [collapsed]);

  const toggle = useCallback((key: SectionKey): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  return (
    <nav className="nav">
      {capabilities.audio && (
        <Section
          name="music"
          label="MUSIC"
          collapsed={collapsed.has("music")}
          onToggle={() => toggle("music")}
        >
          <NavItem
            label="Overview"
            selected={current === "music.overview"}
            onClick={() => onSelect("music.overview")}
          />
        </Section>
      )}
      {capabilities.video && (
        <Section
          name="video"
          label="VIDEO"
          collapsed={collapsed.has("video")}
          onToggle={() => toggle("video")}
        >
          <NavItem
            label="Overview"
            selected={current === "video.overview"}
            onClick={() => onSelect("video.overview")}
          />
        </Section>
      )}
    </nav>
  );
}

interface SectionProps {
  name: SectionKey;
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

function Section({ label, collapsed, onToggle, children }: SectionProps): React.ReactElement {
  return (
    <div className="nav-section">
      <button type="button" className="nav-header" onClick={onToggle} aria-expanded={!collapsed}>
        <span className="caret">{collapsed ? "▶" : "▼"}</span>
        {label}
      </button>
      {!collapsed && <ul className="nav-items">{children}</ul>}
    </div>
  );
}

interface NavItemProps {
  label: string;
  selected: boolean;
  onClick: () => void;
}

function NavItem({ label, selected, onClick }: NavItemProps): React.ReactElement {
  return (
    <li>
      <button
        type="button"
        className={selected ? "nav-item selected" : "nav-item"}
        onClick={onClick}
      >
        {label}
      </button>
    </li>
  );
}
