/**
 * Extract a clean error message string from an unknown thrown value.
 * Use in catch blocks: `catch (err: unknown) { toErrorMessage(err); }`
 */
export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
  try { return JSON.stringify(err); } catch { return String(err); }
}
