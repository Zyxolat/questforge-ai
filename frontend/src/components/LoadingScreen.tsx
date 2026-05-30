export default function LoadingScreen() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center text-center">
      <div className="questforge-panel relative w-full max-w-xl overflow-hidden rounded-[2rem] px-8 py-10">
        <div className="absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-glowyellow/80 to-transparent" />
        <div className="absolute left-1/2 top-6 h-24 w-24 -translate-x-1/2 rounded-full bg-glowyellow/20 blur-3xl" />
        <div className="relative space-y-4">
          <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full border border-glowyellow/30 bg-glowyellow/10">
            <div className="h-10 w-10 animate-pulse rounded-full bg-glowyellow/50 blur-md" />
          </div>
          <p className="text-xs uppercase tracking-[0.35em] text-softyellow">Live AI Forge</p>
          <div data-questforge-heading="true" className="text-3xl font-semibold text-white">
            Forging your next onchain chapter
          </div>
          <p className="mx-auto max-w-md text-sm text-slate-300">
            QuestForge is loading wallet state, syncing the realm, and preparing a cinematic AI quest reveal.
          </p>
          <div className="mx-auto grid max-w-md grid-cols-3 gap-3 pt-3 text-left text-[11px] uppercase tracking-[0.18em] text-slate-400">
            <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3">Wallet Auth</div>
            <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3">AI Narrative</div>
            <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3">Celo Sync</div>
          </div>
        </div>
      </div>
    </div>
  );
}
