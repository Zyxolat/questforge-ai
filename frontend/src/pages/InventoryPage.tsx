import { motion } from 'framer-motion';
import { InventoryItem, useRealtimeState } from '../context/RealtimeContext';

function formatMintedAt(value: string | Date | null | undefined) {
  if (!value) {
    return 'Pending reveal';
  }

  const date = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? 'Pending reveal' : date.toLocaleDateString();
}

function inventoryTitle(item: InventoryItem) {
  if (item.questHistory) {
    return `Quest Relic ${item.questHistory.slice(0, 8)}`;
  }

  if (item.tokenId) {
    return `Forge NFT #${item.tokenId}`;
  }

  return 'Unrevealed Forge Relic';
}

export default function InventoryPage() {
  const { connectionStatus, hydrationStatus, inventory, notifications, player } = useRealtimeState();
  const mintedCount = notifications.filter((event) => event.eventName === 'nft:minted').length;

  return (
    <motion.main initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mx-auto max-w-7xl px-6 py-12">
      <div className="rounded-[2rem] border border-white/10 bg-white/5 p-8 shadow-strong backdrop-blur-xl">
        <div className="mb-8 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.35em] text-glowyellow">Inventory & NFT Gallery</p>
            <h1 className="mt-3 text-4xl font-black text-white">Achievement Vault</h1>
            <p className="mt-3 text-slate-300">Collect glowing NFTs that carry your quest history, XP, and prestige across the world.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-3xl border border-white/10 bg-navy/80 p-4 text-white">
              <p className="text-xs uppercase tracking-[0.22em] text-softyellow">Relics</p>
              <p className="mt-2 text-2xl font-semibold">{inventory.length}</p>
            </div>
            <div className="rounded-3xl border border-white/10 bg-navy/80 p-4 text-white">
              <p className="text-xs uppercase tracking-[0.22em] text-softyellow">Mint Events</p>
              <p className="mt-2 text-2xl font-semibold">{mintedCount}</p>
            </div>
            <div className="rounded-3xl border border-white/10 bg-navy/80 p-4 text-white">
              <p className="text-xs uppercase tracking-[0.22em] text-softyellow">Sync</p>
              <p className="mt-2 text-sm font-semibold uppercase text-white">{hydrationStatus}</p>
              <p className="mt-1 text-xs uppercase tracking-[0.18em] text-slate-400">{connectionStatus}</p>
            </div>
          </div>
        </div>

        {player ? (
          <div className="mb-8 rounded-3xl border border-white/10 bg-navy/70 p-5 text-slate-200">
            Vault owner: <span className="font-semibold text-white">{player.wallet}</span>
          </div>
        ) : null}

        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {inventory.map((item) => (
            <div key={String(item.tokenId ?? item.id)} className="rounded-3xl border border-white/10 bg-navy/80 p-6 shadow-glow">
              <p className="text-sm uppercase tracking-[0.35em] text-glowyellow">{item.rarity ?? 'Unrevealed'}</p>
              <h2 className="mt-4 text-2xl font-semibold text-white">{inventoryTitle(item)}</h2>
              <p className="mt-4 text-sm text-slate-300">XP Earned: {item.xpEarned ?? 0}</p>
              <p className="mt-2 text-sm text-slate-400">Minted: {formatMintedAt(item.mintedAt)}</p>
              <p className="mt-4 text-xs uppercase tracking-[0.18em] text-softyellow">Token {item.tokenId ?? 'Pending'}</p>
            </div>
          ))}
          {inventory.length === 0 ? (
            <div className="rounded-3xl border border-dashed border-white/10 bg-navy/50 p-6 text-slate-300 sm:col-span-2 lg:col-span-3">
              No NFTs have been hydrated yet. Mint rewards through the quest loop and they will appear here through replay plus websocket sync.
            </div>
          ) : null}
        </div>
      </div>
    </motion.main>
  );
}
