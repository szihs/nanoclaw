import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';

import { DASHBOARD_INGRESS_HOST, DASHBOARD_INGRESS_PORT, DASHBOARD_SECRET } from './config.js';
import { getChannelAdapter } from './channels/channel-registry.js';
import { log } from './log.js';
import { routeInbound } from './router.js';
import type { InboundEvent } from './channels/adapter.js';

const MAX_BODY_SIZE = 1024 * 1024; // 1 MB
const VALID_DECISIONS = new Set(['Approve', 'Reject']);

export interface DashboardIngressHandle {
  server: Server;
  stop(): Promise<void>;
}

interface DashboardIngressOptions {
  host?: string;
  port?: number;
  secret?: string;
  isAdapterReady?: () => boolean;
  routeInboundFn?: (event: InboundEvent) => Promise<void>;
  onActionFn?: (questionId: string, selectedOption: string, userId: string) => Promise<void>;
  /** Handle arbitrary question responses (no VALID_DECISIONS restriction). */
  onQuestionFn?: (questionId: string, selectedOption: string, userId: string) => Promise<void>;
  /** Handle credential submission (value held only long enough to call OneCLI). */
  onCredentialSubmitFn?: (credentialId: string, value: string) => Promise<void>;
  /** Handle credential rejection. */
  onCredentialRejectFn?: (credentialId: string) => Promise<void>;
}

function generateMessageId(): string {
  return `dash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function writeJson(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function readBody(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  return new Promise((resolve) => {
    let body = '';
    let exceeded = false;
    req.on('data', (chunk: Buffer | string) => {
      body += chunk.toString();
      if (body.length > MAX_BODY_SIZE && !exceeded) {
        exceeded = true;
        writeJson(res, 413, { error: 'Request body too large' });
        req.destroy();
        resolve(null);
      }
    });
    req.on('end', () => {
      if (!exceeded) resolve(body);
    });
    req.on('error', () => {
      if (!exceeded) resolve(null);
    });
  });
}

async function handleApprovalAction(
  req: IncomingMessage,
  res: ServerResponse,
  onActionFn: DashboardIngressOptions['onActionFn'],
): Promise<void> {
  const body = await readBody(req, res);
  if (body === null) return;
  try {
    const parsed = JSON.parse(body);
    const approvalId = typeof parsed.approvalId === 'string' ? parsed.approvalId.trim() : '';
    // Canonical field is 'decision'; 'response' is a legacy compat shim (remove after next release)
    const decision =
      typeof parsed.decision === 'string'
        ? parsed.decision.trim()
        : typeof parsed.response === 'string'
          ? parsed.response.trim()
          : '';
    if (!approvalId || !decision) {
      writeJson(res, 400, { error: 'approvalId and decision required' });
      return;
    }
    if (!VALID_DECISIONS.has(decision)) {
      writeJson(res, 400, {
        error: `Invalid decision "${decision}". Must be one of: ${[...VALID_DECISIONS].join(', ')}`,
      });
      return;
    }
    if (!onActionFn) {
      writeJson(res, 501, { error: 'action handler not configured' });
      return;
    }
    await onActionFn(approvalId, decision, 'dashboard-admin');
    log.info('Dashboard approval action', { approvalId, decision });
    writeJson(res, 200, { ok: true });
  } catch (err) {
    log.error('Failed to handle dashboard action', { err });
    writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

export function startDashboardIngress(options: DashboardIngressOptions = {}): DashboardIngressHandle {
  const host = options.host || DASHBOARD_INGRESS_HOST;
  const port = options.port ?? DASHBOARD_INGRESS_PORT;
  const secret = options.secret ?? DASHBOARD_SECRET;
  const isAdapterReady = options.isAdapterReady || (() => Boolean(getChannelAdapter('dashboard')));
  const routeInboundFn = options.routeInboundFn || routeInbound;
  const onActionFn = options.onActionFn;
  const onQuestionFn = options.onQuestionFn;
  const onCredentialSubmitFn = options.onCredentialSubmitFn;
  const onCredentialRejectFn = options.onCredentialRejectFn;

  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      writeJson(res, 404, { error: 'not found' });
      return;
    }

    if (secret) {
      const auth = req.headers.authorization || '';
      if (auth !== `Bearer ${secret}`) {
        writeJson(res, 401, { error: 'unauthorized' });
        return;
      }
    }

    // Approval action endpoint
    if (req.url === '/api/dashboard/action') {
      await handleApprovalAction(req, res, onActionFn);
      return;
    }

    // Question response endpoint — accepts arbitrary options (no VALID_DECISIONS gate)
    if (req.url === '/api/dashboard/question-response') {
      const body = await readBody(req, res);
      if (body === null) return;
      try {
        const parsed = JSON.parse(body);
        const questionId = typeof parsed.questionId === 'string' ? parsed.questionId.trim() : '';
        const selectedOption = typeof parsed.selectedOption === 'string' ? parsed.selectedOption.trim() : '';
        if (!questionId || !selectedOption) {
          writeJson(res, 400, { error: 'questionId and selectedOption required' });
          return;
        }
        if (!onQuestionFn) {
          writeJson(res, 501, { error: 'question handler not configured' });
          return;
        }
        await onQuestionFn(questionId, selectedOption, 'dashboard-admin');
        log.info('Dashboard question response', { questionId, selectedOption });
        writeJson(res, 200, { ok: true });
      } catch (err) {
        log.error('Failed to handle dashboard question response', { err });
        writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // Credential submit endpoint
    if (req.url === '/api/dashboard/credential-submit') {
      const body = await readBody(req, res);
      if (body === null) return;
      try {
        const parsed = JSON.parse(body);
        const credentialId = typeof parsed.credentialId === 'string' ? parsed.credentialId.trim() : '';
        const value = typeof parsed.value === 'string' ? parsed.value : '';
        if (!credentialId || !value) {
          writeJson(res, 400, { error: 'credentialId and value required' });
          return;
        }
        if (!onCredentialSubmitFn) {
          writeJson(res, 501, { error: 'credential submit handler not configured' });
          return;
        }
        await onCredentialSubmitFn(credentialId, value);
        log.info('Dashboard credential submitted', { credentialId });
        writeJson(res, 200, { ok: true });
      } catch (err) {
        log.error('Failed to handle dashboard credential submit', { err });
        writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // Credential reject endpoint
    if (req.url === '/api/dashboard/credential-reject') {
      const body = await readBody(req, res);
      if (body === null) return;
      try {
        const parsed = JSON.parse(body);
        const credentialId = typeof parsed.credentialId === 'string' ? parsed.credentialId.trim() : '';
        if (!credentialId) {
          writeJson(res, 400, { error: 'credentialId required' });
          return;
        }
        if (!onCredentialRejectFn) {
          writeJson(res, 501, { error: 'credential reject handler not configured' });
          return;
        }
        await onCredentialRejectFn(credentialId);
        log.info('Dashboard credential rejected', { credentialId });
        writeJson(res, 200, { ok: true });
      } catch (err) {
        log.error('Failed to handle dashboard credential reject', { err });
        writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // Chat message endpoint
    if (req.url !== '/api/dashboard/inbound') {
      writeJson(res, 404, { error: 'not found' });
      return;
    }

    const body = await readBody(req, res);
    if (body === null) return;

    let parsed: { group?: unknown; content?: unknown };
    try {
      parsed = JSON.parse(body);
    } catch {
      writeJson(res, 400, { error: 'invalid json' });
      return;
    }

    const group = typeof parsed.group === 'string' ? parsed.group.trim() : '';
    const content = typeof parsed.content === 'string' ? parsed.content.trim() : '';
    if (!group || !content) {
      writeJson(res, 400, { error: 'group and content required' });
      return;
    }

    if (!isAdapterReady()) {
      writeJson(res, 503, { error: 'Dashboard channel adapter not ready' });
      return;
    }

    try {
      await routeInboundFn({
        channelType: 'dashboard',
        platformId: `dashboard:${group}`,
        threadId: null,
        message: {
          id: generateMessageId(),
          kind: 'chat',
          content: JSON.stringify({ text: content, sender: 'dashboard-admin', senderId: 'dashboard-admin' }),
          timestamp: new Date().toISOString(),
        },
      });
      writeJson(res, 200, { ok: true });
    } catch (err) {
      log.error('Failed to route dashboard inbound message', { group, err });
      writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.listen(port, host, () => {
    log.info('Dashboard ingress listening', { host, port });
  });

  return {
    server,
    stop() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}
