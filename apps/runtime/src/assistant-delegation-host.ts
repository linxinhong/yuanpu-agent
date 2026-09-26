import type { ProfessionalTaskHost } from './assistant-delegation-local.js';
import type { RuntimeAssistantSourceHost } from './assistant-source-host.js';

/** The current local grant permits explicit personal source reads only. */
export function createReadOnlyProfessionalTaskHost(sources: RuntimeAssistantSourceHost): ProfessionalTaskHost {
  return {
    async authorizeTask(brief) {
      if (!brief.readOnly || brief.authorizedCapabilities.length) {
        throw new Error('Professional execution requires a trusted user grant.');
      }
      const versions = new Map(await Promise.all(brief.contextRefs.map(async (ref) =>
        [ref, await sources.delegatedSourceVersion(ref)] as const)));
      return {
        async readSource(ref) {
          const version = versions.get(ref);
          if (!version) throw new Error('Source reference is outside this task grant.');
          return sources.readDelegatedSource(ref, version);
        },
        async executeCapability() {
          throw new Error('Professional execution requires a trusted user grant.');
        },
      };
    },
  };
}
