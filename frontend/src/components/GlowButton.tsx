import { motion } from 'framer-motion';

interface GlowButtonProps {
  label: string;
  onClick?: () => void;
  className?: string;
}

export default function GlowButton({ label, onClick, className }: GlowButtonProps) {
  return (
    <motion.button
      whileHover={{ scale: 1.03 }}
      whileTap={{ scale: 0.98 }}
      onClick={onClick}
      className={`rounded-full bg-gradient-to-r from-glowyellow to-softyellow px-6 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-navy shadow-glow transition ${className}`}
    >
      {label}
    </motion.button>
  );
}
