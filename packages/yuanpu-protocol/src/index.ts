export const PROTOCOL_VERSION = 3;

export const RUNTIME_ROUTES = {
  health: '/v1/health',
  greeting: '/v1/greeting',
  chat: '/v1/chat',
  localSkills: '/v1/skills/local',
  plugins: '/v1/plugins',
  pluginSearch: '/v1/plugins/search',
  pluginInstall: '/v1/plugins/install',
  pluginState: '/v1/plugins/state',
  pluginUninstall: '/v1/plugins/uninstall',
  pluginConfig: '/v1/plugins/config',
  pluginConfigValidate: '/v1/plugins/config/validate',
  pluginConfigSave: '/v1/plugins/config/save',
  pluginConfigReset: '/v1/plugins/config/reset',
  pluginRollback: '/v1/plugins/rollback',
  pluginMcpConflicts: '/v1/plugins/mcp-conflicts',
  capabilityApprovals: '/v1/capabilities/approvals',
  capabilityApprovalDecision: '/v1/capabilities/approvals/decision',
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

export interface CapabilityApprovalSummary {
  requestId: string;
  sessionId: string;
  workspaceId: string;
  sourceInstanceId: string;
  capabilityId: string;
  packageVersion?: string;
  argumentsDigest: string;
  status: 'pending';
  createdAt: string;
  expiresAt: string;
}

export interface CapabilityApprovalDecisionInput {
  requestId: string;
  decision: 'approved' | 'denied';
  issuedAt: number;
  nonce: string;
  signature: string;
}

export interface CapabilityApprovalDecisionResult {
  requestId: string;
  status: 'completed' | 'denied';
  message?: string;
}

export interface McpOwnershipConflict {
  name: string;
  owners: Array<'yuanpu' | 'pi-mcp-adapter-user' | 'pi-mcp-adapter-workspace'>;
}

export function capabilityApprovalSigningPayload(
  input: Omit<CapabilityApprovalDecisionInput, 'signature'>,
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([
    'yuanpu-capability-approval-v1',
    input.requestId,
    input.decision,
    input.issuedAt,
    input.nonce,
  ]));
}

export const CAPABILITY_PACKAGE_MANIFEST_VERSION = 1;

export type CapabilityPackageKind = 'pi-extension' | 'python-mcp';

export interface CapabilityArtifactTarget {
  platform: 'darwin' | 'linux' | 'win32';
  arch: 'x64' | 'arm64';
  systemBaseline?: string;
  format: 'zip' | 'tar.gz';
  url: string;
  size: number;
  sha256: string;
  entrypoint: string;
}

export interface CapabilityPackageManifest {
  manifestVersion: typeof CAPABILITY_PACKAGE_MANIFEST_VERSION;
  kind: CapabilityPackageKind;
  id: string;
  version: string;
  capabilityContractVersion: number;
  runtimeCompatibility: { minimum: string; maximumExclusive?: string };
  artifacts: CapabilityArtifactTarget[];
  configSchema?: Record<string, unknown>;
  permissions: Array<'filesystem' | 'network' | 'credentials' | 'background'>;
  connections?: string[];
  issuedAt: string;
  signature: { algorithm: 'ed25519'; keyId: string; value: string };
}

export interface PluginSearchResult {
  id?: string;
  name: string;
  displayName?: string;
  version: string;
  description: string;
  publisher?: string;
  updatedAt?: string;
  npmUrl?: string;
  source: string;
  components?: Array<'skill' | 'agent' | 'workflow' | 'extension' | 'prompt' | 'theme' | 'connector'>;
  permissions?: Array<'instructions' | 'scripts' | 'filesystem' | 'network' | 'credentials' | 'background'>;
  artifactManifestDigest?: string;
}

export type SkillCatalogItem = PluginSearchResult;

export interface LocalSkill {
  name: string;
  description: string;
  filePath: string;
  disableModelInvocation: boolean;
}

export interface LocalSkillList {
  skills: LocalSkill[];
  diagnostics: Array<{ path: string; message: string }>;
}

export interface InstalledPlugin {
  name: string;
  version: string;
  description: string;
  source: string;
  installPath: string;
  enabled: boolean;
  installedAt: string;
  loadError?: string;
  configurable?: boolean;
  configStatus?: 'unsupported' | 'optional' | 'required' | 'valid' | 'invalid';
  kind?: 'pi-extension' | 'python-mcp';
  activeVersion?: string;
  availableVersions?: string[];
}

export type PluginConfigScope = 'user' | 'workspace';

export interface PluginConfigDocument {
  pluginName: string;
  kind: 'mcp' | 'schema';
  title: string;
  description: string;
  scope: PluginConfigScope;
  path: string;
  value: Record<string, unknown>;
  schema?: Record<string, unknown>;
  supportsWorkspace: boolean;
  secretPolicy: 'environment-only';
}

export interface PluginConfigInput {
  name: string;
  scope: PluginConfigScope;
  value: Record<string, unknown>;
}

export interface PluginConfigValidation {
  valid: boolean;
  errors: string[];
}

export interface DesktopBridge {
  runtimeInfo(): Promise<RuntimeInfo>;
  greeting(name: string): Promise<RuntimeGreeting>;
  chat(message: string): Promise<ChatResponse>;
  checkRuntimeUpdate(): Promise<RuntimeUpdateState>;
  checkDesktopUpdate(): Promise<void>;
  searchPlugins(query: string): Promise<PluginSearchResult[]>;
  listLocalSkills(): Promise<LocalSkillList>;
  listPlugins(): Promise<InstalledPlugin[]>;
  installPlugin(source: string, artifactManifestDigest?: string): Promise<InstalledPlugin>;
  setPluginEnabled(name: string, enabled: boolean): Promise<InstalledPlugin>;
  uninstallPlugin(name: string): Promise<void>;
  getPluginConfig(name: string, scope: PluginConfigScope): Promise<PluginConfigDocument>;
  validatePluginConfig(input: PluginConfigInput): Promise<PluginConfigValidation>;
  savePluginConfig(input: PluginConfigInput): Promise<PluginConfigDocument>;
  resetPluginConfig(name: string, scope: PluginConfigScope): Promise<PluginConfigDocument>;
  rollbackPlugin(name: string, version: string): Promise<InstalledPlugin>;
  listMcpOwnershipConflicts(source: string, artifactManifestDigest: string): Promise<McpOwnershipConflict[]>;
  listCapabilityApprovals(): Promise<CapabilityApprovalSummary[]>;
  decideCapabilityApproval(
    requestId: string,
    decision: CapabilityApprovalDecisionInput['decision'],
  ): Promise<CapabilityApprovalDecisionResult>;
}
