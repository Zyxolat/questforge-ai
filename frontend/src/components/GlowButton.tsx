import { motion } from 'framer-motion';

interface GlowButtonProps {
  label: string;
  onClick?: () => void;
  className?: string;
  disabled?: boolean;
}

export default function GlowButton({ label, onClick, className, disabled = false }: GlowButtonProps) {
  return (
    <motion.button
      whileHover={disabled ? undefined : { scale: 1.03 }}
      whileTap={disabled ? undefined : { scale: 0.98 }}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-full bg-gradient-to-r from-glowyellow to-softyellow px-6 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-navy shadow-glow transition ${
        disabled ? 'cursor-not-allowed opacity-60 shadow-none' : ''
      } ${className}`}
    >
      {label}
    </motion.button>
  );
}
