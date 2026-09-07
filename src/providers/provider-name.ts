/**
 * The one rule for which provider an agent group runs on: the session's
 * pinned provider, else the group's own `agent_provider`, else the group's
 * container config, else Claude. Spawn resolves through this, and so does
 * every host command that must validate against the group's actual provider
 * (e.g. `--speed`).
 *
 * `agentGroupProvider` is a real tier on this fork — upstream's rule has only
 * two, which makes a group-level provider pick silently lose to container.json.
 * Optional so callers that genuinely have no group row keep working.
 */
export function resolveProviderName(
  sessionProvider: string | null | undefined,
  agentGroupProvider: string | null | undefined,
  containerConfigProvider?: string | null | undefined,
): string {
  return (sessionProvider || agentGroupProvider || containerConfigProvider || 'claude').toLowerCase();
}
