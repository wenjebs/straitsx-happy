import styles from "./App.module.css";
import { ActivityFeed } from "./components/ActivityFeed";
import { Header } from "./components/Header";
import { Sidebar } from "./components/Sidebar";
import { StageBar } from "./components/StageBar";
import { ACTIVITY_TITLE, ARCHIVE, type ArchiveId } from "./data/catalog";
import { ArchiveScreen } from "./screens/ArchiveScreen";
import { ChatScreen } from "./screens/ChatScreen";
import { ExecutionScreen } from "./screens/ExecutionScreen";
import { MandateScreen } from "./screens/MandateScreen";
import { ProfileScreen } from "./screens/ProfileScreen";
import { SearchScreen } from "./screens/SearchScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { ShortlistScreen } from "./screens/ShortlistScreen";
import { WalletScreen } from "./screens/WalletScreen";
import { stageBarFraction } from "./state/derive";
import type { Stage } from "./state/types";
import { useHappy } from "./state/useHappy";

const HEADER_META: Record<Stage, string> = {
  idle: "draft",
  wishlist: "step 1 of 5 · wishlist",
  curate: "step 2 of 5 · clarification",
  search: "step 3 of 5 · search",
  shortlist: "step 4 of 5 · confirmation",
  exec: "step 5 of 5 · execution",
};

const SCREEN_TITLE = {
  wallet: "Wallet",
  mandate: "Mandate",
  settings: "Settings",
  profile: "Profile",
} as const;

export function App() {
  const { state, dispatch, tickMs } = useHappy();

  /* An archive id in `focused` opens the archive view instead of the flow. */
  const archiveId: ArchiveId | null =
    state.focused !== null && state.focused !== "current" ? state.focused : null;
  const archive = archiveId ? ARCHIVE[archiveId] : null;

  const onPurchase = state.screen === "purchase";
  const isChat =
    onPurchase &&
    !archive &&
    (state.stage === "idle" || state.stage === "wishlist" || state.stage === "curate");

  /*
   * Header title/meta and Back render only on the Purchase screen, so Wallet /
   * Mandate / Settings / Profile always show their own title while the focused
   * activity stays remembered.
   */
  const title =
    archive && onPurchase
      ? archive.title
      : onPurchase
        ? state.stage === "idle"
          ? "New activity"
          : ACTIVITY_TITLE
        : SCREEN_TITLE[state.screen as keyof typeof SCREEN_TITLE];
  const meta = archive && onPurchase ? archive.ts : onPurchase ? HEADER_META[state.stage] : "";

  return (
    <div className={styles.app}>
      <Sidebar
        open={state.sidebarOpen}
        screen={state.screen}
        onPurchase={() => dispatch({ type: "back" })}
        onNavigate={(screen) => dispatch({ type: "goScreen", screen })}
        onToggle={() => dispatch({ type: "toggleSidebar" })}
      />

      <main className={styles.main}>
        <Header
          title={title}
          meta={meta}
          showBack={state.focused !== null && onPurchase}
          onBack={() => dispatch({ type: "back" })}
          onProfile={() => dispatch({ type: "goScreen", screen: "profile" })}
        />

        {onPurchase && !archive && (
          <StageBar
            stage={state.stage}
            fraction={stageBarFraction(state)}
            onJump={(stage) => {
              dispatch({ type: "openCurrent" });
              dispatch({ type: "goStage", stage });
            }}
          />
        )}

        <div className={styles.body}>
          <section className={styles.content}>
            {onPurchase && archive && <ArchiveScreen archive={archive} />}
            {isChat && <ChatScreen state={state} dispatch={dispatch} />}
            {onPurchase && !archive && state.stage === "search" && (
              <SearchScreen state={state} dispatch={dispatch} tickMs={tickMs} />
            )}
            {onPurchase && !archive && state.stage === "shortlist" && (
              <ShortlistScreen state={state} dispatch={dispatch} />
            )}
            {onPurchase && !archive && state.stage === "exec" && (
              <ExecutionScreen state={state} dispatch={dispatch} />
            )}
            {state.screen === "wallet" && <WalletScreen state={state} dispatch={dispatch} />}
            {state.screen === "mandate" && <MandateScreen state={state} dispatch={dispatch} />}
            {state.screen === "settings" && <SettingsScreen state={state} dispatch={dispatch} />}
            {state.screen === "profile" && <ProfileScreen />}
          </section>

          {onPurchase && state.focused === null && (
            <ActivityFeed
              state={state}
              onOpenCurrent={() => dispatch({ type: "openCurrent" })}
              onOpenArchive={(id) => dispatch({ type: "openArchive", id })}
              onNew={() => dispatch({ type: "newActivity" })}
            />
          )}
        </div>
      </main>
    </div>
  );
}
