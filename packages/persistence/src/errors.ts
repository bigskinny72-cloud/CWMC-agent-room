export class RoomNotFoundError extends Error {
  constructor(code: string) {
    super(`Room ${code} not found`);
    this.name = 'RoomNotFoundError';
  }
}

export class ConcurrencyError extends Error {
  constructor() {
    super('Concurrent update — version mismatch');
    this.name = 'ConcurrencyError';
  }
}
