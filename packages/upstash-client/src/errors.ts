export {
  RoomNotFoundError,
  ConcurrencyError,
} from '@agent-room/persistence';

export class UpstashError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'UpstashError';
  }
}

export class NetworkError extends UpstashError {
  constructor(cause?: unknown) {
    super('Network failure', cause);
    this.name = 'NetworkError';
  }
}

export class RateLimitError extends UpstashError {
  constructor() {
    super('Upstash rate limited');
    this.name = 'RateLimitError';
  }
}
