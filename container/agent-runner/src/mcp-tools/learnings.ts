/**
 * Shared learnings MCP tool — lets agents share discoveries with other agents
 * via the global learnings directory.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const learningTools: McpToolDefinition[] = [
  {
    tool: {
      name: 'append_learning',
      description:
        'Share a learning or discovery with other agents. Writes to the shared global learnings directory so other agents can benefit from your findings.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          title: {
            type: 'string',
            description: 'Short title for the learning (used as filename and index entry)',
          },
          content: {
            type: 'string',
            description: 'The learning content in markdown format',
          },
        },
        required: ['title', 'content'],
      },
    },
    handler: async (args: Record<string, unknown>) => {
      const title = args.title as string;
      const content = args.content as string;

      if (!title || !content) {
        return { content: [{ type: 'text' as const, text: 'Both title and content are required.' }] };
      }

      // Write as a system action — host picks it up in delivery.ts
      writeMessageOut({
        id: generateId(),
        kind: 'system',
        channel_type: null,
        platform_id: null,
        thread_id: null,
        content: JSON.stringify({
          action: 'append_learning',
          title,
          content,
        }),
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: `Learning "${title}" submitted. It will appear in /workspace/global/learnings/ for all agents.`,
          },
        ],
      };
    },
  },
];

registerTools(learningTools);
