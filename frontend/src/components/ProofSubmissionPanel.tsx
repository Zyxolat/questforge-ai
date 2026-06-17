import { motion } from 'framer-motion';
import GameUIContainer from './GameUIContainer';
import GameButton from './GameButton';

interface ProofSubmissionPanelProps {
  proofUri: string;
  onProofChange: (value: string) => void;
  onSubmit: () => void;
  loading?: boolean;
  disabled?: boolean;
  disabledReason?: string | null;
  error?: string;
  normalizedProof?: string | null;
  helperText?: string | null;
}

export default function ProofSubmissionPanel({
  proofUri,
  onProofChange,
  onSubmit,
  loading = false,
  disabled = false,
  disabledReason,
  error,
  normalizedProof,
  helperText
}: ProofSubmissionPanelProps) {
  const trimmedProof = proofUri.trim();
  const canSubmit = !loading && !disabled && trimmedProof.length > 0;
  const charCount = trimmedProof.length;

  return (
    <GameUIContainer
      icon="📋"
      title="Submit Your Proof"
      subtitle="Describe how you completed the objective"
      variant="primary"
    >
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) {
            onSubmit();
          }
        }}
      >
        {/* Instructions */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="rounded-xl border border-cyan-400/20 bg-cyan-400/5 p-4 backdrop-blur-sm"
        >
          <p className="text-xs uppercase tracking-[0.15em] text-cyan-300/70 font-semibold">
            📝 How to Submit
          </p>
          <p className="mt-2 text-sm text-cyan-100/80 leading-relaxed">
            Describe your approach and method. The backend will verify your proof off-chain without requiring a blockchain transaction.
          </p>
          {helperText && (
            <p className="mt-2 text-xs text-emerald-300/80 font-medium">✓ {helperText}</p>
          )}
        </motion.div>

        {/* Textarea */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.25 }}
          className="space-y-2"
        >
          <label htmlFor="proof-input" className="block">
            <p className="text-sm font-bold uppercase tracking-[0.15em] bg-clip-text text-transparent bg-gradient-to-r from-cyan-400 to-teal-400">
              Your Proof Description
            </p>
          </label>
          <textarea
            id="proof-input"
            value={proofUri}
            onChange={(e) => onProofChange(e.target.value)}
            placeholder="Enter a description of how you completed the objective..."
            className="w-full min-h-[120px] rounded-xl border-2 border-cyan-400/20 bg-slate-800/50 p-4 text-sm text-white placeholder-slate-500 outline-none transition-all duration-300 focus:border-cyan-400/50 focus:bg-slate-800/70 focus:ring-2 focus:ring-cyan-400/20 backdrop-blur-sm"
            rows={5}
            disabled={loading || disabled}
            maxLength={500}
          />
          <div className="flex justify-between items-center px-2">
            <p className="text-xs text-slate-400">
              {charCount > 0 && charCount < 20 && '⚠ Provide more detail (min. 20 chars)'}
              {charCount >= 20 && charCount < 500 && '✓ Description recorded'}
              {charCount >= 500 && '⚠ Maximum length reached (500 chars)'}
            </p>
            <p className="text-xs text-slate-400 font-mono">{charCount}/500</p>
          </div>
        </motion.div>

        {/* Status Messages */}
        {error && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 backdrop-blur-sm"
          >
            <p className="text-sm text-red-300 font-semibold">⚠ Error: {error}</p>
          </motion.div>
        )}

        {trimmedProof && !error && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 backdrop-blur-sm"
          >
            <p className="text-sm text-emerald-300 font-semibold">✓ Proof recorded and ready</p>
          </motion.div>
        )}

        {disabledReason && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 backdrop-blur-sm"
          >
            <p className="text-sm text-amber-300">ℹ {disabledReason}</p>
          </motion.div>
        )}

        {normalizedProof && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-xl border border-purple-500/30 bg-purple-500/10 p-4 backdrop-blur-sm"
          >
            <p className="text-xs uppercase tracking-[0.1em] text-purple-300/70 font-semibold mb-2">
              🔐 Verified Proof Hash
            </p>
            <p className="break-all font-mono text-xs text-purple-100">{normalizedProof}</p>
          </motion.div>
        )}

        {/* Submit Button */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.35 }}
        >
          <GameButton
            onClick={onSubmit}
            variant="success"
            size="lg"
            disabled={!canSubmit}
            loading={loading}
            fullWidth
          >
            {loading ? '⟳ Verifying Proof' : '⚔️ Submit Proof for Verification'}
          </GameButton>
        </motion.div>

        {/* Info note */}
        <p className="text-center text-xs text-slate-400/60 pt-2">
          Off-chain verification • No blockchain transaction required
        </p>
      </form>
    </GameUIContainer>
  );
}
