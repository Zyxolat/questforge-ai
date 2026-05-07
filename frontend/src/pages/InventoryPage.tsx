import { motion } from 'framer-motion';

const demoInventory = [
  { title: 'Forge Champion', rarity: 'Legendary', xp: 1200, mintedAt: '2026-05-07' },
  { title: 'Chain Explorer', rarity: 'Epic', xp: 850, mintedAt: '2026-04-30' },
  { title: 'AI Vanguard', rarity: 'Rare', xp: 420, mintedAt: '2026-04-25' }
];

export default function InventoryPage() {
  return (
    <motion.main initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mx-auto max-w-7xl px-6 py-12">
      <div className="rounded-[2rem] border border-white/10 bg-white/5 p-8 shadow-strong backdrop-blur-xl">
        <div className="mb-8">
          <p className="text-sm uppercase tracking-[0.35em] text-glowyellow">Inventory & NFT Gallery</p>
          <h1 className="mt-3 text-4xl font-black text-white">Achievement Vault</h1>
          <p className="mt-3 text-slate-300">Collect glowing NFTs that carry your quest history, XP, and prestige across the world.</p>
        </div>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {demoInventory.map((item) => (
            <div key={item.title} className="rounded-3xl border border-white/10 bg-navy/80 p-6 shadow-glow">
              <p className="text-sm uppercase tracking-[0.35em] text-glowyellow">{item.rarity}</p>
              <h2 className="mt-4 text-2xl font-semibold text-white">{item.title}</h2>
              <p className="mt-4 text-sm text-slate-300">XP Earned: {item.xp}</p>
              <p className="mt-2 text-sm text-slate-400">Minted: {item.mintedAt}</p>
            </div>
          ))}
        </div>
      </div>
    </motion.main>
  );
}
