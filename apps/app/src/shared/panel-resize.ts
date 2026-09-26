/** One gesture stops at 70%; a fresh outward gesture can enter full screen. */
export function resizePanel(requested: number, maximum: number, startedAtLimit: boolean, stopped: boolean) {
  if (stopped) return { width: maximum, maximized: false, stopped: true };
  if (startedAtLimit && requested > maximum + 16) {
    return { width: maximum, maximized: true, stopped: false };
  }
  return {
    width: Math.round(Math.max(Math.min(260, maximum), Math.min(maximum, requested))),
    maximized: false,
    stopped: !startedAtLimit && requested >= maximum,
  };
}
