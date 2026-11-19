// Twitch chat integration for the unified livestream chat.
//
// The broadcaster token lives server-side in a Cloudflare Worker
// (see worker/ and .github/workflows/twitch-secrets.yml). The browser never
// sees a Twitch token; it talks to the same-origin proxy under /twitch/* for
// Helix calls and connects to EventSub's public WebSocket directly.

export const TWITCH_CHANNEL = 'peachyhodl';

const PROXY_BASE = '/twitch';

export interface TwitchMessage {
  id: string;
  username: string;
  displayName: string;
  message: string;
  timestamp: number;
  color?: string;
  badges?: string[];
  emotes?: Record<string, string[]>;
  isMod?: boolean;
  isSubscriber?: boolean;
  isVip?: boolean;
  isBroadcaster?: boolean;
  messageType?: 'chat' | 'subscription' | 'giftsub' | 'bits' | 'raid' | 'announcement' | 'follow' | 'zap';
  // Subscription related
  subTier?: '1000' | '2000' | '3000' | 'Prime';
  subMonths?: number;
  subMessage?: string;
  isResub?: boolean;
  // Gift sub related
  giftRecipient?: string;
  giftMonths?: number;
  giftTotal?: number;
  // Bits related
  bits?: number;
  // Raid related
  raidViewers?: number;
  raidFromChannel?: string;
  // Follow related
  isFirstTimeFollower?: boolean;
  // Zap related
  satoshis?: number;
  zapType?: 'profile' | 'stream';
}

// ─── server-proxy calls (token stays server-side) ───────────────────────────

/** Broadcaster user id via the /twitch proxy. Throws with admin-facing hints. */
export async function getBroadcasterUserId(login = TWITCH_CHANNEL): Promise<string> {
  const res = await fetch(`${PROXY_BASE}/broadcaster?login=${encodeURIComponent(login)}`);
  const data = await res.json().catch(() => ({})) as { id?: string; error?: string; status?: number; hint?: string };
  if (!res.ok || !data.id) {
    if (res.status === 503 || data.error === 'not-configured') {
      throw new Error('Twitch relay not configured yet (admin: set the GitHub secrets and run the "Twitch Secrets → Worker" workflow)');
    }
    if (res.status === 401) {
      throw new Error('Twitch token rejected (admin: refresh the TWITCH_REFRESH_TOKEN or TWITCH_ACCESS_TOKEN GitHub secret, then re-run the workflow)');
    }
    throw new Error(data.hint || data.error || `Twitch relay error (${res.status})`);
  }
  return data.id;
}

// EventSub subscription types
export interface EventSubSubscription {
  type: string;
  version: string;
  condition: Record<string, string>;
  /** Browser EventSub WebSocket session id (from session_welcome). */
  session_id: string;
}

/** Create an EventSub subscription via the proxy; the proxy attaches the token. */
export async function createEventSubSubscription(subscription: EventSubSubscription): Promise<boolean> {
  try {
    const res = await fetch(`${PROXY_BASE}/eventsub/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: subscription.type,
        version: subscription.version,
        condition: subscription.condition,
        session_id: subscription.session_id,
      }),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({})) as { error?: string; detail?: { message?: string } };
      console.error('Failed to create EventSub subscription:', {
        status: res.status,
        error,
        subscription: { type: subscription.type, version: subscription.version },
      });
      if (error.detail?.message) {
        console.error('Twitch API Error:', error.detail.message);
      }
      return false;
    }
    const result = await res.json() as { total_cost?: number; max_total_cost?: number };
    if (result.total_cost && result.max_total_cost && result.total_cost >= result.max_total_cost * 0.8) {
      console.warn('⚠️ Approaching EventSub subscription cost limit!');
    }
    return true;
  } catch (error) {
    console.error('Error creating EventSub subscription:', error);
    return false;
  }
}

// ─── EventSub WebSocket message types ───────────────────────────────────────

export interface EventSubMessage {
  metadata: {
    message_id: string;
    message_type: 'session_welcome' | 'session_keepalive' | 'notification' | 'session_reconnect' | 'revocation';
    message_timestamp: string;
    subscription_type?: string;
    subscription_version?: string;
  };
  payload: {
    session?: {
      id: string;
      keepalive_timeout_seconds?: number;
      reconnect_url?: string;
    };
    event?: Record<string, unknown>;
    subscription?: {
      type: string;
      version: string;
      condition: Record<string, string>;
      transport: {
        method: string;
        session_id: string;
      };
      created_at: string;
    };
  };
}

// Parse EventSub WebSocket message
export function parseEventSubMessage(data: string): EventSubMessage | null {
  try {
    return JSON.parse(data) as EventSubMessage;
  } catch (error) {
    console.error('Failed to parse EventSub message:', error);
    return null;
  }
}

// Convert EventSub notification to TwitchMessage
export function convertEventSubToTwitchMessage(message: EventSubMessage): TwitchMessage | null {
  if (message.metadata.message_type !== 'notification' || !message.payload.event) return null;
  
  const { subscription_type } = message.metadata;
  const event = message.payload.event as Record<string, unknown>;
  
  const baseId = message.metadata.message_id;
  const timestamp = new Date(message.metadata.message_timestamp).getTime();
  
  switch (subscription_type) {
    case 'channel.follow':
      return {
        id: baseId,
        username: String(event.user_login || 'unknown'),
        displayName: String(event.user_name || 'Unknown'),
        message: `${String(event.user_name || 'Unknown')} is now following!`,
        timestamp,
        messageType: 'follow',
        isFirstTimeFollower: true
      };
      
    case 'channel.cheer': {
      const isAnonymous = Boolean(event.is_anonymous);
      const bits = Number(event.bits || 0);
      const username = isAnonymous ? 'anonymous' : String(event.user_login || 'anonymous');
      const displayName = isAnonymous ? 'Anonymous' : String(event.user_name || 'Anonymous');
      const message = String(event.message || '');
      
      return {
        id: baseId,
        username,
        displayName,
        message: message || `Cheered ${bits} bits!`,
        timestamp,
        messageType: 'bits',
        bits
      };
    }
      
    case 'channel.subscribe':
      return {
        id: baseId,
        username: String(event.user_login || 'unknown'),
        displayName: String(event.user_name || 'Unknown'),
        message: `${String(event.user_name || 'Unknown')} subscribed!`,
        timestamp,
        messageType: 'subscription',
        isResub: false,
        subTier: String(event.tier) === '1000' ? '1000' : String(event.tier) === '2000' ? '2000' : String(event.tier) === '3000' ? '3000' : 'Prime',
        subMonths: 1
      };
      
    case 'channel.subscription.message': {
      const messageObj = event.message as { text?: string } | undefined;
      return {
        id: baseId,
        username: String(event.user_login || 'unknown'),
        displayName: String(event.user_name || 'Unknown'),
        message: messageObj?.text || `${String(event.user_name || 'Unknown')} resubscribed!`,
        timestamp,
        messageType: 'subscription',
        isResub: true,
        subTier: String(event.tier) === '1000' ? '1000' : String(event.tier) === '2000' ? '2000' : String(event.tier) === '3000' ? '3000' : 'Prime',
        subMonths: Number(event.cumulative_months || 1)
      };
    }
      
    case 'channel.subscription.gift': {
      const total = Number(event.total || 1);
      return {
        id: baseId,
        username: String(event.user_login || 'anonymous'),
        displayName: String(event.user_name || 'Anonymous'),
        message: `${String(event.user_name || 'Anonymous')} gifted ${total} sub${total > 1 ? 's' : ''} to the community!`,
        timestamp,
        messageType: 'giftsub',
        subTier: String(event.tier) === '1000' ? '1000' : String(event.tier) === '2000' ? '2000' : String(event.tier) === '3000' ? '3000' : 'Prime',
        giftTotal: total,
        giftMonths: 1
      };
    }
      
    case 'channel.raid': {
      const viewers = Number(event.viewers || 0);
      const fromName = String(event.from_broadcaster_user_name || 'Unknown');
      return {
        id: baseId,
        username: String(event.from_broadcaster_user_login || 'unknown'),
        displayName: fromName,
        message: `${fromName} is raiding with ${viewers} viewers!`,
        timestamp,
        messageType: 'raid',
        raidViewers: viewers,
        raidFromChannel: fromName
      };
    }
      
    case 'channel.chat.message': {
      const messageObj = event.message as { text?: string } | undefined;
      const badgesArray = Array.isArray(event.badges) 
        ? (event.badges as Array<{ set_id?: string }>).map(b => b.set_id || '').filter(Boolean)
        : [];
      
      return {
        id: baseId,
        username: String(event.chatter_user_login || 'unknown'),
        displayName: String(event.chatter_user_name || 'Unknown'),
        message: messageObj?.text || '',
        timestamp,
        messageType: 'chat',
        color: String(event.color || ''),
        badges: badgesArray,
        isMod: badgesArray.includes('moderator'),
        isSubscriber: badgesArray.includes('subscriber'),
        isVip: badgesArray.includes('vip'),
        isBroadcaster: badgesArray.includes('broadcaster')
      };
    }
      
    default:
      console.log('Unknown EventSub subscription type:', subscription_type);
      return null;
  }
}
