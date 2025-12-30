import { io, Socket } from 'socket.io-client';

const DEFAULT_URL = 'http://localhost:4100';

let socket: Socket | null = null;
let currentUrl: string | null = null;

export function getSocket(baseUrl?: string): Socket {
  const resolvedUrl = (baseUrl || import.meta.env.VITE_BRIDGE_URL || DEFAULT_URL).trim();
  if (!socket || currentUrl !== resolvedUrl) {
    if (socket) {
      socket.disconnect();
    }
    currentUrl = resolvedUrl;
    socket = io(resolvedUrl, {
      transports: ['websocket'],
    });
  }
  return socket;
}
