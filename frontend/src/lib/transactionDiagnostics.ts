import { ethers } from 'ethers';

export type TransactionFailureKind =
  | 'user_rejected'
  | 'insufficient_funds'
  | 'contract_revert'
  | 'rpc_error'
  | 'validation_error'
  | 'unknown';

export type TransactionFailure = {
  kind: TransactionFailureKind;
  message: string;
  details: string[];
};

function collectMessages(error: unknown, seen = new Set<unknown>(), output: string[] = []) {
  if (!error || seen.has(error)) {
    return output;
  }

  if (typeof error === 'string') {
    output.push(error);
    return output;
  }

  if (typeof error !== 'object') {
    output.push(String(error));
    return output;
  }

  seen.add(error);
  const record = error as Record<string, unknown>;

  ['shortMessage', 'reason', 'message', 'details', 'body'].forEach((key) => {
    if (typeof record[key] === 'string') {
      output.push(record[key] as string);
    }
  });

  if (typeof record.body === 'string') {
    try {
      const parsed = JSON.parse(record.body);
      collectMessages(parsed, seen, output);
    } catch {
      // Keep the raw body string only.
    }
  }

  if (record.cause && typeof record.cause === 'object') {
    collectMessages(record.cause, seen, output);
  }

  if (record.info && typeof record.info === 'object') {
    collectMessages(record.info, seen, output);
  }

  if (record.error && typeof record.error === 'object') {
    collectMessages(record.error, seen, output);
  }

  if (record.data && typeof record.data === 'object') {
    collectMessages(record.data, seen, output);
  }

  if (record.originalError && typeof record.originalError === 'object') {
    collectMessages(record.originalError, seen, output);
  }

  if (Array.isArray(record.errors)) {
    record.errors.forEach((value) => collectMessages(value, seen, output));
  }

  return output;
}

function collectCodes(error: unknown, seen = new Set<unknown>(), output: string[] = []) {
  if (!error || seen.has(error) || typeof error !== 'object') {
    return output;
  }

  seen.add(error);
  const record = error as Record<string, unknown>;

  if (record.code !== undefined) {
    output.push(String(record.code));
  }

  ['cause', 'info', 'error', 'data', 'originalError'].forEach((key) => {
    if (record[key] && typeof record[key] === 'object') {
      collectCodes(record[key], seen, output);
    }
  });

  if (Array.isArray(record.errors)) {
    record.errors.forEach((value) => collectCodes(value, seen, output));
  }

  return output;
}

function uniqueMessages(messages: string[]) {
  return [...new Set(messages.map((message) => message.trim()).filter(Boolean))];
}

function stripRevertPrefix(message: string) {
  return message
    .replace(/^execution reverted(?::\s*)?/i, '')
    .replace(/^missing revert data\s*/i, '')
    .trim();
}

export function formatCeloAmount(value: bigint, digits = 4) {
  return Number(ethers.formatEther(value)).toFixed(digits);
}

export function describeTransactionFailure(error: unknown): TransactionFailure {
  const rawMessages = uniqueMessages(collectMessages(error));
  const haystack = rawMessages.join(' | ').toLowerCase();
  const codes = [...new Set(collectCodes(error))];
  const details = [...codes.map((code) => `code=${code}`), ...rawMessages];
  const primaryCode = codes[0] || '';

  if (codes.includes('4001') || codes.includes('ACTION_REJECTED') || haystack.includes('user rejected')) {
    return {
      kind: 'user_rejected',
      message: 'Transaction was rejected in your wallet.',
      details
    };
  }

  if (
    codes.includes('INSUFFICIENT_FUNDS') ||
    haystack.includes('insufficient funds') ||
    haystack.includes('gas * price + value')
  ) {
    return {
      kind: 'insufficient_funds',
      message: 'Wallet balance is too low for the required transaction value plus network gas.',
      details
    };
  }

  const revertMessage = rawMessages.find((message) =>
    /revert|quest not|incorrect|paused|role|required|player mismatch|reward mismatch|stake mismatch|expired/i.test(message)
  );
  if (codes.includes('CALL_EXCEPTION') || revertMessage || haystack.includes('missing revert data')) {
    return {
      kind: 'contract_revert',
      message: revertMessage ? stripRevertPrefix(revertMessage) || 'Contract call reverted.' : 'Contract call reverted during simulation.',
      details
    };
  }

  if (
    haystack.includes('network') ||
    haystack.includes('rpc') ||
    haystack.includes('timeout') ||
    haystack.includes('failed to fetch') ||
    haystack.includes('internal json-rpc error') ||
    haystack.includes('header not found') ||
    primaryCode === '-32603'
  ) {
    return {
      kind: 'rpc_error',
      message: 'RPC or wallet provider failed while preparing the transaction.',
      details
    };
  }

  if (
    haystack.includes('wrong network') ||
    haystack.includes('wrong chain') ||
    haystack.includes('chain mismatch') ||
    haystack.includes('unsupported network') ||
    haystack.includes('invalid') ||
    haystack.includes('missing') ||
    haystack.includes('unsupported')
  ) {
    return {
      kind: 'validation_error',
      message: rawMessages[0] || 'Transaction request was invalid.',
      details
    };
  }

  return {
    kind: 'unknown',
    message: rawMessages[0] || 'Transaction failed for an unknown reason.',
    details
  };
}
