export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status = 0, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// The admin app sets this to '/admin/api/' so both apps can share one origin in single-port hosting.
let base = '/api/';
export const setApiBase = (value: string) => { base = value; };

export async function api<T = any>(path: string, data?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(base + path, {
      credentials: 'same-origin',
      ...(data !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}),
    });
  } catch {
    throw new ApiError('You appear to be offline. Check your connection and try again.');
  }
  const body = await response.json().catch(() => ({ error: 'The service is temporarily unavailable. Please try again.' }));
  if (!response.ok) throw new ApiError(body.error || 'Something went wrong. Please try again.', response.status, body.code);
  return body as T;
}

export const money = (cents: number, currency = 'ETB') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format((cents || 0) / 100);

export const dateTime = (value: string | number | Date) =>
  new Date(value).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export const shortDate = (value: string | number | Date) => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

export function timeAgo(seconds: number) {
  const diff = Math.max(0, Date.now() / 1000 - seconds);
  if (diff < 60) return 'Just now';
  if (diff < 3600) return Math.floor(diff / 60) + ' min ago';
  if (diff < 86400) return Math.floor(diff / 3600) + ' h ago';
  return new Date(seconds * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const readFileAsBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new ApiError('That file could not be read.'));
    reader.readAsDataURL(file);
  });
