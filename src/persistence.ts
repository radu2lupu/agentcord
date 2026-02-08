import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DATA_DIR = join(process.cwd(), '.discord-friends');

export class Store<T> {
  private filePath: string;

  constructor(filename: string) {
    this.filePath = join(DATA_DIR, filename);
  }

  async read(): Promise<T | null> {
    try {
      const data = await readFile(this.filePath, 'utf-8');
      return JSON.parse(data) as T;
    } catch {
      return null;
    }
  }

  async write(data: T): Promise<void> {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    const tmpPath = this.filePath + '.tmp';
    await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    await rename(tmpPath, this.filePath);
  }
}
