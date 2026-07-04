export function detectShell(): string {
  if (process.env.SHELL) {
    const shell = process.env.SHELL.split('/').pop();
    if (shell) return shell;
  }
  if (process.platform === 'win32') {
    return process.env.PSModulePath ? 'powershell' : 'cmd';
  }
  return 'bash';
}

export function getCompletionFormat(shell: string): 'bash' | 'zsh' | 'fish' | 'powershell' {
  if (shell === 'powershell' || shell === 'pwsh') return 'powershell';
  if (shell === 'fish') return 'fish';
  if (shell === 'zsh') return 'zsh';
  return 'bash';
}

export function getRcFilePath(shell: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '~';
  switch (shell) {
    case 'zsh':
      return `${home}/.zshrc`;
    case 'bash':
      return `${home}/.bashrc`;
    case 'fish':
      return `${home}/.config/fish/config.fish`;
    case 'powershell':
    case 'pwsh':
      return `${home}/Documents/WindowsPowerShell/Microsoft.PowerShell_profile.ps1`;
    default:
      return `${home}/.bashrc`;
  }
}
