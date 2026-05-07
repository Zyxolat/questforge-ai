export default function LoadingScreen() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center text-center">
      <div className="space-y-4 rounded-3xl border border-white/10 bg-navy/80 px-8 py-10 shadow-glow">
        <div className="mx-auto h-16 w-16 animate-pulse rounded-full bg-glowyellow/40 blur-xl" />
        <div className="text-xl font-semibold text-white">Forging your adventure...</div>
        <p className="text-sm text-slate-300">The Forge Master is shaping a new quest on the blockchain.</p>
      </div>
    </div>
  );
}
