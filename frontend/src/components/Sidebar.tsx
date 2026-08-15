import type { Screen } from "../state/types";
import { BagIcon, CardIcon, GearIcon, PanelIcon, ShieldIcon } from "./Icons";
import styles from "./Sidebar.module.css";

interface SidebarProps {
  open: boolean;
  screen: Screen;
  /** Purchase unfocuses the running activity; the rest are plain navigation. */
  onPurchase: () => void;
  onNavigate: (screen: Screen) => void;
  onToggle: () => void;
}

export function Sidebar({ open, screen, onPurchase, onNavigate, onToggle }: SidebarProps) {
  const item = (active: boolean) => `${styles.item} ${active ? styles.active : ""}`;

  return (
    <aside className={`${styles.sidebar} ${open ? "" : styles.collapsed}`}>
      <div className={styles.brand}>
        <div className={styles.mark} />
        {open && <span className={styles.wordmark}>Happy</span>}
      </div>

      <nav className={styles.nav}>
        <button type="button" className={item(screen === "purchase")} onClick={onPurchase}>
          <BagIcon />
          {open && <span>Purchase</span>}
        </button>
        <button
          type="button"
          className={item(screen === "wallet")}
          onClick={() => onNavigate("wallet")}
        >
          <CardIcon />
          {open && <span>Wallet</span>}
        </button>
        <button
          type="button"
          className={item(screen === "mandate")}
          onClick={() => onNavigate("mandate")}
        >
          <ShieldIcon />
          {open && <span>Mandate</span>}
        </button>
        <button
          type="button"
          className={item(screen === "settings")}
          onClick={() => onNavigate("settings")}
        >
          <GearIcon />
          {open && <span>Settings</span>}
        </button>
        <button
          type="button"
          className={item(screen === "browsertest")}
          onClick={() => onNavigate("browsertest")}
          title="AgentCore remote browser — dev only"
        >
          <PanelIcon />
          {open && <span>Browser test</span>}
        </button>
      </nav>

      <div className={styles.footer}>
        <button
          type="button"
          className={styles.item}
          onClick={onToggle}
          title={open ? "Collapse sidebar" : "Expand sidebar"}
          aria-label={open ? "Collapse sidebar" : "Expand sidebar"}
        >
          <PanelIcon />
          {open && <span>Collapse</span>}
        </button>
      </div>
    </aside>
  );
}
