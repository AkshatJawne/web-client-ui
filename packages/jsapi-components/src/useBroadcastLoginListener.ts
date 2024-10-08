import {
  type BroadcastLoginMessage,
  type BroadcastLogoutMessage,
  isBroadcastLoginMessage,
  isBroadcastLogoutMessage,
  type Message,
} from '@deephaven/jsapi-utils';
import { useCallback } from 'react';
import useBroadcastChannel from './useBroadcastChannel';

export function useBroadcastLoginListener(
  onLogin?: (message: BroadcastLoginMessage) => void,
  onLogout?: (message: BroadcastLogoutMessage) => void
): void {
  const onMessage = useCallback(
    (event: MessageEvent<Message<unknown>>) => {
      if (isBroadcastLoginMessage(event.data)) {
        onLogin?.(event.data);
      } else if (isBroadcastLogoutMessage(event.data)) {
        onLogout?.(event.data);
      }
    },
    [onLogin, onLogout]
  );

  useBroadcastChannel(onMessage);
}

export default useBroadcastLoginListener;
