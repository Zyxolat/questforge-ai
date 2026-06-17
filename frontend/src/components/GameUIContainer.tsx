import { motion } from 'framer-motion';
import { ReactNode } from 'react';

interface GameUIContainerProps {
  children: ReactNode;
  title?: string;
  subtitle?: string;
  icon?: string;
  variant?: 'primary' | 'secondary' | 'warning';
  className?: string;
}

const variantGradients = {
  primary: 'from-cyan-500/10 via-transparent to-purple-500/10 border-cyan-400/30 hover:border-cyan-400/50',
  secondary: 'from-purple-500/10 via-transparent to-indigo-500/10 border-purple-400/30 hover:border-purple-400/50',
  warning: 'from-amber-500/10 via-transparent to-orange-500/10 border-amber-400/30 hover:border-amber-400/50',
};

export default function GameUIContainer({
  children,
  title,
  subtitle,
  icon,
  variant = 'primary',
  className = '',
}: GameUIContainerProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className={`relative overflow-hidden rounded-3xl ${className}`}
    >
      {/* Animated glowing background */}
      <motion.div
        animate={{ opacity: [0.3, 0.6, 0.3] }}
        transition={{ duration: 4, repeat: Infinity }}
        className={`absolute inset-0 bg-gradient-to-br ${variantGradients[variant].split(' ')[0]} blur-2xl`}
      />

      {/* Glass-morphism container */}
      <div className={`relative backdrop-blur-xl bg-slate-900/90 border-2 ${variantGradients[variant]} p-8 shadow-2xl transition-all duration-300`}>
        {/* Corner decorations */}
        <div className="absolute top-0 left-0 w-8 h-8 border-t-2 border-l-2 border-cyan-400/50 rounded-tl-xl" />
        <div className="absolute top-0 right-0 w-8 h-8 border-t-2 border-r-2 border-purple-400/50 rounded-tr-xl" />
        <div className="absolute bottom-0 left-0 w-8 h-8 border-b-2 border-l-2 border-purple-400/50 rounded-bl-xl" />
        <div className="absolute bottom-0 right-0 w-8 h-8 border-b-2 border-r-2 border-cyan-400/50 rounded-br-xl" />

        {/* Header section */}
        {(title || subtitle || icon) && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.2 }}
            className="mb-6 space-y-2"
          >
            {icon && (
              <motion.div
                animate={{ y: [0, -4, 0] }}
                transition={{ duration: 2, repeat: Infinity }}
                className="text-4xl"
              >
                {icon}
              </motion.div>
            )}
            {title && (
              <h2 className="text-3xl font-black tracking-wider text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 via-teal-400 to-purple-400">
                {title}
              </h2>
            )}
            {subtitle && (
              <p className="text-cyan-300/70 text-sm font-medium tracking-wide">{subtitle}</p>
            )}
          </motion.div>
        )}

        {/* Content */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
          className="space-y-4"
        >
          {children}
        </motion.div>
      </div>
    </motion.div>
  );
}
