import { motion } from 'framer-motion';

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

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative space-y-4 overflow-hidden rounded-[1.5rem] border-2 border-emerald-500 bg-gradient-to-br from-emerald-500/10 to-green-600/10 p-4 shadow-lg sm:rounded-[2rem] sm:p-6 md:p-8"
    >
      <motion.div
        animate={{ opacity: [0.15, 0.4, 0.15] }}
        transition={{ duration: 2, repeat: Infinity }}
        className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(16,185,129,0.28),transparent_55%)]"
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="text-3xl sm:text-4xl">📋</div>
        <div>
          <h3 className="text-xl font-bold text-white sm:text-2xl">Submit Your Proof</h3>
          <p className="text-sm text-slate-300">
            Describe how you completed the objective for off-chain verification.
          </p>
        </div>
      </div>

      <form
        className="relative z-10 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) {
            onSubmit();
          }
        }}
      >
        <div className="rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-emerald-200">How to submit</p>
          <p className="mt-2 text-sm text-white">
            Enter a description of how you completed the objective. The backend will verify your proof.
          </p>
          {helperText ? <p className="mt-2 text-xs text-emerald-100/90">{helperText}</p> : null}
        </div>

        <label className="block">
          <p className="mb-2 text-sm font-semibold uppercase tracking-[0.2em] text-emerald-300">
            Proof Reference
          </p>
          <textarea
            value={proofUri}
            onChange={(e) => onProofChange(e.target.value)}
            placeholder="Describe how you completed the objective..."
            className="min-h-[112px] w-full rounded-2xl border-2 border-white/10 bg-white/5 p-4 text-sm text-white placeholder-slate-500 outline-none transition focus:border-emerald-500/50 sm:min-h-[128px] sm:text-base"
            rows={4}
            disabled={loading || disabled}
          />
        </label>

        {trimmedProof && !normalizedProof && !error ? (
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-sm text-amber-300"
          >
            Your proof description has been recorded.
          </motion.p>
        ) : null}

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
            <p className="mt-2 break-all font-mono text-xs text-white sm:text-sm">
              {normalizedProof}
            </p>
          </motion.div>
        ) : null}

        {disabledReason ? <p className="text-xs text-amber-200">{disabledReason}</p> : null}

        <p className="text-xs text-slate-400">
          Your proof will be verified off-chain by the backend. No blockchain transaction is required.
        </p>

        <motion.button
          type="submit"
          whileHover={{ scale: canSubmit ? 1.02 : 1 }}
          whileTap={{ scale: canSubmit ? 0.98 : 1 }}
          disabled={!canSubmit}
          className="flex min-h-[48px] w-full items-center justify-center rounded-2xl bg-gradient-to-r from-emerald-500 to-green-600 px-4 py-3 text-center text-sm font-bold uppercase tracking-[0.16em] text-white shadow-lg transition hover:shadow-xl disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-[52px] sm:px-6 sm:py-4 sm:text-base"
        >
          {loading ? (
            <motion.span
              animate={{ opacity: [0.5, 1, 0.5] }}
              transition={{ duration: 1.5, repeat: Infinity }}
            >
              ⟳ Submitting Proof...
            </motion.span>
          ) : trimmedProof && !normalizedProof ? (
            'Paste a Valid Proof Hash'
          ) : (
            '✓ Submit Proof for Verification'
          )}
        </motion.button>
      </form>
    </motion.div>
  );
}
