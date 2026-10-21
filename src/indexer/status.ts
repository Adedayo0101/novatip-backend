export interface IndexerPollStatus {
  lastSuccessfulPollAt: string | null;
  lastError: string | null;
}

let lastSuccessfulPollAt: string | null = null;
let lastError: string | null = null;

export function recordSuccessfulPoll(): void {
  lastSuccessfulPollAt = new Date().toISOString();
  lastError = null;
}

export function recordPollError(error: unknown): void {
  lastError = error instanceof Error ? error.message : String(error);
}

export function getIndexerPollStatus(): IndexerPollStatus {
  return { lastSuccessfulPollAt, lastError };
}
