const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', Object.freeze({
  platform: process.platform,
  getProjects: () => ipcRenderer.invoke('desktop:get-projects'),
  selectProject: id => ipcRenderer.invoke('desktop:select-project', id),
  onProjects: handler => {
    const listener = (_event, snapshot) => handler(snapshot);
    ipcRenderer.on('desktop:projects', listener);
    return () => ipcRenderer.removeListener('desktop:projects', listener);
  },
  getModelProfiles: () => ipcRenderer.invoke('desktop:get-model-profiles'),
  saveModelProfile: input => ipcRenderer.invoke('desktop:save-model-profile', input),
  removeModelProfile: id => ipcRenderer.invoke('desktop:remove-model-profile', id),
  refreshModels: () => ipcRenderer.invoke('desktop:refresh-models'),
  getSettings: () => ipcRenderer.invoke('desktop:get-settings'),
  claudeStatus: () => ipcRenderer.invoke('desktop:claude-status'),
  claudeLogin: () => ipcRenderer.invoke('desktop:claude-login'),
  claudeCancel: () => ipcRenderer.invoke('desktop:claude-cancel'),
  claudeCode: code => ipcRenderer.invoke('desktop:claude-code', code),
  claudeLogout: () => ipcRenderer.invoke('desktop:claude-logout'),
  claudeModels: () => ipcRenderer.invoke('desktop:claude-models'),
  chatgptStatus: () => ipcRenderer.invoke('desktop:chatgpt-status'),
  chatgptLogin: storage => ipcRenderer.invoke('desktop:chatgpt-login', storage),
  chatgptCancel: () => ipcRenderer.invoke('desktop:chatgpt-cancel'),
  chatgptLogout: () => ipcRenderer.invoke('desktop:chatgpt-logout'),
  chatgptModels: () => ipcRenderer.invoke('desktop:chatgpt-models'),
  chooseProject: () => ipcRenderer.invoke('desktop:choose-project'),
  saveSettings: settings => ipcRenderer.invoke('desktop:save-settings', settings),
  savePreferences: settings => ipcRenderer.invoke('desktop:save-preferences', settings),
  revealProject: () => ipcRenderer.invoke('desktop:reveal-project'),
  revealData: () => ipcRenderer.invoke('desktop:reveal-data'),
  onCommand: handler => {
    const listener = (_event, command) => handler(command);
    ipcRenderer.on('desktop:command', listener);
    return () => ipcRenderer.removeListener('desktop:command', listener);
  },
}));
