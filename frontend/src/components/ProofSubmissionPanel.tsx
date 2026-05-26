import { motion } from 'framer-motion';

interface ProofSubmissionPanelProps {
  proofUri: string;
  onProofChange: (value: string) => void;
  onSubmit: () => void;
  loading?: boolean;
  disabled?: boolean;
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
  error,
  normalizedProof,
  helperText
}: ProofSubmissionPanelProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative space-y-4 overflow-hidden rounded-[2rem] border-2 border-emerald-500 bg-gradient-to-br from-emerald-500/10 to-green-600/10 p-8 shadow-lg"
    >
      <motion.div
        animate={{ opacity: [0.15, 0.4, 0.15] }}
        transition={{ duration: 2, repeat: Infinity }}
        className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(16,185,129,0.28),transparent_55%)]"
      />

      <div className="flex items-center gap-3">
        <div className="text-3xl">📋</div>
        <div>
          <h3 className="text-2xl font-bold text-white">Submit Your Proof</h3>
          <p className="text-sm text-slate-300">This is the final onchain step before rewards are verified and minted.</p>
        </div>
      </div>

      <div className="relative z-10 space-y-3">
        <div className="rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-emerald-200">What to paste</p>
          <p className="mt-2 text-sm text-white">
            Paste the proof transaction hash or the full Celoscan URL for the action that completed your objective.
          </p>
          {helperText ? <p className="mt-2 text-xs text-emerald-100/90">{helperText}</p> : null}
        </div>

        <label className="block">
          <p className="text-sm uppercase tracking-[0.2em] text-emerald-300 font-semibold mb-2">Proof Reference</p>
          <textarea
            value={proofUri}
            onChange={(e) => onProofChange(e.target.value)}
            placeholder="Enter transaction hash or Celo Explorer link..."
            className="w-full rounded-2xl border-2 border-white/10 bg-white/5 p-4 text-white placeholder-slate-500 outline-none focus:border-emerald-500/50 transition min-h-[100px] sm:min-h-[120px]"
            rows={3}
            disabled={loading || disabled}
          />
        </label>

        {error && (
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-sm text-red-400"
          >
            ⚠ {error}
          </motion.p>
        )}

        {normalizedProof ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="rounded-2xl border border-white/10 bg-white/5 p-4"
          >
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Detected Proof Hash</p>
            <p className="mt-2 break-all font-mono text-xs sm:text-sm text-white overflow-x-auto">{normalizedProof}</p>
          </motion.div>
        ) : null}

        <p className="text-xs text-slate-400">
          💡 Use your transaction hash (e.g., <span className="font-mono text-slate-300">0x...</span>) or paste a Celo Explorer link
        </p>
      </div>

      <motion.button
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        onClick={onSubmit}
        disabled={loading || disabled || !proofUri.trim()}
        className="w-full rounded-2xl bg-gradient-to-r from-emerald-500 to-green-600 px-6 py-3 sm:py-4 font-bold uppercase tracking-[0.2em] text-white shadow-lg hover:shadow-xl transition disabled:opacity-50 disabled:cursor-not-allowed min-h-[44px] sm:min-h-[48px] flex items-center justify-center"
      >
        {loading ? (
          <motion.span
            animate={{ opacity: [0.5, 1, 0.5] }}
            transition={{ duration: 1.5, repeat: Infinity }}
          >
            ⟳ Submitting Proof...
          </motion.span>
        ) : (
          '✓ Submit Proof for Verification'
        )}
      </motion.button>
    </motion.div>
  );
}
