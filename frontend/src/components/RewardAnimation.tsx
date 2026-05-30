import { motion, AnimatePresence } from 'framer-motion';
import { useEffect } from 'react';

interface RewardAnimationProps {
  show: boolean;
  xpAmount?: number;
  tokenAmount?: string;
  nftRarity?: string;
  onComplete?: () => void;
  durationMs?: number;
}

export default function RewardAnimation({
  show,
  xpAmount = 0,
  tokenAmount = '0',
  nftRarity = 'Rare',
  onComplete,
  durationMs = 2600
}: RewardAnimationProps) {
  useEffect(() => {
    if (!show || !onComplete) {
      return;
    }

    const timer = window.setTimeout(() => {
      onComplete();
    }, durationMs);

    return () => window.clearTimeout(timer);
  }, [durationMs, onComplete, show]);

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.3,
        delayChildren: 0.2
      }
    }
  };

  const itemVariants = {
    hidden: { scale: 0, opacity: 0 },
    visible: {
      scale: 1,
      opacity: 1,
      transition: { type: 'spring', stiffness: 200, damping: 20 }
    }
  };

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-40 flex items-center justify-center pointer-events-none"
        >
          {/* Confetti background */}
          <div className="absolute inset-0 overflow-hidden">
            {[...Array(12)].map((_, i) => (
              <motion.div
                key={i}
                animate={{ y: ['0%', '100%'], rotate: 360 }}
                transition={{ duration: 2 + i * 0.1, repeat: 0 }}
                className={`absolute w-3 h-3 rounded-full ${['bg-glowyellow', 'bg-softyellow', 'bg-emerald-500'][i % 3]} opacity-80`}
                style={{
                  left: `${(i / 12) * 100}%`,
                  top: '-10px'
                }}
              />
            ))}
          </div>

          {/* Main content */}
          <motion.div
            variants={containerVariants}
            initial="hidden"
            animate="visible"
            className="relative z-10 flex flex-col items-center gap-12"
          >
            {/* XP Reward */}
            {xpAmount > 0 && (
              <motion.div
                variants={itemVariants}
                animate={{ scale: [1, 1.2, 1], rotate: [0, 5, -5, 0] }}
                transition={{ duration: 0.8 }}
                className="relative"
              >
                <motion.div className="absolute inset-0 bg-emerald-500 blur-2xl rounded-full opacity-60" animate={{ scale: [1, 1.3, 1] }} transition={{ duration: 0.8 }} />
                <div className="relative rounded-full bg-gradient-to-r from-emerald-500 to-green-600 p-8 shadow-2xl">
                  <p className="text-center text-sm uppercase tracking-[0.2em] text-white font-bold">XP Gained</p>
                  <p className="mt-2 text-center text-5xl font-black text-white drop-shadow-lg">+{xpAmount}</p>
                </div>
              </motion.div>
            )}

            {/* Token Reward */}
            {tokenAmount !== '0' && (
              <motion.div
                variants={itemVariants}
                animate={{ scale: [1, 1.2, 1], rotate: [0, -5, 5, 0] }}
                transition={{ duration: 0.8 }}
                className="relative"
              >
                <motion.div className="absolute inset-0 bg-glowyellow blur-2xl rounded-full opacity-60" animate={{ scale: [1, 1.3, 1] }} transition={{ duration: 0.8 }} />
                <div className="relative rounded-full bg-gradient-to-r from-glowyellow to-softyellow p-8 shadow-2xl">
                  <p className="text-center text-sm uppercase tracking-[0.2em] text-navy font-bold">Reward</p>
                  <p className="mt-2 text-center text-4xl font-black text-navy drop-shadow-lg">+{tokenAmount}</p>
                  <p className="text-center text-sm text-navy/80 mt-1">CELO</p>
                </div>
              </motion.div>
            )}

            {/* NFT Rarity */}
            {nftRarity && (
              <motion.div
                variants={itemVariants}
                animate={{ scale: [0.8, 1.3, 1], rotate: [0, 360] }}
                transition={{ duration: 1 }}
                className="relative"
              >
                  <motion.div className="absolute inset-0 bg-glowyellow blur-2xl rounded-full opacity-60" animate={{ scale: [1, 1.3, 1] }} transition={{ duration: 1 }} />
                <div className="relative rounded-full bg-gradient-to-r from-glowyellow to-softyellow p-8 shadow-2xl">
                  <p className="text-center text-sm uppercase tracking-[0.2em] text-white font-bold">NFT Minted</p>
                  <p className="mt-2 text-center text-3xl font-black text-navy drop-shadow-lg">✨</p>
                  <p className="text-center text-navy font-bold mt-2">{nftRarity}</p>
                </div>
              </motion.div>
            )}

            {/* Celebratory text */}
            <motion.div
              variants={itemVariants}
              animate={{ opacity: [0, 1, 0] }}
              transition={{ duration: 2, delay: 0.5 }}
              className="text-center"
            >
              <p className="text-4xl font-black text-glowyellow drop-shadow-lg">Quest Complete!</p>
              <p className="mt-2 text-lg text-white">Check your inventory for your new NFT</p>
            </motion.div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
