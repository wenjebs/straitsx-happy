import styles from "./App.module.css";
import { ActivityCancelConfirm } from "./components/ActivityCancelConfirm";
import { ActivityFeed } from "./components/ActivityFeed";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { Header } from "./components/Header";
import { PurchaseConfirm } from "./components/PurchaseConfirm";
import { Sidebar } from "./components/Sidebar";
import { StageBar } from "./components/StageBar";
import { WishlistRevertConfirm } from "./components/WishlistRevertConfirm";
import type { ActivityStage } from "./lib/Api";
import { isLive } from "./lib/Api";
import { ActivityHistoryScreen } from "./screens/ActivityHistoryScreen";
import { ArchiveScreen } from "./screens/ArchiveScreen";
import { BrowserTestScreen } from "./screens/BrowserTestScreen";
import { ChatScreen } from "./screens/ChatScreen";
import { ExecutionScreen } from "./screens/ExecutionScreen";
import { LoginScreen } from "./screens/LoginScreen";
import { MandateScreen } from "./screens/MandateScreen";
import { ProfileScreen } from "./screens/ProfileScreen";
import { SearchScreen } from "./screens/SearchScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { ShortlistScreen } from "./screens/ShortlistScreen";
import { WalletScreen } from "./screens/WalletScreen";
import { formatMinor, stageBarFraction } from "./state/derive";
import { useAuth } from "./state/useAuth";
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
  browsertest: "Browser test",
} as const;

export function App() {
  const auth = useAuth();

  if (auth.state.loading) {
    return (
      <div className={styles.authLoading}>
        <span />
        <strong>Happy</strong>
      </div>
    );
  }

  if (!auth.state.user) {
    return (
      <LoginScreen
        working={auth.state.working}
        error={auth.state.error}
        onLogin={auth.actions.login}
        onSignup={auth.actions.signup}
        onConfirm={auth.actions.confirmSignup}
        onClearError={auth.actions.clearError}
      />
    );
  }

  return <AuthenticatedApp user={auth.state.user} onLogout={auth.actions.logout} />;
}

function AuthenticatedApp({
  user,
  onLogout,
}: {
  user: { initials: string };
  onLogout: () => Promise<void>;
}) {
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
  const meta = onPurchase
    ? state.activityHistory
      ? "activity history"
      : (archive?.displayTs ?? (flow ? HEADER_META[flow.stage] : "draft"))
    : "";

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
          showCancel={onPurchase && flow?.status === "live"}
          cancelling={state.activityCancelling}
          onBack={actions.back}
          onCancel={actions.requestActivityCancel}
          onProfile={() => actions.goScreen("profile")}
          initials={state.profile?.initials ?? user.initials}
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
            {onPurchase && archive && state.activityHistory && (
              <ActivityHistoryScreen
                activity={archive}
                checkpoints={state.activityHistory}
                onClose={actions.closeActivityHistory}
              />
            )}

            {onPurchase && archive && !state.activityHistory && (
              <ArchiveScreen
                activity={archive}
                historyLoading={state.historyLoading}
                onViewHistory={() => void actions.viewActivityHistory()}
              />
            )}

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
              <WalletScreen wallet={state.wallet} onWalletUpdated={actions.setWallet} />
            )}
            {state.screen === "mandate" && (
              <MandateScreen
                mandate={state.mandate}
                onChange={(changes) => void actions.setMandate(changes)}
              />
            )}
            {state.screen === "settings" && <SettingsScreen settings={state.settings} />}
            {state.screen === "profile" && (
              <ProfileScreen profile={state.profile} onSignOut={() => void onLogout()} />
            )}
            {state.screen === "browsertest" && <BrowserTestScreen />}
          </section>

          {onPurchase && state.focused === null && (
            <ActivityFeed
              activities={state.activities}
              onOpen={(id) => void actions.openActivity(id)}
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

      {state.confirmingWishlistRevert && flow && (
        <WishlistRevertConfirm
          submitting={state.wishlistReverting}
          onCancel={actions.cancelWishlistEdit}
          onConfirm={() => void actions.confirmWishlistEdit()}
        />
      )}

      {state.confirmingActivityCancel && flow && (
        <ActivityCancelConfirm
          duringCheckout={flow.stage === "exec"}
          submitting={state.activityCancelling}
          onDismiss={actions.dismissActivityCancel}
          onConfirm={() => void actions.confirmActivityCancel()}
        />
      )}
    </div>
  );
}
