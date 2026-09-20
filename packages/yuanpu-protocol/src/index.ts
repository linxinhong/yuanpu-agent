export const PROTOCOL_VERSION = 1;

export const RUNTIME_ROUTES = {
  health: '/v1/health',
  greeting: '/v1/greeting',
} as const;

export interface RuntimeInfo {
  version: string;
  protocolVersion: number;
  piVersion: string;
  mcpTools: readonly string[];
}

export interface RuntimeGreeting {
  message: string;
}

export interface RuntimeUpdateState {
  status: 'idle' | 'checking' | 'current' | 'ready' | 'error';
  currentVersion?: string;
  availableVersion?: string;
  message?: string;
}

export interface DesktopBridge {
  runtimeInfo(): Promise<RuntimeInfo>;
  greeting(name: string): Promise<RuntimeGreeting>;
  checkRuntimeUpdate(): Promise<RuntimeUpdateState>;
  checkDesktopUpdate(): Promise<void>;
}
