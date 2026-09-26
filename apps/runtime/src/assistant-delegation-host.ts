import type { ProfessionalTaskHost } from './assistant-delegation-local.js';
import type { RuntimeAssistantSourceHost } from './assistant-source-host.js';

/** The current local grant permits explicit personal source reads only. */
export function createReadOnlyProfessionalTaskHost(sources: RuntimeAssistantSourceHost): ProfessionalTaskHost {
  return {
    async authorizeTask(brief) {
      if (!brief.readOnly || brief.authorizedCapabilities.length) {
        throw new Error('Professional execution requires a trusted user grant.');
      }
      const refs = new Set(brief.contextRefs);
      return {
        async readSource(ref) {
          if (!refs.has(ref)) throw new Error('Source reference is outside this task grant.');
          return sources.readDelegatedSource(ref);
        },
        async executeCapability() {
          throw new Error('Professional execution requires a trusted user grant.');
        },
      };
    },
  };
}
