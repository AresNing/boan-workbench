import { EventEmitter } from 'node:events';
import { projectId } from './settings.mjs';
export const runtimeId = config => config.mode === 'demo' ? 'demo' : projectId(config.projectPath);

// Each project owns its process, queue and approvals; selecting a project only changes routing.
export class ProjectRuntimes extends EventEmitter {
  entries = new Map();
  constructor({ start, stop }) { super(); this.start = start; this.stop = stop; }
  async ensure(data) {
    const id = runtimeId(data.settings);
    let entry = this.entries.get(id);
    if (entry?.starting) return entry.starting;
    if (entry?.runtime) return entry;
    entry = { ...entry, id, config: data.settings, status: 'starting', error: '', summary: entry?.summary || { tasks: [], active: 0, attention: 0, done: 0, managerBusy: false } };
    this.entries.set(id, entry); this.emit('change');
    entry.starting = (async () => {
      try {
        entry.runtime = await this.start(data, summary => { entry.summary = summary; this.emit('change'); }, error => {
          entry.runtime = null; entry.status = 'error'; entry.error = error; this.emit('change');
        });
        entry.status = 'ready'; return entry;
      } catch (e) { entry.status = 'error'; entry.error = e.message; throw e; }
      finally { entry.starting = null; this.emit('change'); }
    })();
    return entry.starting;
  }
  async stopOne(id) {
    const entry = this.entries.get(id); if (!entry) return;
    await entry.starting?.catch(() => {});
    if (entry.runtime) await this.stop(entry.runtime);
    entry.runtime = null; entry.status = 'stopped'; this.emit('change');
  }
  async close() { await Promise.all([...this.entries.keys()].map(id => this.stopOne(id))); }
}
