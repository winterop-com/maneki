/**
 * Sidebar nav: two collapsible sections (Music, Video) using the legacy
 * design's mk-sidebar / mk-pane-section / mk-pane-label / mk-nav-item
 * classes so the look matches the rest of the SPA.
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
    <nav className="mk-sidebar mk-pane">
      {capabilities.audio && (
        <Section
          name="music"
          label="Music"
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
          label="Video"
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
    <div className="mk-pane-section">
      <button
        type="button"
        className="mk-pane-label mk-pane-toggle"
        onClick={onToggle}
        aria-expanded={!collapsed}
      >
        <span className="mk-caret">{collapsed ? "▶" : "▼"}</span>
        {label}
      </button>
      {!collapsed && <div className="mk-pane-section-body">{children}</div>}
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
    <button
      type="button"
      className={"mk-nav-item" + (selected ? " active" : "")}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
