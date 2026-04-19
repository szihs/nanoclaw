/**
 * v2 Channel Adapter interface.
 *
 * Channel adapters bridge NanoClaw with messaging platforms (Discord, Slack, etc.).
 * Two patterns: native adapters (implement directly) or Chat SDK bridge (wrap a Chat SDK adapter).
 */

/** Configuration for a registered conversation (messaging group + agent wiring). */
export interface ConversationConfig {
  platformId: string;
  agentGroupId: string;
  /**
   * When does the agent engage on messages from this conversation?
   *
   *   'pattern'        — regex test against message text; engagePattern='.'
   *                      means "always" (match everything)
   *   'mention'        — fires only on @mention
   *   'mention-sticky' — fires on @mention, then auto-subscribes to the thread
   *                      and treats subsequent messages as engage-all.
   *                      Threaded platforms only (Slack/Discord/Linear).
   */
  engageMode: 'pattern' | 'mention' | 'mention-sticky';
  /** Regex source when engageMode='pattern'. '.' is the "always" sentinel. */
  engagePattern?: string | null;
  sessionMode: 'shared' | 'per-thread' | 'agent-shared';
}

/** Passed to the adapter at setup time. */
export interface ChannelSetup {
  /** Known conversations from central DB. */
  conversations: ConversationConfig[];

  /** Called when an inbound message arrives from the platform. */
  onInbound(platformId: string, threadId: string | null, message: InboundMessage): void | Promise<void>;

  /** Called when the adapter discovers metadata about a conversation. */
  onMetadata(platformId: string, name?: string, isGroup?: boolean): void;

  /** Called when a user clicks a button/action in a card (e.g., ask_user_question response). */
  onAction(questionId: string, selectedOption: string, userId: string): void;
}

/** Inbound message from adapter to host. */
export interface InboundMessage {
  id: string;
  kind: 'chat' | 'chat-sdk';
  content: unknown; // JS object — host will JSON.stringify before writing to session DB
  timestamp: string;
}

/** A file attachment to deliver alongside a message. */
export interface OutboundFile {
  filename: string;
  data: Buffer;
}

/** Outbound message from host to adapter. */
export interface OutboundMessage {
  kind: string;
  content: unknown; // parsed JSON from messages_out
  files?: OutboundFile[]; // file attachments from the session outbox
}

/** Discovered conversation info (from syncConversations). */
export interface ConversationInfo {
  platformId: string;
  name: string;
  isGroup: boolean;
}

/** The v2 channel adapter contract. */
export interface ChannelAdapter {
  name: string;
  channelType: string;

  /**
   * Whether this adapter models conversations as threads.
   *
   * true  — adapter's platform uses threads as the primary conversation unit
   *         (Discord, Slack, Linear, GitHub). One thread = one session; the
   *         agent replies into the originating thread.
   * false — adapter's platform treats the channel itself as the conversation
   *         (Telegram, WhatsApp, iMessage). Thread ids are stripped at the
   *         router; agent replies go to the channel.
   */
  supportsThreads: boolean;

  // Lifecycle
  setup(config: ChannelSetup): Promise<void>;
  teardown(): Promise<void>;
  isConnected(): boolean;

  // Outbound delivery — returns the platform message ID if available
  deliver(platformId: string, threadId: string | null, message: OutboundMessage): Promise<string | undefined>;

  // Optional
  setTyping?(platformId: string, threadId: string | null): Promise<void>;
  syncConversations?(): Promise<ConversationInfo[]>;
  updateConversations?(conversations: ConversationConfig[]): void;

  /**
   * Open (or fetch) a DM with this user, returning the platform_id of the
   * resulting DM channel. Called by the host on demand to initiate cold
   * DMs — approvals, pairing handshakes, host-initiated notifications — to
   * users who may never have messaged the bot themselves.
   *
   * Omit this method on channels where the user handle IS already the DM
   * chat id (Telegram, WhatsApp, iMessage, email, Matrix). Callers will
   * fall through to using the handle directly.
   *
   * For channels that distinguish user id from DM channel id (Discord,
   * Slack, Teams, Webex, gChat): implement by delegating to Chat SDK's
   * chat.openDM, which hits the platform's idempotent open-DM endpoint.
   * Returning the same platform_id on repeated calls is expected.
   */
  openDM?(userHandle: string): Promise<string>;
}

/** Factory function that creates a channel adapter (returns null if credentials missing). */
export type ChannelAdapterFactory = () => ChannelAdapter | Promise<ChannelAdapter> | null;

/** Registration entry for a channel adapter. */
export interface ChannelRegistration {
  factory: ChannelAdapterFactory;
  containerConfig?: {
    mounts?: Array<{ hostPath: string; containerPath: string; readonly: boolean }>;
    env?: Record<string, string>;
  };
}
