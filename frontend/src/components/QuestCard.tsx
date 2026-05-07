import { motion } from 'framer-motion';

interface QuestCardProps {
  title: string;
  description: string;
  difficulty: string;
  reward: string;
  status?: string;
}

export default function QuestCard({ title, description, difficulty, reward, status }: QuestCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass-card rounded-3xl border border-white/10 bg-white/5 p-6 shadow-strong backdrop-blur-xl"
    >
      <div className="mb-4 flex items-center justify-between">
        <div>
          <p className="text-sm uppercase tracking-[0.35em] text-glowyellow">Quest</p>
          <h3 className="text-xl font-semibold text-white">{title}</h3>
        </div>
        <span className="rounded-full bg-navy/70 px-3 py-1 text-xs uppercase tracking-[0.24em] text-softyellow">{difficulty}</span>
      </div>
      <p className="mb-4 text-sm leading-6 text-slate-200">{description}</p>
      <div className="flex items-center justify-between text-sm text-white/80">
        <span>{reward}</span>
        {status ? <span className="rounded-full bg-glowyellow/15 px-3 py-1 text-softyellow">{status}</span> : null}
      </div>
    </motion.div>
  );
}
