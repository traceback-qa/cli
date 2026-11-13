import { spawn } from 'node:child_process';

/**
 * Open a URL in the user's default browser without going through a shell.
 * Only http(s) URLs are accepted. Resolves to false when no opener could be started.
 */
export async function openUrl(rawUrl: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;

  const target = url.toString();
  let cmd: string;
  let args: string[];
  switch (process.platform) {
    case 'darwin':
      cmd = 'open';
      args = [target];
      break;
    case 'win32':
      // rundll32 takes the URL as a plain argument; `start` would need cmd.exe quoting.
      cmd = 'rundll32';
      args = ['url.dll,FileProtocolHandler', target];
      break;
    default:
      cmd = 'xdg-open';
      args = [target];
  }

  return await new Promise<boolean>((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      child.once('error', () => {
        resolve(false);
      });
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
