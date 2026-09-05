import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";

import {
  createAccessClient,
  type AccessClient,
  type AccessClientHandle,
} from "@arduano/agent-multiplex-client/browser";

interface ApiContextValue {
  readonly client: AccessClient;
  readonly connectionKey: number;
}

const ApiContext = createContext<ApiContextValue | null>(null);

export interface ApiProviderProps extends PropsWithChildren {
  readonly connectionKey: number;
  readonly enableWebSocket?: boolean;
}

export function ApiProvider({ connectionKey, enableWebSocket = true, children }: ApiProviderProps) {
  const [binding, setBinding] = useState<{
    handle: AccessClientHandle; connectionKey: number; enableWebSocket: boolean;
  } | null>(null);
  useEffect(() => {
    const httpUrl = new URL("/trpc", window.location.href).toString();
    const wsUrl = new URL(httpUrl);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    const handle = createAccessClient({
      httpUrl,
      ...(enableWebSocket ? { wsUrl: wsUrl.toString() } : {}),
    });
    setBinding({ handle, connectionKey, enableWebSocket });
    return () => { handle.close(); };
  }, [connectionKey, enableWebSocket]);

  const value = useMemo(
    () => binding && binding.connectionKey === connectionKey && binding.enableWebSocket === enableWebSocket
      ? { client: binding.handle.client, connectionKey } : null,
    [binding, connectionKey, enableWebSocket],
  );
  // Own the connection in an effect. A render can be discarded, and development
  // StrictMode probes setup/cleanup; neither may leak or reuse a closed client.
  if (!value) return <p className="p-4 text-sm text-[var(--text-secondary)]" role="status">Opening workspace…</p>;
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

export function useApi(): ApiContextValue {
  const value = useContext(ApiContext);
  if (!value) throw new Error("useApi must be rendered inside ApiProvider");
  return value;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Unexpected gateway error";
}
