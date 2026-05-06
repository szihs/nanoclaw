/**
 * `append_learning` delivery-action handler.
 *
 * Persists a shared learning to the shared learnings directory
 * (data/shared/learnings/) and rebuilds the INDEX.md file. Any agent
 * can contribute learnings via the MCP tool; the file is mounted at
 * /workspace/shared/learnings/ inside the container.
 */
import fs from 'fs';
import path from 'path';

import { SHARED_DIR } from '../../config.js';
import { getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';

function notifyAgent(session: Session, text: string): void {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  });
  const fresh = getSession(session.id);
  if (fresh) {
    wakeContainer(fresh).catch((err) => log.error('Failed to wake container after notification', { err }));
  }
}

export async function handleAppendLearning(content: Record<string, unknown>, session: Session): Promise<void> {
  const title = content.title as string;
  const body = content.content as string;
  if (!title || !body) {
    notifyAgent(session, 'append_learning failed: title and content are required.');
    return;
  }
  const sharedDir = path.join(SHARED_DIR, 'learnings');
  fs.mkdirSync(sharedDir, { recursive: true });

  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  const filename = `${Date.now()}-${slug}.md`;
  fs.writeFileSync(path.join(sharedDir, filename), `# ${title}\n\n${body}\n`);

  // Rebuild INDEX.md
  const files = fs
    .readdirSync(sharedDir)
    .filter((f) => f.endsWith('.md') && f !== 'INDEX.md')
    .sort();
  const indexLines = ['# Shared Learnings Index\n'];
  for (const f of files) {
    const displayName = f.replace(/^\d+-/, '').replace(/\.md$/, '').replace(/-/g, ' ');
    indexLines.push(`- [${displayName}](${f})`);
  }
  fs.writeFileSync(path.join(sharedDir, 'INDEX.md'), indexLines.join('\n') + '\n');

  notifyAgent(session, `Learning saved: ${title}`);
  log.info('Shared learning appended', { title, filename });
}
