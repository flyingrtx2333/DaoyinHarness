const MAX_TIMER_DELAY = 2_147_483_647;

/** Browser timers overflow after ~24.8 days; only expire at the actual deadline. */
export function scheduleExpiry(expiresAt: number, onExpire: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = (): void => {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) { onExpire(); return; }
    timer = setTimeout(check, Math.min(remaining, MAX_TIMER_DELAY));
  };
  check();
  return () => clearTimeout(timer);
}
