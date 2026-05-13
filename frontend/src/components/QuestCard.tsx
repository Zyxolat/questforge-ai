import { motion } from 'framer-motion';

type TreasuryPayout = {
  status?: string;
  payoutTx?: string | null;
  refundTx?: string | null;
  reservationTx?: string | null;
};

interface QuestCardProps {
  title: string;
  description: string;
  difficulty: string;
  reward: string;
  status?: string;
  payoutStatus?: string;
  treasuryPayout?: TreasuryPayout | null;
  verificationTx?: string | null;
  proofTxHash?: string | null;
  explorerBaseUrl?: string;
}

function statusTone(status?: string) {
  if (status === 'VERIFIED' || status === 'PAID') return 'bg-emerald-400/15 text-emerald-200';
  if (status === 'FAILED' || status === 'REFUNDED' || status === 'CANCELLED') return 'bg-rose-400/15 text-rose-200';
  if (status === 'SUBMITTED' || status === 'RELEASED') return 'bg-amber-300/15 text-amber-100';
  return 'bg-glowyellow/15 text-softyellow';
}

function buildExplorerLink(baseUrl: string | undefined, txHash?: string | null) {
  if (!baseUrl || !txHash) return null;
  return `${baseUrl.replace(/\/$/, '')}/tx/${txHash}`;
}

export default function QuestCard({
  title,
  description,
  difficulty,
  reward,
  status,
  payoutStatus,
  treasuryPayout,
  verificationTx,
  proofTxHash,
  explorerBaseUrl
}: QuestCardProps) {
  const payoutLink = buildExplorerLink(explorerBaseUrl, treasuryPayout?.payoutTx);
  const refundLink = buildExplorerLink(explorerBaseUrl, treasuryPayout?.refundTx);
  const verificationLink = buildExplorerLink(explorerBaseUrl, verificationTx);
  const proofLink = buildExplorerLink(explorerBaseUrl, proofTxHash);
  const reservationLink = buildExplorerLink(explorerBaseUrl, treasuryPayout?.reservationTx);
  const treasuryStatus = payoutStatus || treasuryPayout?.status || 'RESERVED';

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass-card rounded-3xl border border-white/10 bg-white/5 p-6 shadow-strong backdrop-blur-xl"
    >
      <div className="mb-4 flex items-center justify-between gap-4">
        <div>
          <p className="text-sm uppercase tracking-[0.35em] text-glowyellow">Quest</p>
          <h3 className="text-xl font-semibold text-white">{title}</h3>
        </div>
        <span className="rounded-full bg-navy/70 px-3 py-1 text-xs uppercase tracking-[0.24em] text-softyellow">
          {difficulty}
        </span>
      </div>
      <p className="mb-4 text-sm leading-6 text-slate-200">{description}</p>
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-white/80">
        <span>{reward}</span>
        {status ? <span className={`rounded-full px-3 py-1 ${statusTone(status)}`}>{status}</span> : null}
      </div>

      <div className="mt-5 rounded-3xl border border-white/10 bg-navy/70 p-4">
        <p className="text-xs uppercase tracking-[0.24em] text-softyellow">Treasury</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <span className={`rounded-full px-3 py-1 text-xs uppercase tracking-[0.2em] ${statusTone(treasuryStatus)}`}>
            {treasuryStatus}
          </span>
          {status === 'SUBMITTED' && treasuryStatus !== 'PAID' ? (
            <span className="text-xs uppercase tracking-[0.18em] text-amber-100">Payout Pending</span>
          ) : null}
          {treasuryStatus === 'PAID' ? (
            <span className="text-xs uppercase tracking-[0.18em] text-emerald-200">Payout Completed</span>
          ) : null}
        </div>
        <div className="mt-4 flex flex-wrap gap-3 text-xs uppercase tracking-[0.16em] text-slate-300">
          {reservationLink ? (
            <a href={reservationLink} target="_blank" rel="noreferrer" className="transition hover:text-glowyellow">
              Reserve Tx
            </a>
          ) : null}
          {proofLink ? (
            <a href={proofLink} target="_blank" rel="noreferrer" className="transition hover:text-glowyellow">
              Proof Tx
            </a>
          ) : null}
          {verificationLink ? (
            <a href={verificationLink} target="_blank" rel="noreferrer" className="transition hover:text-glowyellow">
              Verify Tx
            </a>
          ) : null}
          {payoutLink ? (
            <a href={payoutLink} target="_blank" rel="noreferrer" className="transition hover:text-glowyellow">
              Payout Tx
            </a>
          ) : null}
          {refundLink ? (
            <a href={refundLink} target="_blank" rel="noreferrer" className="transition hover:text-glowyellow">
              Refund Tx
            </a>
          ) : null}
        </div>
      </div>
    </motion.div>
  );
}
