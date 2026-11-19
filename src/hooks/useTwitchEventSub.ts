import { useEffect, useState, useRef, useCallback } from 'react';
import {
  TwitchMessage,
  getBroadcasterUserId,
  createEventSubSubscription,
  parseEventSubMessage,
  convertEventSubToTwitchMessage,
  type EventSubSubscription
} from '@/lib/twitch';

interface UseTwitchEventSubReturn {
  messages: TwitchMessage[];
  isConnected: boolean;
  error: string | null;
  connect: () => void;
  disconnect: () => void;
}

export function useTwitchEventSub(): UseTwitchEventSubReturn {
  const [messages, setMessages] = useState<TwitchMessage[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const oldWsRef = useRef<WebSocket | null>(null); // For reconnect flow
  const keepaliveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const isReconnectingRef = useRef(false);
  const manualDisconnectRef = useRef(false);
  const autoConnectTriedRef = useRef(false);

  const connect = useCallback(async (reconnectUrl?: string) => {
    manualDisconnectRef.current = false;

    // Don't close existing connection if this is a reconnect
    if (!reconnectUrl && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      console.log('Already connected, skipping new connection');
      return;
    }

    try {
      // Use reconnect URL if provided, otherwise connect to main endpoint
      const url = reconnectUrl || 'wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30';
      console.log('Connecting to EventSub:', reconnectUrl ? 'reconnect URL' : 'main endpoint');
      
      const ws = new WebSocket(url);
      
      // If this is a reconnect, keep old connection as reference
      if (reconnectUrl && wsRef.current) {
        oldWsRef.current = wsRef.current;
        isReconnectingRef.current = true;
      }
      
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('Connected to Twitch EventSub WebSocket');
      };

      ws.onmessage = async (event) => {
        const eventSubMessage = parseEventSubMessage(event.data);
        if (!eventSubMessage) return;

        const { message_type } = eventSubMessage.metadata;

        switch (message_type) {
          case 'session_welcome': {
            console.log('EventSub session welcome received');
            if (!eventSubMessage.payload.session) {
              setError('Invalid session welcome payload');
              break;
            }
            
            const sessionId = eventSubMessage.payload.session.id;
            const keepaliveTimeout = eventSubMessage.payload.session.keepalive_timeout_seconds || 10;
            
            sessionIdRef.current = sessionId;
            setIsConnected(true);
            
            // If this was a reconnect, close the old connection now
            if (isReconnectingRef.current && oldWsRef.current) {
              console.log('Closing old connection after successful reconnect');
              oldWsRef.current.close(1000, 'Reconnect successful');
              oldWsRef.current = null;
              isReconnectingRef.current = false;
            }

            // Reset keepalive timer
            if (keepaliveTimeoutRef.current) {
              clearTimeout(keepaliveTimeoutRef.current);
            }
            
            // Set timeout for keepalive - if we don't get a keepalive or notification
            // within this time, assume connection is dead
            keepaliveTimeoutRef.current = setTimeout(() => {
              console.warn('No keepalive received, connection may be dead');
              setError('Connection lost - reconnecting...');
              // Close and reconnect
              manualDisconnectRef.current = false;
              ws.close();
            }, (keepaliveTimeout + 5) * 1000); // Add 5 second buffer

            // Only create subscriptions if this is not a reconnect
            // (reconnect maintains existing subscriptions)
            if (!reconnectUrl) {
              // We have 10 seconds to create subscriptions
              await createEventSubSubscriptions(sessionId);
            }
            break;
          }

          case 'session_keepalive':
            console.log('EventSub keepalive received');
            // Reset the keepalive timeout
            if (keepaliveTimeoutRef.current) {
              clearTimeout(keepaliveTimeoutRef.current);
              const keepaliveTimeout = 10; // Default, since keepalive doesn't include timeout
              keepaliveTimeoutRef.current = setTimeout(() => {
                console.warn('No keepalive received, connection may be dead');
                setError('Connection lost - reconnecting...');
                manualDisconnectRef.current = false;
                ws.close();
              }, (keepaliveTimeout + 5) * 1000);
            }
            break;

          case 'notification': {
            console.log('EventSub notification received:', {
              type: eventSubMessage.metadata.subscription_type,
              event: eventSubMessage.payload.event
            });
            
            // Notifications reset the keepalive timer per docs
            if (keepaliveTimeoutRef.current) {
              clearTimeout(keepaliveTimeoutRef.current);
              const keepaliveTimeout = 10; // Default timeout
              keepaliveTimeoutRef.current = setTimeout(() => {
                console.warn('No keepalive received, connection may be dead');
                setError('Connection lost - reconnecting...');
                manualDisconnectRef.current = false;
                ws.close();
              }, (keepaliveTimeout + 5) * 1000);
            }
            
            const twitchMessage = convertEventSubToTwitchMessage(eventSubMessage);
            if (twitchMessage) {
              setMessages(prev => {
                const updated = [...prev, twitchMessage];
                if (updated.length > 500) {
                  return updated.slice(-300);
                }
                return updated;
              });
            } else {
              console.warn('Failed to convert EventSub message to TwitchMessage');
            }
            break;
          }

          case 'session_reconnect': {
            console.log('EventSub session reconnect requested');
            if (!eventSubMessage.payload.session?.reconnect_url) {
              setError('Invalid session reconnect payload');
              break;
            }
            
            const newReconnectUrl = eventSubMessage.payload.session.reconnect_url;
            console.log('Reconnecting to new URL as requested by Twitch');
            
            // Per docs: immediately connect to new URL but DON'T close old connection yet
            // Old connection will continue receiving events until new one is established
            connect(newReconnectUrl);
            break;
          }

          case 'revocation': {
            console.log('EventSub subscription revoked:', eventSubMessage.payload);
            const subType = eventSubMessage.payload.subscription?.type || 'unknown';
            setError(`Subscription revoked: ${subType}`);
            break;
          }

          default:
            console.log('Unknown EventSub message type:', message_type);
        }
      };

      ws.onerror = (event) => {
        console.error('EventSub WebSocket error:', event);
        setError('EventSub connection error occurred');
      };

      ws.onclose = (event) => {
        console.log('WebSocket closed:', event.code, event.reason);
        
        // Clear keepalive timeout
        if (keepaliveTimeoutRef.current) {
          clearTimeout(keepaliveTimeoutRef.current);
          keepaliveTimeoutRef.current = null;
        }

        // Don't update state if this is the old connection during reconnect
        if (oldWsRef.current === ws) {
          console.log('Old connection closed during reconnect, ignoring');
          return;
        }

        setIsConnected(false);
        wsRef.current = null;
        sessionIdRef.current = null;

        // Handle different close codes per Twitch docs
        let shouldReconnect = false;
        let errorMessage = '';
        
        switch (event.code) {
          case 1000: // Normal closure
            if (!manualDisconnectRef.current) {
              shouldReconnect = true;
              errorMessage = 'Connection closed unexpectedly';
            }
            break;
          case 4000: // Internal server error
            shouldReconnect = true;
            errorMessage = 'Twitch server error - reconnecting...';
            break;
          case 4001: // Client sent inbound traffic
            errorMessage = 'Connection closed: Invalid client message sent';
            break;
          case 4002: // Client failed ping-pong
            shouldReconnect = true;
            errorMessage = 'Connection lost: Ping timeout';
            break;
          case 4003: // Connection unused (didn't subscribe within 10 seconds)
            shouldReconnect = true;
            errorMessage = 'Connection closed: No subscriptions created';
            break;
          case 4004: // Reconnect grace time expired
            shouldReconnect = true;
            errorMessage = 'Reconnect timeout - establishing new connection';
            break;
          case 4005: // Network timeout
          case 4006: // Network error
            shouldReconnect = true;
            errorMessage = 'Network error - reconnecting...';
            break;
          case 4007: // Invalid reconnect
            shouldReconnect = true;
            errorMessage = 'Invalid reconnect URL - establishing new connection';
            break;
          default:
            // 1006 is abnormal closure - always try to reconnect
            if (event.code === 1006) {
              shouldReconnect = true;
              errorMessage = 'Connection lost - reconnecting...';
            } else {
              shouldReconnect = true;
              errorMessage = `Connection lost (code: ${event.code})`;
            }
        }

        if (errorMessage) {
          setError(errorMessage);
        }

        // Reconnect if needed
        if (shouldReconnect && !manualDisconnectRef.current) {
          console.log('Reconnecting in 1 second...');
          setTimeout(() => {
            connect();
          }, 1000);
        }
      };

    } catch (error) {
      console.error('Failed to connect to EventSub:', error);
      setError('Failed to connect to EventSub');
    }
  }, []);

  const createEventSubSubscriptions = async (sessionId: string) => {
    // Broadcaster id + token both live server-side (see worker/).
    // Any failure here is an admin-actionable configuration problem.
    let broadcasterId: string;
    try {
      broadcasterId = await getBroadcasterUserId();
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to get broadcaster user ID');
      return;
    }

    console.log('Creating subscriptions for broadcaster ID:', broadcasterId);

    // The server-side token belongs to the broadcaster (peachyhodl), so
    // user_id = broadcasterId on channel.chat.message receives ALL chat
    // messages in the channel.
    const subscriptions: Omit<EventSubSubscription, 'transport' | 'session_id'>[] = [
      // Follow events
      {
        type: 'channel.follow',
        version: '2',
        condition: {
          broadcaster_user_id: broadcasterId,
          moderator_user_id: broadcasterId
        }
      },
      // Bits/Cheer events
      {
        type: 'channel.cheer',
        version: '1',
        condition: {
          broadcaster_user_id: broadcasterId
        }
      },
      // Subscription events
      {
        type: 'channel.subscribe',
        version: '1',
        condition: {
          broadcaster_user_id: broadcasterId
        }
      },
      // Resubscription messages
      {
        type: 'channel.subscription.message',
        version: '1',
        condition: {
          broadcaster_user_id: broadcasterId
        }
      },
      // Gift subscriptions
      {
        type: 'channel.subscription.gift',
        version: '1',
        condition: {
          broadcaster_user_id: broadcasterId
        }
      },
      // Raid events
      {
        type: 'channel.raid',
        version: '1',
        condition: {
          to_broadcaster_user_id: broadcasterId
        }
      },
      // Chat messages (all users — server token is the broadcaster's)
      {
        type: 'channel.chat.message',
        version: '1',
        condition: {
          broadcaster_user_id: broadcasterId,
          user_id: broadcasterId
        }
      }
    ];

    // Create each subscription
    for (const sub of subscriptions) {
      const subscription: EventSubSubscription = {
        ...sub,
        session_id: sessionId
      };

      console.log(`Creating EventSub subscription: ${sub.type}`);
      const success = await createEventSubSubscription(subscription);
      if (success) {
        console.log(`✅ Successfully created EventSub subscription: ${sub.type}`);
      } else {
        console.error(`❌ Failed to create EventSub subscription: ${sub.type}`);
        setError(`Failed to create subscription: ${sub.type}`);
      }

      // Small delay between subscription requests to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };

  const disconnect = useCallback(() => {
    console.log('Manual disconnect requested');
    manualDisconnectRef.current = true;

    // Clear keepalive timeout
    if (keepaliveTimeoutRef.current) {
      clearTimeout(keepaliveTimeoutRef.current);
      keepaliveTimeoutRef.current = null;
    }

    // Close all connections
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.close(1000, 'Manual disconnect');
    }
    if (oldWsRef.current && oldWsRef.current.readyState === WebSocket.OPEN) {
      oldWsRef.current.close(1000, 'Manual disconnect');
    }
    
    wsRef.current = null;
    oldWsRef.current = null;
    sessionIdRef.current = null;
    setIsConnected(false);
    isReconnectingRef.current = false;
  }, []);

  // Auto-connect on mount (no per-visitor login required — the token is
  // server-side). Guard against double-invoke in React StrictMode.
  useEffect(() => {
    if (autoConnectTriedRef.current) return;
    autoConnectTriedRef.current = true;
    connect();

    return () => {
      // Cleanup on unmount
      manualDisconnectRef.current = true;
      if (wsRef.current) {
        disconnect();
      }
    };
  }, [connect, disconnect]);

  return {
    messages,
    isConnected,
    error,
    connect,
    disconnect
  };
}
