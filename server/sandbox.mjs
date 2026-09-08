import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const sandboxAvailable = process.platform === 'darwin';
const quote = value => JSON.stringify(value);
const subpaths = paths => [...new Set(paths)].map(p => `(subpath ${quote(p)})`).join(' ');

// Seatbelt is inherited by commands and subprocesses. No project configuration
// is consulted when constructing the policy. Only the host can expand it.
export function seatbeltProfile(root, scratch, runtimeRoots, network = false, protectedRoots = []) {
  const read = [root, scratch, ...runtimeRoots, '/System/Library', '/System/iOSSupport', '/Library/Apple', '/usr', '/bin', '/sbin', '/opt/homebrew', '/private/etc'];
  return `(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))
(allow sysctl-read)
(allow file-read-metadata file-test-existence)
(allow file-read* (literal "/"))
(allow system-mac-syscall (mac-policy-name "vnguard"))
(allow system-mac-syscall (require-all (mac-policy-name "Sandbox") (mac-syscall-number 67)))
(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.secinitd"))
(allow file-read* file-map-executable ${subpaths(read)})
(allow file-read* (literal "/dev/random") (literal "/dev/urandom"))
(allow file-read* file-write-data (literal "/dev/null") (literal "/dev/zero") (subpath "/dev/fd"))
(allow file-write* ${subpaths([root, scratch])})
(deny file-read* file-write* (regex #"/(\\.env(\\.[^/]*)?|\\.ssh|\\.workbench|\\.npmrc|auth\\.json|credentials\\.json)(/|$)"))
(deny file-write* (regex #"/(\\.git|\\.codex|\\.agents)(/|$)"))
${protectedRoots.length ? `(deny file-read* file-write* ${subpaths(protectedRoots)})` : ''}
${network ? '(allow network-outbound (remote ip "*:*"))\n(allow mach-lookup (global-name "com.apple.SystemConfiguration.configd") (global-name "com.apple.mDNSResponder") (global-name "com.apple.trustd") (global-name "com.apple.trustd.agent"))' : ''}`;
}

export async function sandboxLaunch(root, { network = false, runtimeBin, protectedRoots = [] } = {}) {
  if (!sandboxAvailable) throw new Error('此系统尚未支持项目沙箱；请逐次批准本机执行。');
  root = await fs.realpath(root);
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'boan-command-')));
  try {
    await fs.chmod(scratch, 0o700);
    const executable = await fs.realpath(process.execPath);
    const appIndex = executable.indexOf('.app/Contents/');
    const runtime = appIndex >= 0 ? executable.slice(0, appIndex + '.app/Contents'.length) : path.dirname(path.dirname(executable));
    const roots = [runtime];
    let commandBin;
    if (runtimeBin) {
      commandBin = path.join(scratch, 'bin'); await fs.mkdir(commandBin);
      // Copy only the host-created Node shim. The app data directory stays denied.
      await fs.copyFile(path.join(runtimeBin, 'node'), path.join(commandBin, 'node'));
      await fs.chmod(path.join(commandBin, 'node'), 0o700);
    }
    const executableBin = path.dirname(executable);
    const env = { PATH: [commandBin, executableBin, '/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(':'), HOME: scratch, TMPDIR: scratch, LANG: process.env.LANG || 'en_US.UTF-8' };
    return { executable: '/usr/bin/sandbox-exec', prefix: ['-p', seatbeltProfile(root, scratch, roots, network, await Promise.all(protectedRoots.filter(Boolean).map(p => fs.realpath(p).catch(() => path.resolve(p)))))], env, cleanup: () => fs.rm(scratch, { recursive: true, force: true }) };
  } catch (e) { await fs.rm(scratch, { recursive: true, force: true }); throw e; }
}
