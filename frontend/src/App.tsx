import styles from "./App.module.css";
import { ActivityFeed } from "./components/ActivityFeed";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { Header } from "./components/Header";
import { PurchaseConfirm } from "./components/PurchaseConfirm";
import { Sidebar } from "./components/Sidebar";
import { StageBar } from "./components/StageBar";
import type { ActivityStage } from "./lib/Api";
import { isLive } from "./lib/Api";
import { ArchiveScreen } from "./screens/ArchiveScreen";
import { ChatScreen } from "./screens/ChatScreen";
import { ExecutionScreen } from "./screens/ExecutionScreen";
import { MandateScreen } from "./screens/MandateScreen";
import { ProfileScreen } from "./screens/ProfileScreen";
import { SearchScreen } from "./screens/SearchScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { ShortlistScreen } from "./screens/ShortlistScreen";
import { WalletScreen } from "./screens/WalletScreen";
import { formatMinor, stageBarFraction } from "./state/derive";
import { useHappy } from "./state/useHappy";

const HEADER_META: Record<ActivityStage, string> = {
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
  const { state, actions, displayed } = useHappy();

  const onPurchase = state.screen === "purchase";
  const archive = state.viewingArchive;
  const flow = archive ? null : displayed;
  const isChat =
    onPurchase &&
    !archive &&
    (!flow || flow.stage === "idle" || flow.stage === "wishlist" || flow.stage === "curate");

  /*
   * Header title/meta and Back render only on the Purchase screen, so Wallet /
   * Mandate / Settings / Profile always show their own title while the focused
   * activity stays remembered.
   */
  const title = onPurchase
    ? (archive?.title ?? flow?.title ?? "New activity")
    : SCREEN_TITLE[state.screen as keyof typeof SCREEN_TITLE];
  const meta = onPurchase ? (archive?.displayTs ?? (flow ? HEADER_META[flow.stage] : "draft")) : "";

  const shortlistTotal = flow?.shortlist.reduce((sum, p) => sum + p.listing.amountMinor, 0) ?? 0;

  return (
    <div className={styles.app}>
      <Sidebar
        open={state.sidebarOpen}
        screen={state.screen}
        onPurchase={actions.back}
        onNavigate={actions.goScreen}
        onToggle={actions.toggleSidebar}
      />

      <main className={styles.main}>
        <Header
          title={title}
          meta={meta}
          showBack={state.focused !== null && onPurchase}
          onBack={actions.back}
          onProfile={() => actions.goScreen("profile")}
        />

        <ConnectionBanner
          connection={state.connection}
          error={state.error}
          onDismiss={actions.dismissError}
        />

        {onPurchase && !archive && (
          <StageBar
            stage={flow?.stage ?? "idle"}
            fraction={stageBarFraction(flow)}
            onJump={(stage) => void actions.jumpToStage(stage)}
          />
        )}

        <div className={styles.body}>
          <section className={styles.content}>
            {onPurchase && archive && <ArchiveScreen activity={archive} />}

            {isChat && <ChatScreen state={state} actions={actions} activity={flow} />}

            {onPurchase && !archive && flow?.stage === "search" && (
              <SearchScreen
                activity={flow}
                elapsed={state.elapsed}
                onTogglePlay={() => void actions.togglePlay()}
              />
            )}

            {onPurchase && !archive && flow?.stage === "shortlist" && (
              <ShortlistScreen
                activity={flow}
                actCap={state.mandate?.actCap ?? 2500}
                onReject={(itemId) => void actions.reject(itemId)}
                onRequestPurchase={actions.requestPurchase}
                submitting={state.purchaseSubmitting}
              />
            )}

            {onPurchase && !archive && flow?.stage === "exec" && (
              <ExecutionScreen
                activity={flow}
                onNewActivity={actions.newActivity}
                onViewWallet={() => actions.goScreen("wallet")}
              />
            )}

            {state.screen === "wallet" && (
              <WalletScreen wallet={state.wallet} onTopUp={() => void actions.topUp()} />
            )}
            {state.screen === "mandate" && (
              <MandateScreen
                mandate={state.mandate}
                onChange={(changes) => void actions.setMandate(changes)}
              />
            )}
            {state.screen === "settings" && (
              <SettingsScreen
                settings={state.settings}
                onToggle={(key) => void actions.setSetting(key)}
              />
            )}
            {state.screen === "profile" && <ProfileScreen profile={state.profile} />}
          </section>

          {onPurchase && state.focused === null && (
            <ActivityFeed
              running={state.running}
              archived={state.archived}
              currentOnScreen={!state.detached}
              onOpenCurrent={actions.openCurrent}
              onOpenArchive={(id) => void actions.openArchive(id)}
              onNew={actions.newActivity}
            />
          )}
        </div>
      </main>

      {state.confirmingPurchase && flow && (
        <PurchaseConfirm
          itemCount={flow.shortlist.length}
          total={formatMinor(shortlistTotal)}
          live={isLive()}
          submitting={state.purchaseSubmitting}
          onCancel={actions.cancelPurchase}
          onConfirm={() => void actions.confirmPurchase()}
        />
      )}
    </div>
  );
}
