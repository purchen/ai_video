import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ZodType } from 'zod';
import { ProjectStoreError } from '../domain/errors';

export interface ProjectEvent {
  id: string;
  type: string;
  occurredAt: string;
  data?: Record<string, unknown>;
}

interface PersistedProjectEvent extends ProjectEvent {
  schemaVersion: 1;
  hash: string;
}

export class ProjectStore {
  private constructor(public readonly root: string) {}

  static async create(parentDirectory: string, projectId: string): Promise<ProjectStore> {
    if (!projectId.trim() || basename(projectId) !== projectId) {
      throw new ProjectStoreError('projectId must be a non-empty directory name');
    }

    const root = join(parentDirectory, projectId);
    await mkdir(root, { recursive: true });
    return new ProjectStore(root);
  }

  async writeJson<T>(name: string, schema: ZodType<T>, value: unknown): Promise<void> {
    this.assertFileName(name);
    const validated = schema.parse(value);
    const target = join(this.root, name);
    const temporary = join(this.root, `.${name}.${randomUUID()}.tmp`);

    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
    await rename(temporary, target);
  }

  async appendEvent(event: ProjectEvent): Promise<string> {
    const eventWithoutHash = { schemaVersion: 1 as const, ...event };
    const hash = createHash('sha256').update(JSON.stringify(eventWithoutHash)).digest('hex');
    const persisted: PersistedProjectEvent = { ...eventWithoutHash, hash };

    await appendFile(join(this.root, 'events.jsonl'), `${JSON.stringify(persisted)}\n`, 'utf8');
    return hash;
  }

  async sha256(name: string): Promise<string> {
    this.assertFileName(name);
    const contents = await readFile(join(this.root, name));
    return createHash('sha256').update(contents).digest('hex');
  }

  private assertFileName(name: string): void {
    if (!name || basename(name) !== name) {
      throw new ProjectStoreError('name must be a file name within the project root');
    }
  }
}
