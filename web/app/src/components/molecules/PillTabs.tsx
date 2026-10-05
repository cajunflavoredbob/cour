import type { KeyboardEvent, Ref } from "react";
import styles from "./PillTabs.module.css";

export interface PillTab<T extends string> {
  id: T;
  label: string;
  testHandle?: string;
  ref?: Ref<HTMLButtonElement>;
}

interface PillTabsProps<T extends string> {
  /** Accessible name of the tab list. */
  label: string;
  tabs: readonly PillTab<T>[];
  active: T;
  onSelect: (id: T) => void;
  /** Prefix for the tab and panel ids; pair with `tabPanelProps`. */
  idPrefix: string;
  className?: string;
}

const tabId = (idPrefix: string, id: string) => `${idPrefix}-tab-${id}`;

/** Attributes for the panel the tabs switch. */
export const tabPanelProps = (idPrefix: string, active: string) => ({
  id: `${idPrefix}-panel`,
  role: "tabpanel" as const,
  "aria-labelledby": tabId(idPrefix, active),
});

/**
 * The guide's pill tabs (Review's piles, the standings views): one tab
 * stop, arrow keys and Home/End move between tabs and switch at once.
 */
export const PillTabs = <T extends string>({ label, tabs, active, onSelect, idPrefix, className }: PillTabsProps<T>) => {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Alt+Left and the like belong to the browser.
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const at = tabs.findIndex((t) => t.id === active);
    const next =
      e.key === "ArrowRight"
        ? (at + 1) % tabs.length
        : e.key === "ArrowLeft"
          ? (at - 1 + tabs.length) % tabs.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? tabs.length - 1
              : null;
    if (next == null) return;
    e.preventDefault();
    onSelect(tabs[next].id);
    document.getElementById(tabId(idPrefix, tabs[next].id))?.focus();
  };

  return (
    <div
      className={className ? `${styles.tabs} ${className}` : styles.tabs}
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          ref={tab.ref}
          type="button"
          role="tab"
          id={tabId(idPrefix, tab.id)}
          aria-selected={tab.id === active}
          aria-controls={`${idPrefix}-panel`}
          tabIndex={tab.id === active ? 0 : -1}
          className={styles.tab}
          data-active={tab.id === active}
          onClick={() => onSelect(tab.id)}
          data-test-handle={tab.testHandle}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
};
