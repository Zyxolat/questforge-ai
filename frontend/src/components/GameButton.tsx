import { motion } from 'framer-motion';
import { ReactNode } from 'react';

interface GameButtonProps {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'success' | 'danger' | 'secondary' | 'warning';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
  className?: string;
}

const variantStyles = {
  primary: 'from-cyan-500 via-teal-500 to-blue-600 border-cyan-400/50 hover:border-cyan-300 hover:shadow-lg hover:shadow-cyan-500/50',
  success: 'from-emerald-500 to-green-600 border-emerald-400/50 hover:border-emerald-300 hover:shadow-lg hover:shadow-emerald-500/50',
  danger: 'from-red-500 to-rose-600 border-red-400/50 hover:border-red-300 hover:shadow-lg hover:shadow-red-500/50',
  secondary: 'from-purple-500 to-indigo-600 border-purple-400/50 hover:border-purple-300 hover:shadow-lg hover:shadow-purple-500/50',
  warning: 'from-amber-500 to-orange-600 border-amber-400/50 hover:border-amber-300 hover:shadow-lg hover:shadow-amber-500/50',
};

const sizeStyles = {
  sm: 'px-4 py-2 text-sm',
  md: 'px-6 py-3 text-base',
  lg: 'px-8 py-4 text-lg',
};

export default function GameButton({
  children,
  onClick,
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading = false,
  fullWidth = false,
  className = '',
}: GameButtonProps) {
  return (
    <motion.button
      whileHover={!disabled && !loading ? { scale: 1.03 } : {}}
      whileTap={!disabled && !loading ? { scale: 0.97 } : {}}
      onClick={onClick}
      disabled={disabled || loading}
      className={`
        relative overflow-hidden rounded-2xl font-bold uppercase tracking-[0.15em]
        border-2 bg-gradient-to-r ${variantStyles[variant]} ${sizeStyles[size]}
        text-white shadow-xl transition-all duration-300
        disabled:opacity-50 disabled:cursor-not-allowed
        ${fullWidth ? 'w-full' : ''}
        ${className}
      `}
    >
      {/* Animated background glow */}
      <motion.div
        className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent"
        animate={{ x: [-100, 100] }}
        transition={{ duration: 2, repeat: Infinity }}
        style={{ pointerEvents: 'none' }}
      />

      {/* Button content */}
      <div className="relative z-10 flex items-center justify-center gap-2">
        {loading && (
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 1, repeat: Infinity, easing: 'linear' }}
            className="w-5 h-5"
          >
            ⟳
          </motion.div>
        )}
        {children}
      </div>
    </motion.button>
  );
}
