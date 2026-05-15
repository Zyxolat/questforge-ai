import { authoritativeEventProjector } from './authoritativeEventProjector';
import { logger } from './logger';

type ReplayRangeInput = {
  fromBlock?: bigint;
  toBlock?: bigint;
  limit?: number;
};

/**
 * Legacy indexer entrypoint intentionally disabled.
 * The authoritative pipeline is:
 * blockchain -> productionEventIngestor -> BullMQ -> productionEventWorker -> authoritativeEventProjector
 */
export function startQuestIndexer() {
  logger.warn(
    '[INDEXER] Legacy indexer disabled. Use the production event pipeline and replay utilities instead.'
  );
}

export async function replayIndexedEvents(input: ReplayRangeInput = {}) {
  logger.info('[INDEXER] Replaying durable chain events through authoritative projector', {
    fromBlock: input.fromBlock?.toString() ?? null,
    toBlock: input.toBlock?.toString() ?? null,
    limit: input.limit ?? null
  });

  return authoritativeEventProjector.replayFromEventStore(input);
}

export async function recoverIndexedDeadLetters(limit = 25) {
  logger.info('[INDEXER] Recovering projector dead letters', { limit });
  return authoritativeEventProjector.recoverDeadLetters(limit);
}
