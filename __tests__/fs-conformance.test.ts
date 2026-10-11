import * as nodeFs from 'fs/promises';
import * as nodePath from 'path';
import * as os from 'os';
import { IFileSystem } from '../src/types';
import { MemoryFileSystem } from './memory-fs';

/**
 * IFileSystem 契约测试套件。
 *
 * 任何要接入本项目的文件系统后端（Node fs / @zenfs/core / zen-fs-webdav /
 * 自定义适配器）都应通过这套测试。它固化了项目对 IFileSystem 的硬性要求，
 * 尤其是「文件大小必须能从 stat().size 取到」——这是合并分批逻辑的前提，
 * 曾经因为 mock 实现了非标准的 size() 方法而掩盖了真实后端取不到大小的 bug。
 *
 * 用法：把你的 fs 实例 + 一个用于隔离测试的根路径传进来即可。
 *   runFSConformanceSuite('my-fs', () => createMyFS());
 * 工厂函数返回 { fs, root }：fs 是待测的 IFileSystem，root 是测试用根目录
 * （测试会在其下创建临时文件，结束后自行清理）。
 */
export function runFSConformanceSuite(
  name: string,
  createFS: () => Promise<{ fs: IFileSystem; root: string }>,
  cleanup?: (root: string) => Promise<void>,
): void {
  describe(`IFileSystem 契约: ${name}`, () => {
    let fs: IFileSystem;
    let root: string;

    beforeAll(async () => {
      const ctx = await createFS();
      fs = ctx.fs;
      root = ctx.root;
    });

    afterAll(async () => {
      if (cleanup) await cleanup(root);
    });

    it('writeFile + readFile 能往返还原内容', async () => {
      const p = `${root}/roundtrip.txt`;
      const content = 'hello 通用同步';
      await fs.writeFile(p, content);
      const read = await fs.readFile(p, 'utf8');
      expect(read).toBe(content);
    });

    it('stat(文件) 返回 isFile=true / isDirectory=false，且 size = 内容字节数', async () => {
      // ★ 这一条是合并分批逻辑的硬性前提 ★
      // 合并候选分批靠 fileSizeOf -> stat().size 决定每批大小，若此处取不到
      // 真实大小，则 maxFileSize 上限形同虚设，merged 文件会无限大。
      const content = 'x'.repeat(1234);
      const p = `${root}/sized.txt`;
      await fs.writeFile(p, content);
      const stats = await fs.stat(p);
      expect(stats.isFile()).toBe(true);
      expect(stats.isDirectory()).toBe(false);
      expect(typeof stats.size).toBe('number');
      expect(stats.size).toBe(Buffer.byteLength(content, 'utf8'));
    });

    it('stat(目录) 返回 isDirectory=true', async () => {
      const p = `${root}/a-dir`;
      await fs.mkdir(p, { recursive: true });
      const stats = await fs.stat(p);
      expect(stats.isDirectory()).toBe(true);
      expect(stats.isFile()).toBe(false);
    });

    it('mkdir {recursive:true} 能创建多层嵌套目录', async () => {
      const p = `${root}/nested/deep/path`;
      await fs.mkdir(p, { recursive: true });
      expect(await fs.exists(p)).toBe(true);
    });

    it('readdir 能列出目录下的直接子条目', async () => {
      const dir = `${root}/listdir`;
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(`${dir}/a.txt`, 'a');
      await fs.writeFile(`${dir}/b.txt`, 'b');
      const entries = await fs.readdir(dir);
      expect(entries).toContain('a.txt');
      expect(entries).toContain('b.txt');
    });

    it('exists 对存在的路径返回 true，对不存在的返回 false', async () => {
      const p = `${root}/exists.txt`;
      await fs.writeFile(p, 'x');
      expect(await fs.exists(p)).toBe(true);
      expect(await fs.exists(`${root}/no-such-file`)).toBe(false);
    });

    it('unlink 能删除文件', async () => {
      const p = `${root}/todelete.txt`;
      await fs.writeFile(p, 'x');
      expect(await fs.exists(p)).toBe(true);
      await fs.unlink(p);
      expect(await fs.exists(p)).toBe(false);
    });

    it('rename 能移动文件并保留内容', async () => {
      const src = `${root}/rename-src.txt`;
      const dest = `${root}/rename-dest.txt`;
      await fs.writeFile(src, 'move-me');
      await fs.rename(src, dest);
      expect(await fs.exists(src)).toBe(false);
      expect(await fs.exists(dest)).toBe(true);
      expect(await fs.readFile(dest, 'utf8')).toBe('move-me');
    });
  });
}

// ============ 用 MemoryFileSystem（项目自带 mock）跑契约 ============
runFSConformanceSuite('MemoryFileSystem', async () => {
  const fs = new MemoryFileSystem();
  await fs.mkdir('/contract-test', { recursive: true });
  return { fs, root: '/contract-test' };
});

// ============ 用真实 Node fs.promises 跑契约 ============
// 这一条是关键：证明契约对真实后端成立，而不是只对 mock 成立。
// 曾经的 bug 正是因为只有 mock 跑过、没拿真实 fs 验证，导致 fs.size()
// 这个"只在 mock 里存在"的方法蒙混过关。
runFSConformanceSuite(
  'Node fs.promises (真实后端)',
  async () => {
    const root = nodePath.join(os.tmpdir(), `usync-contract-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await nodeFs.mkdir(root, { recursive: true });
    // 把 Node fs.promises 包成 IFileSystem（与 docs/api.md 的 Node 示例一致）
    const fs: IFileSystem = {
      readFile: (p, enc) => nodeFs.readFile(p, enc as BufferEncoding) as unknown as Promise<string>,
      writeFile: (p, data) => nodeFs.writeFile(p, data),
      readdir: (p) => nodeFs.readdir(p) as unknown as Promise<string[]>,
      mkdir: (p, opts) => nodeFs.mkdir(p, opts) as unknown as Promise<void>,
      stat: async (p) => {
        const s = await nodeFs.stat(p);
        return {
          isFile: () => s.isFile(),
          isDirectory: () => s.isDirectory(),
          mtime: s.mtime,
          size: s.size,
        };
      },
      unlink: (p) => nodeFs.unlink(p),
      rename: (o, n) => nodeFs.rename(o, n),
      exists: async (p) => {
        try {
          await nodeFs.access(p);
          return true;
        } catch {
          return false;
        }
      },
    };
    return { fs, root };
  },
  async (root) => {
    await nodeFs.rm(root, { recursive: true, force: true }).catch(() => {});
  },
);
