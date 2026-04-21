/**
 * Dashboard channel adapter (v2).
 *
 * Dashboard is a first-class v2 channel for outbound delivery, but its inbound
 * browser chat arrives through the host's localhost-only dashboard ingress.
 * That keeps routing in the NanoClaw host process even though the dashboard
 * web server runs as a separate process.
 */
import { registerChannelAdapter } from './channel-registry.js';
import type { ChannelSetup, OutboundMessage } from './adapter.js';
import { log } from '../log.js';

registerChannelAdapter('dashboard', {
  factory: () => ({
    name: 'dashboard',
    channelType: 'dashboard',
    supportsThreads: false,

    async setup(_config: ChannelSetup): Promise<void> {
      log.info('Dashboard channel adapter ready');
    },

    async teardown(): Promise<void> {
      // no-op
    },

    isConnected(): boolean {
      return true;
    },

    async deliver(
      _platformId: string,
      _threadId: string | null,
      _message: OutboundMessage,
    ): Promise<string | undefined> {
      // Dashboard server reads responses from session outbound DBs via
      // /api/messages and SSE. Return a message ID so delivery marks it done.
      return `dash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    },
  }),
});
