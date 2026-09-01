import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir as nodeMkdir,
  readFile as nodeReadFile,
  readdir as nodeReaddir,
  rename as nodeRename,
  rm as nodeRm,
  writeFile as nodeWriteFile,
} from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { ProjectStore } from '../store/project-store';

export interface VoiceArtifactIo {
  mkdir(path: string): Promise<void>;
  readFile(path: string): Promise<Buffer>;
  readdir(path: string): Promise<string[]>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string): Promise<void>;
}

export const nodeVoiceArtifactIo: VoiceArtifactIo = {
  mkdir: async (path) => { await nodeMkdir(path, { recursive: true }); },
  readFile: async (path) => nodeReadFile(path),
  readdir: async (path) => nodeReaddir(path),
  writeFile: async (path, data) => { await nodeWriteFile(path, data); },
  rename: async (from, to) => { await nodeRename(from, to); },
  rm: async (path) => { await nodeRm(path, { force: true, recursive: true }); },
};

export function voiceRoot(store: ProjectStore): string {
  return boundedPath(store, 'voice');
}

export function voicePath(store: ProjectStore, ...segments: string[]): string {
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\')) {
      throw new Error('voice artifact path segment is invalid');
    }
  }
  return boundedPath(store, 'voice', ...segments);
}

export async function writeJson(
  io: VoiceArtifactIo,
  path: string,
  value: unknown,
): Promise<void> {
  await io.writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeMarkerAtomically(
  io: VoiceArtifactIo,
  directory: string,
  markerPath: string,
  marker: unknown,
): Promise<void> {
  const temporary = join(directory, `.marker.${randomUUID()}.tmp`);
  await writeJson(io, temporary, marker);
  try {
    await io.rename(temporary, markerPath);
  } finally {
    await io.rm(temporary).catch(() => undefined);
  }
}

export async function readJson(io: VoiceArtifactIo, path: string): Promise<unknown> {
  return JSON.parse((await io.readFile(path)).toString('utf8')) as unknown;
}

export async function sha256File(io: VoiceArtifactIo, path: string): Promise<string> {
  return sha256Bytes(await io.readFile(path));
}

export function sha256Text(text: string): string {
  return sha256Bytes(Buffer.from(text, 'utf8'));
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function boundedPath(store: ProjectStore, ...segments: string[]): string {
  const target = join(store.root, ...segments);
  const fromRoot = relative(store.root, target);
  if (!fromRoot || fromRoot.startsWith('..')) {
    throw new Error('voice artifact path must remain within the project root');
  }
  return target;
}
