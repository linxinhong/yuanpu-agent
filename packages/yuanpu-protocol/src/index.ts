export const PROTOCOL_VERSION = 1;

export const RUNTIME_ROUTES = {
  health: '/v1/health',
  greeting: '/v1/greeting',
  chat: '/v1/chat',
} as const;

export interface RuntimeInfo {
  version: string;
  protocolVersion: number;
  piVersion: string;
  mcpTools: readonly string[];
  configRoot: string;
}

export interface RuntimeGreeting {
  message: string;
}

export interface ChatToolEvent {
  name: string;
  status: 'started' | 'completed' | 'failed';
}

export interface ChatResponse {
  message: string;
  tools: ChatToolEvent[];
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
  chat(message: string): Promise<ChatResponse>;
  checkRuntimeUpdate(): Promise<RuntimeUpdateState>;
  checkDesktopUpdate(): Promise<void>;
}
