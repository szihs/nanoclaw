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

  it('passes thread_id through to routeInbound when provided', async () => {
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
      body: JSON.stringify({ group: 'reviewer', content: 'hello', thread_id: 'msg-abc-123' }),
    });

    expect(res.status).toBe(200);
    expect(routeInboundFn).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'msg-abc-123' }),
    );
  });

  it('trims whitespace and treats empty-after-trim thread_id as null', async () => {
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
    if (!address || typeof address === 'string') throw new Error('bind failed');

    const res = await fetch(`http://127.0.0.1:${address.port}/api/dashboard/inbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group: 'reviewer', content: 'hello', thread_id: '   ' }),
    });

    expect(res.status).toBe(200);
    expect(routeInboundFn).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: null }),
    );
  });

  it('rejects non-string thread_id with 400', async () => {
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
    if (!address || typeof address === 'string') throw new Error('bind failed');

    const res = await fetch(`http://127.0.0.1:${address.port}/api/dashboard/inbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group: 'reviewer', content: 'hello', thread_id: 123 }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'thread_id must be a string' });
    expect(routeInboundFn).not.toHaveBeenCalled();
  });

  it('rejects thread_id longer than 200 chars with 400', async () => {
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
    if (!address || typeof address === 'string') throw new Error('bind failed');

    const res = await fetch(`http://127.0.0.1:${address.port}/api/dashboard/inbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group: 'reviewer', content: 'hello', thread_id: 'x'.repeat(201) }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'thread_id too long (max 200 chars)' });
    expect(routeInboundFn).not.toHaveBeenCalled();
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
