import { logger } from '../logger.js';
import { registerChannel } from './registry.js';
import { Channel } from '../types.js';

/**
 * Dashboard virtual channel — handles `dashboard:*` JIDs.
 * No network connection needed. The host already stores agent replies
 * in SQLite (src/index.ts:231-239) before calling channel.sendMessage(),
 * and the dashboard reads from the same SQLite DB.
 */
registerChannel('dashboard', () => {
  const channel: Channel = {
    name: 'dashboard',

    async connect() {
      logger.info('Dashboard channel ready');
    },

    async sendMessage(_jid: string, _text: string) {
      // No-op: the host stores the reply in SQLite before calling this.
      // The dashboard reads from the same DB via /api/messages.
    },

    isConnected() {
      return true;
    },

    ownsJid(jid: string) {
      return jid.startsWith('dashboard:');
    },

    async disconnect() {
      // No-op
    },
  };

  return channel;
});
