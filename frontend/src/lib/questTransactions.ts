import { ethers } from 'ethers';

type ReceiptEventParser = {
  contractAddress?: string;
  contractInterface: ethers.Interface;
};

export type ReceiptLogSummary = {
  address: string;
  index: number;
  topic0: string | null;
  parsedEventName: string | null;
};

function normalizeAddress(address: string | null | undefined) {
  return address?.toLowerCase() ?? null;
}

export function summarizeReceiptLogs(
  receipt: ethers.TransactionReceipt | null | undefined,
  parser: ReceiptEventParser
): ReceiptLogSummary[] {
  if (!receipt) {
    return [];
  }

  const expectedAddress = normalizeAddress(parser.contractAddress);

  return receipt.logs.map((log, index) => {
    const sameAddress = !expectedAddress || normalizeAddress(log.address) === expectedAddress;

    if (!sameAddress) {
      return {
        address: log.address,
        index,
        topic0: log.topics[0] ?? null,
        parsedEventName: null
      };
    }

    try {
      const parsed = parser.contractInterface.parseLog(log);
      return {
        address: log.address,
        index,
        topic0: log.topics[0] ?? null,
        parsedEventName: parsed?.name ?? null
      };
    } catch {
      return {
        address: log.address,
        index,
        topic0: log.topics[0] ?? null,
        parsedEventName: null
      };
    }
  });
}

export function parseReceiptEvent(
  receipt: ethers.TransactionReceipt | null | undefined,
  parser: ReceiptEventParser,
  eventName: string
) {
  if (!receipt) {
    return null;
  }

  const expectedAddress = normalizeAddress(parser.contractAddress);

  for (const log of receipt.logs) {
    if (expectedAddress && normalizeAddress(log.address) !== expectedAddress) {
      continue;
    }

    try {
      const parsed = parser.contractInterface.parseLog(log);
      if (parsed?.name === eventName) {
        return parsed;
      }
    } catch {
      // Ignore logs for other contracts or unknown topics.
    }
  }

  return null;
}
