import { createReadStream } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';

import type { SkillCatalogItem } from '@yuanpu-agent/protocol';

import { catalog } from './catalog.js';

function writeJson(response: import('node:http').ServerResponse, status: number, value: unknown) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('access-control-allow-origin', '*');
  response.end(JSON.stringify(value));
}

function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

export interface CatalogServerOptions {
  artifactRoot?: string;
}

async function serveCapabilityArtifact(
  pathname: string,
  artifactRoot: string | undefined,
  response: import('node:http').ServerResponse,
): Promise<boolean> {
  const match = pathname.match(/^\/v1\/capability-packages\/([^/]+)\/(manifest|artifacts\/([^/]+))$/);
  if (!match) return false;
  const packageId = safeDecode(match[1]!);
  if (packageId === undefined || (match[3] && safeDecode(match[3]) === undefined)) {
    writeJson(response, 400, { error: 'Malformed capability artifact path' });
    return true;
  }
  if (!artifactRoot || packageId !== 'builtin.python.echo') {
    writeJson(response, 404, { error: 'Capability artifact not published' });
    return true;
  }
  const filename = match[2] === 'manifest' ? 'manifest.json' : safeDecode(match[3]!)!;
  if (basename(filename) !== filename) {
    writeJson(response, 400, { error: 'Invalid artifact filename' });
    return true;
  }
  const path = resolve(artifactRoot, filename);
  try {
    await access(path);
    if (filename === 'manifest.json') {
      const manifest = JSON.parse(await readFile(path, 'utf8')) as { id?: unknown };
      if (manifest.id !== 'builtin.python.echo') throw new Error('Published manifest id mismatch.');
      writeJson(response, 200, manifest);
      return true;
    }
    if (!/^YuanpuEchoMcp-(?:darwin|linux|win32)-(?:arm64|x64)\.tar\.gz$/.test(filename)) {
      writeJson(response, 404, { error: 'Artifact filename is outside the published capability layout' });
      return true;
    }
    const manifest = JSON.parse(await readFile(resolve(artifactRoot, 'manifest.json'), 'utf8')) as {
      artifacts?: Array<{ url?: unknown }>;
    };
    const allowedFiles = new Set((manifest.artifacts ?? []).flatMap((artifact) => {
      if (typeof artifact.url !== 'string') return [];
      try {
        const url = new URL(artifact.url, 'https://manifest.invalid/');
        const allowed = safeDecode(basename(url.pathname));
        return allowed ? [allowed] : [];
      } catch {
        return [];
      }
    }));
    if (!allowedFiles.has(filename)) {
      writeJson(response, 404, { error: 'Artifact is not referenced by the signed manifest' });
      return true;
    }
    const metadata = await stat(path);
    response.statusCode = 200;
    response.setHeader('content-type', 'application/gzip');
    response.setHeader('content-length', metadata.size);
    response.setHeader('cache-control', 'public, max-age=31536000, immutable');
    createReadStream(path).pipe(response);
  } catch (error) {
    writeJson(response, 404, { error: error instanceof Error ? error.message : 'Artifact not found' });
  }
  return true;
}

export function createCatalogServer(
  items: SkillCatalogItem[] = catalog,
  options: CatalogServerOptions = {},
): Server {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/v1/health') {
      writeJson(response, 200, { status: 'ok', schemaVersion: 1, items: items.length });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/catalog/search') {
      const query = (url.searchParams.get('q') ?? '').trim().toLocaleLowerCase();
      const matches = items.filter((item) => !query || [
        item.id,
        item.name,
        item.displayName,
        item.description,
        item.publisher,
        ...(item.components ?? []),
      ].some((value) => value?.toLocaleLowerCase().includes(query)));
      writeJson(response, 200, { schemaVersion: 1, items: matches });
      return;
    }
    if (request.method === 'GET' && await serveCapabilityArtifact(url.pathname, options.artifactRoot, response)) {
      return;
    }
    const match = request.method === 'GET' && url.pathname.match(/^\/v1\/catalog\/items\/([^/]+)$/);
    if (match) {
      const id = safeDecode(match[1]!);
      if (id === undefined) {
        writeJson(response, 400, { error: 'Malformed catalog item id' });
        return;
      }
      const item = items.find((candidate) => candidate.id === id);
      writeJson(response, item ? 200 : 404, item ?? { error: 'Skill not found' });
      return;
    }
    writeJson(response, 404, { error: 'Not found' });
  });
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) {
  const portIndex = process.argv.indexOf('--port');
  const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 8787;
  const artifactRoot = process.env.YUANPU_ARTIFACT_ROOT
    ? resolve(process.env.YUANPU_ARTIFACT_ROOT)
    : undefined;
  const server = createCatalogServer(catalog, { artifactRoot });
  server.listen(port, '127.0.0.1', () => {
    console.log(`YuanpuAgent catalog server listening on http://127.0.0.1:${port}`);
  });
}
