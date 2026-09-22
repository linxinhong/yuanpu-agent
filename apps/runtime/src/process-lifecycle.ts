export interface ParentProcessMonitorOptions {
  intervalMs?: number;
  getParentPid?: () => number;
  probeProcess?: (pid: number) => void;
}

export interface ParentProcessMonitor {
  dispose(): void;
}

export function installParentProcessMonitor(
  expectedParentPid: number,
  onParentExit: () => void,
  options: ParentProcessMonitorOptions = {},
): ParentProcessMonitor {
  if (!Number.isSafeInteger(expectedParentPid) || expectedParentPid <= 1) {
    throw new Error('Runtime parentPid must identify a live desktop process.');
  }
  const getParentPid = options.getParentPid ?? (() => process.ppid);
  const probeProcess = options.probeProcess ?? ((pid: number) => process.kill(pid, 0));
  if (getParentPid() !== expectedParentPid) {
    throw new Error('Runtime bootstrap parentPid does not match the spawning process.');
  }

  let disposed = false;
  const inspect = () => {
    if (disposed) return;
    try {
      if (getParentPid() !== expectedParentPid) throw new Error('Runtime parent changed.');
      probeProcess(expectedParentPid);
    } catch {
      disposed = true;
      clearInterval(timer);
      onParentExit();
    }
  };
  const timer = setInterval(inspect, options.intervalMs ?? 500);
  timer.unref();
  return {
    dispose() {
      disposed = true;
      clearInterval(timer);
    },
  };
}
