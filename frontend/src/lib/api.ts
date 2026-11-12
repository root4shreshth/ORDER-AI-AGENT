export const API_URL: string = import.meta.env.VITE_API_URL ?? "http://localhost:4000";
export const ADMIN_KEY: string = import.meta.env.VITE_ADMIN_KEY ?? "";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

function agentName(): string {
  try {
    return localStorage.getItem("agentName") || "Support Agent";
  } catch {
    return "Support Agent";
  }
}

async function request<T>(path: string, init: RequestInit & { admin?: boolean; chatToken?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.admin !== false) {
    headers["x-admin-key"] = ADMIN_KEY;
    headers["x-agent-name"] = agentName();
  }
  if (init.chatToken) headers["x-chat-token"] = init.chatToken;
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
  } catch {
    throw new ApiError(0, "NETWORK", "Can't reach the server. Is the backend running?");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body?.error ?? "ERROR", body?.message ?? `Request failed (${res.status})`);
  return body as T;
}

export const api = {
  get: <T,>(path: string) => request<T>(path),
  post: <T,>(path: string, body?: unknown) => request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T,>(path: string, body: unknown) => request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  chat: {
    get: <T,>(path: string, token?: string) => request<T>(path, { admin: false, chatToken: token }),
    post: <T,>(path: string, body: unknown, token?: string) => request<T>(path, { method: "POST", admin: false, chatToken: token, body: JSON.stringify(body) }),
  },
};
