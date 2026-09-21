import type { SkillCatalogItem } from '@yuanpu-agent/protocol';

export const catalog: SkillCatalogItem[] = [
  {
    id: 'works.earendil.dynamic-workflows',
    name: '@quintinshaw/pi-dynamic-workflows',
    displayName: '工作流编排',
    version: '3.12.0',
    description: '组合专家角色与多步骤工作流，自动拆解和执行复杂任务。',
    publisher: 'quintinshaw',
    source: 'npm:@quintinshaw/pi-dynamic-workflows@3.12.0',
    components: ['agent', 'workflow', 'extension'],
    permissions: ['scripts', 'filesystem', 'background'],
  },
  {
    id: 'community.hermes-memory',
    name: 'pi-hermes-memory',
    displayName: '长期记忆',
    version: '0.9.9',
    description: '为对话提供跨会话的长期记忆、知识沉淀和检索能力。',
    publisher: 'community',
    source: 'npm:pi-hermes-memory@0.9.9',
    components: ['skill', 'extension'],
    permissions: ['filesystem', 'background'],
  },
  {
    id: 'community.mcp-service-connection',
    name: 'pi-mcp-adapter',
    displayName: 'MCP 服务连接',
    version: '2.34.0',
    description: '连接外部 MCP 服务，为 YuanpuAgent 增加工具和数据源。',
    publisher: 'community',
    source: 'npm:pi-mcp-adapter@2.34.0',
    components: ['connector', 'extension'],
    permissions: ['network', 'credentials', 'background'],
  },
];
