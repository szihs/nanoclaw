/**
 * GitHub webhook receiver — dedicated HTTP server on GITHUB_WEBHOOK_PORT.
 *
 * Separate from dashboard-ingress (127.0.0.1 only) so this port can be
 * exposed publicly via brev without exposing the dashboard chat endpoint.
 * Security: HMAC-SHA256 (X-Hub-Signature-256) validation before any processing.
 */
import crypto from 'crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';

import { GITHUB_WEBHOOK_BOT_MENTION, GITHUB_WEBHOOK_PORT, GITHUB_WEBHOOK_SECRET } from './config.js';
import { log } from './log.js';
import { deliverGitHubMention } from './webhook-github.js';

const MAX_BODY_SIZE = 512 * 1024; // 512 KB

export interface GitHubWebhookServerHandle {
  server: Server;
  stop(): Promise<void>;
}

function writeJson(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function readRawBody(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  return new Promise((resolve) => {
    let body = '';
    let exceeded = false;
    req.on('data', (chunk: Buffer | string) => {
      body += chunk.toString();
      if (body.length > MAX_BODY_SIZE && !exceeded) {
        exceeded = true;
        writeJson(res, 413, { error: 'payload too large' });
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

/** Constant-time HMAC-SHA256 comparison against GitHub's X-Hub-Signature-256 header. */
function verifySignature(secret: string, rawBody: string, sigHeader: string): boolean {
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
  try {
    const maxLen = Math.max(expected.length, sigHeader.length);
    const a = Buffer.alloc(maxLen, 0);
    const b = Buffer.alloc(maxLen, 0);
    Buffer.from(expected).copy(a);
    Buffer.from(sigHeader).copy(b);
    return crypto.timingSafeEqual(a, b) && expected === sigHeader;
  } catch {
    return false;
  }
}

export function startGitHubWebhookServer(): GitHubWebhookServerHandle {
  if (!GITHUB_WEBHOOK_SECRET) {
    log.warn('GITHUB_WEBHOOK_SECRET not set — webhook server will reject all requests');
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || req.url !== '/webhook/github') {
      writeJson(res, 404, { error: 'not found' });
      return;
    }

    const eventType = req.headers['x-github-event'];
    if (eventType !== 'issue_comment' && eventType !== 'pull_request_review_comment') {
      writeJson(res, 200, { ok: true, skipped: true, reason: 'not issue_comment or pull_request_review_comment' });
      return;
    }

    // Read raw body before any parsing — HMAC is over the raw bytes
    const rawBody = await readRawBody(req, res);
    if (rawBody === null) return;

    // Validate HMAC before touching the payload
    const sigHeader = String(req.headers['x-hub-signature-256'] ?? '');
    if (!GITHUB_WEBHOOK_SECRET || !verifySignature(GITHUB_WEBHOOK_SECRET, rawBody, sigHeader)) {
      log.warn('github-webhook: invalid or missing signature');
      writeJson(res, 401, { error: 'invalid signature' });
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      writeJson(res, 400, { error: 'invalid json' });
      return;
    }

    if (payload.action !== 'created') {
      writeJson(res, 200, { ok: true, skipped: true, reason: 'action not created' });
      return;
    }

    const comment = payload.comment as Record<string, unknown> | undefined;
    const repository = payload.repository as Record<string, unknown> | undefined;
    const commentBody = typeof comment?.body === 'string' ? comment.body : '';

    if (!commentBody.toLowerCase().includes(GITHUB_WEBHOOK_BOT_MENTION.toLowerCase())) {
      writeJson(res, 200, { ok: true, skipped: true, reason: 'bot not mentioned' });
      return;
    }

    const repo = typeof repository?.full_name === 'string' ? repository.full_name : '';
    const commentId = typeof comment?.id === 'number' ? comment.id : 0;

    let issueNumber: number;
    let isPr: boolean;
    let prBranch: string | null;

    if (eventType === 'pull_request_review_comment') {
      const pr = payload.pull_request as Record<string, unknown> | undefined;
      issueNumber = typeof pr?.number === 'number' ? pr.number : 0;
      isPr = true;
      prBranch =
        typeof (pr?.head as Record<string, unknown> | undefined)?.ref === 'string'
          ? String((pr!.head as Record<string, unknown>).ref)
          : null;
    } else {
      const issue = payload.issue as Record<string, unknown> | undefined;
      issueNumber = typeof issue?.number === 'number' ? issue.number : 0;
      isPr = Boolean(issue?.pull_request);
      // issue_comment events don't include the branch; orchestrator resolves via gh api
      prBranch = null;
    }

    if (!repo || !issueNumber || !commentId) {
      log.warn('github-webhook: malformed payload', { repo, issueNumber, commentId });
      writeJson(res, 400, { error: 'malformed payload' });
      return;
    }

    deliverGitHubMention({
      repo,
      issueNumber,
      commentId,
      commentUrl: typeof comment?.html_url === 'string' ? comment.html_url : '',
      commenter:
        typeof (comment?.user as Record<string, unknown> | undefined)?.login === 'string'
          ? String((comment!.user as Record<string, unknown>).login)
          : '',
      body: commentBody,
      isPr,
      prBranch,
    });

    writeJson(res, 200, { ok: true });
  });

  server.listen(GITHUB_WEBHOOK_PORT, '0.0.0.0', () => {
    log.info('GitHub webhook server listening', { port: GITHUB_WEBHOOK_PORT });
  });

  return {
    server,
    stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
