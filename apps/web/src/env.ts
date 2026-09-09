function optional(name: string): string {
  return (import.meta.env as Record<string, string | undefined>)[name] ?? '';
}

export const ENV = {
  upstash: {
    url: optional('VITE_UPSTASH_REDIS_REST_URL'),
    token: optional('VITE_UPSTASH_REDIS_REST_TOKEN'),
  },
};
