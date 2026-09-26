# Yuanpu Sandbox

This package is a standalone execution boundary for local Agent tools. It is **not yet connected** to Pi or the Yuanpu Runtime.

## Current contract

- macOS: launches a child process through `/usr/bin/sandbox-exec` with a Seatbelt profile. The profile permits writes to paths under the canonical workspace directory and denies direct network access. File reads remain at host scope so normal toolchains can start. Treat files and secrets outside the workspace as readable. Existing hard-linked files are rejected before a command starts because writing them could change an external path.
- Windows: launches the published `@deepseek-ai/dsh-sandbox-windows-acl` runner under Node. Its `WRITE_RESTRICTED` token and workspace ACL grant provide **partial write restriction**. Network remains at host scope, and a private temp directory outside the workspace is writable during each run. Windows execution therefore requires a policy created with `{ network: 'host', privateTempWrites: 'allow' }`. The temp directory is removed afterward. Runner setup failures are errors, never an ordinary unsandboxed process.
- Other platforms, a missing backend, or a policy the backend cannot enforce: execution fails closed. There is no unsandboxed fallback.
- The child has bounded output and time. On macOS, the process group is killed on abort or limit violations. On Windows, the runner's job object is expected to end descendants when the runner is terminated; this path awaits Windows verification.

```ts
import { createSandboxPolicy, runSandboxed } from '@yuanpu-agent/sandbox';

const policy = await createSandboxPolicy('/path/to/workspace');
const result = await runSandboxed(policy, {
  command: '/bin/sh',
  args: ['-c', 'printf hello > result.txt'],
});

// Windows requires explicit acknowledgement of network and private temp access:
const windowsPolicy = await createSandboxPolicy('C:\\work\\project', {
  network: 'host', privateTempWrites: 'allow',
});
await runSandboxed(windowsPolicy, { command: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'dir'] });
```

`SandboxPolicy` is created from a real directory and cannot grant a larger write or network scope through the public API. The result contains the exit code, signal, stdout, and stderr. A denied operation usually appears as a nonzero command exit; startup, timeout, output limit, and abort failures throw `SandboxExecutionError`.

## Limits and integration work

Seatbelt is a macOS mechanism and `sandbox-exec` is deprecated by Apple. Availability and behavior must be checked on each supported macOS release. This first version restricts direct filesystem writes and direct socket access on macOS; it does not isolate file reads, Mach service IPC, or arbitrary code already running in the parent process. The hard-link scan is a preflight check, not a defense against a trusted host process changing workspace contents while the sandbox runs. It is not a complete data exfiltration boundary.

The Windows backend is **not tested on Windows yet**. Its restricted token does not confine reads or network sockets, and the underlying backend documents residual write access on objects granted to Everyone. It also leaves a standing workspace ACE for reuse. Windows execution needs a separately invocable Node binary and the native `koffi` dependency in the packaged application; a Node SEA executable cannot simply be substituted as the JavaScript runner. These packaging requirements remain for Runtime integration.

Runtime integration must replace or wrap **all** Pi local execution paths (`bash`, file tools, subprocesses, trusted extensions) before presenting the sandbox as active. A Linux implementation needs a separately tested OS backend (for example bubblewrap with a network namespace). The package deliberately does not import or modify Pi upstream packages.
