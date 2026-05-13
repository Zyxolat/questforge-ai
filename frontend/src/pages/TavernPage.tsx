import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import GlowButton from '../components/GlowButton';
import { useRealtimeState } from '../context/RealtimeContext';
import { useWallet } from '../context/WalletContext';
import { fetchNPCDialogue } from '../lib/api';

const NPC_TYPES = ['Guild Master', 'Dungeon Guardian', 'Blacksmith', 'Storyteller'];

export default function TavernPage() {
  const { address } = useWallet();
  const {
    connectionStatus,
    hydrationStatus,
    npcDialogues,
    npcRelationships,
    setNpcDialogue,
    syncNow
  } = useRealtimeState();
  const [message, setMessage] = useState('The Forge Master is preparing a path.');
  const [npcType, setNpcType] = useState('Guild Master');
  const [loading, setLoading] = useState(false);

  const activeRelationship =
    npcRelationships.find((relationship) => relationship.npcName === npcType) ??
    npcRelationships.find((relationship) => relationship.npcType === npcType.toLowerCase().replace(/\s+/g, '_')) ??
    null;
  const dialogue = npcDialogues[npcType] ?? message;

  useEffect(() => {
    if (npcDialogues[npcType]) {
      setMessage(npcDialogues[npcType]);
      return;
    }

    void loadDialogue(npcType);
  }, [npcType, npcDialogues]);

  async function loadDialogue(type: string) {
    setLoading(true);
    try {
      const response = await fetchNPCDialogue(type, 'Champion', address);
      setNpcDialogue(type, response.data.dialogue);
      setMessage(response.data.dialogue);
      await syncNow();
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  }

  return (
    <motion.main initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mx-auto max-w-6xl px-6 py-12">
      <div className="rounded-[2rem] border border-white/10 bg-white/5 p-8 shadow-strong backdrop-blur-xl">
        <div className="mb-8">
          <p className="text-sm uppercase tracking-[0.35em] text-glowyellow">Forge Tavern</p>
          <h1 className="mt-3 text-4xl font-black text-white">AI NPC Interaction</h1>
          <p className="mt-3 text-slate-300">Chat with storytellers, blacksmiths, and guild masters to unlock lore, hints, and dynamic missions.</p>
          <p className="mt-4 text-sm text-softyellow">
            Feed hydration: {hydrationStatus} • socket: {connectionStatus}
          </p>
        </div>
        <div className="grid gap-6 lg:grid-cols-[0.75fr_0.25fr]">
          <div className="rounded-3xl border border-white/10 bg-navy/80 p-8 text-slate-200 shadow-glow">
            <p className="text-sm uppercase tracking-[0.35em] text-glowyellow">Current Dialogue</p>
            <p className="mt-4 whitespace-pre-line text-lg leading-8 text-white">
              {loading ? 'Listening for a response from the tavern...' : dialogue}
            </p>
            {activeRelationship ? (
              <div className="mt-6 rounded-3xl border border-white/10 bg-white/5 p-4">
                <p className="text-xs uppercase tracking-[0.22em] text-softyellow">Memory Link</p>
                <p className="mt-2 text-sm text-white">Trust {activeRelationship.trust} • {activeRelationship.opinion}</p>
                <p className="mt-2 text-sm text-slate-300">
                  Unlocks: {activeRelationship.unlocks.length ? activeRelationship.unlocks.join(', ') : 'None yet'}
                </p>
              </div>
            ) : null}
          </div>
          <div className="space-y-4 rounded-3xl border border-white/10 bg-navy/80 p-6 shadow-glow">
            {NPC_TYPES.map((type) => (
              <GlowButton key={type} label={type} onClick={() => setNpcType(type)} className="w-full bg-white/10 text-white hover:bg-white/20" />
            ))}
          </div>
        </div>
      </div>
    </motion.main>
  );
}
