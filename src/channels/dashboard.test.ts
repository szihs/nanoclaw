/**
 * The dashboard channel adapter is a first-class v2 outbound channel whose
 * "delivery" is actually passive: the dashboard web server reads session
 * outbound DBs directly via /api/messages and SSE. The adapter's only job is
 * to register under the 'dashboard' channel type and return a synthetic
 * message id so the delivery loop can mark the message delivered.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ChannelSetup, OutboundMessage } from './adapter.js';

describe('dashboard channel adapter', () => {
  beforeEach(async () => {
    // Fresh module state per test — the registry mutates a module-level Map.
    const vi = await import('vitest');
    vi.vi.resetModules();
  });

  afterEach(async () => {
    const { teardownChannelAdapters } = await import('./channel-registry.js');
    await teardownChannelAdapters();
  });

  it('self-registers under the "dashboard" channel name on import', async () => {
    await import('./dashboard.js');
    const { getRegisteredChannelNames } = await import('./channel-registry.js');
    expect(getRegisteredChannelNames()).toContain('dashboard');
  });

  it('advertises channelType=dashboard and supportsThreads=false', async () => {
    const { registerChannelAdapter } = await import('./channel-registry.js');
    // Re-import the adapter module so the side-effect register runs against
    // the freshly reset registry.
    await import('./dashboard.js');

    // Can't grab the adapter before initChannelAdapters; so we look at the
    // registration by exercising the factory directly via registerChannelAdapter.
    // Easier: invoke initChannelAdapters with a no-op setup, then fetch.
    const { initChannelAdapters, getChannelAdapter } = await import('./channel-registry.js');
    await initChannelAdapters(noopSetup);

    const adapter = getChannelAdapter('dashboard');
    expect(adapter).toBeDefined();
    expect(adapter!.channelType).toBe('dashboard');
    expect(adapter!.supportsThreads).toBe(false);
    expect(adapter!.isConnected()).toBe(true);

    // Silence unused-import warning.
    void registerChannelAdapter;
  });

  it('returns a synthetic `dash-<timestamp>-<random>` message id on deliver', async () => {
    await import('./dashboard.js');
    const { initChannelAdapters, getChannelAdapter } = await import('./channel-registry.js');
    await initChannelAdapters(noopSetup);

    const adapter = getChannelAdapter('dashboard')!;
    const msg: OutboundMessage = { kind: 'chat', content: { text: 'hi' } };

    const id = await adapter.deliver('plat-1', null, msg);
    expect(id).toMatch(/^dash-\d+-[a-z0-9]+$/);
  });

  it('produces a unique id per deliver call', async () => {
    await import('./dashboard.js');
    const { initChannelAdapters, getChannelAdapter } = await import('./channel-registry.js');
    await initChannelAdapters(noopSetup);

    const adapter = getChannelAdapter('dashboard')!;
    const ids = await Promise.all(
      Array.from({ length: 50 }, () => adapter.deliver('plat-1', null, { kind: 'chat', content: {} })),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('teardown is a no-op and does not throw', async () => {
    await import('./dashboard.js');
    const { initChannelAdapters, getChannelAdapter } = await import('./channel-registry.js');
    await initChannelAdapters(noopSetup);

    const adapter = getChannelAdapter('dashboard')!;
    await expect(adapter.teardown()).resolves.toBeUndefined();
  });
});

function noopSetup(): ChannelSetup {
  return {
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  };
}
