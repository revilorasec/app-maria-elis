export function renderConnectionStatus(account, folderName) {
  return account ? `${account.name || account.username} · OneDrive: ${folderName}` : 'OneDrive desconectado';
}
