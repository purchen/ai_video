import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ZodType } from 'zod';
import { ProjectStoreError } from '../domain/errors';
import { persistedProjectEventSchema, projectEventSchema, type ProjectEvent } from '../domain/schemas';

export type { ProjectEvent } from '../domain/schemas';

export class ProjectStore {
  private constructor(public readonly root: string) {}

  static async create(parentDirectory: string, projectId: string): Promise<ProjectStore> {
    if (!projectId.trim() || projectId === '.' || projectId === '..' || basename(projectId) !== projectId) {
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

  async readJson<T>(name: string, schema: ZodType<T>): Promise<T> {
    this.assertFileName(name);
    const value: unknown = JSON.parse(await readFile(join(this.root, name), 'utf8'));
    return schema.parse(value);
  }

  async appendEvent(event: ProjectEvent): Promise<string> {
    const validatedEvent = projectEventSchema.parse(event);
    const eventWithoutHash = { ...validatedEvent, schemaVersion: 1 as const };
    const hash = createHash('sha256').update(JSON.stringify(eventWithoutHash)).digest('hex');
    const persisted = persistedProjectEventSchema.parse({ ...eventWithoutHash, hash });

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
