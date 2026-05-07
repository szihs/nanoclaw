import { once } from 'events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { startDashboardIngress } from './dashboard-ingress.js';

let handles: Array<{ stop: () => Promise<void> }> = [];

afterEach(async () => {
  while (handles.length > 0) {
    await handles.pop()!.stop();
  }
});

describe('dashboard ingress', () => {
  it('routes browser chat into the host router', async () => {
    const routeInboundFn = vi.fn().mockResolvedValue(undefined);
    const handle = startDashboardIngress({
      host: '127.0.0.1',
      port: 0,
      isAdapterReady: () => true,
      routeInboundFn,
    });
    handles.push(handle);
    await once(handle.server, 'listening');
    const address = handle.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected dashboard ingress to bind an ephemeral TCP port');
    }

    const res = await fetch(`http://127.0.0.1:${address.port}/api/dashboard/inbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group: 'reviewer', content: 'hello from dashboard' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(routeInboundFn).toHaveBeenCalledTimes(1);
    expect(routeInboundFn).toHaveBeenCalledWith(
      expect.objectContaining({
        channelType: 'dashboard',
        platformId: 'dashboard:reviewer',
        threadId: null,
        message: expect.objectContaining({
          kind: 'chat',
          content: JSON.stringify({
            text: 'hello from dashboard',
            sender: 'dashboard-admin',
            senderId: 'dashboard-admin',
          }),
        }),
      }),
    );
  });

  it('returns 503 when the dashboard adapter is not ready in the host', async () => {
    const routeInboundFn = vi.fn().mockResolvedValue(undefined);
    const handle = startDashboardIngress({
      host: '127.0.0.1',
      port: 0,
      isAdapterReady: () => false,
      routeInboundFn,
    });
    handles.push(handle);
    await once(handle.server, 'listening');
    const address = handle.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected dashboard ingress to bind an ephemeral TCP port');
    }

    const res = await fetch(`http://127.0.0.1:${address.port}/api/dashboard/inbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group: 'reviewer', content: 'hello from dashboard' }),
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Dashboard channel adapter not ready' });
    expect(routeInboundFn).not.toHaveBeenCalled();
  });
});
