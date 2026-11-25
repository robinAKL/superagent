import { AccountError } from './accounts.js';

/**
 * The few Microsoft Graph mail calls mail automation makes, on one mailbox's own delegated token: read new mail in a
 * folder, find or create the "Super Agent" folder, and reply. Nothing else is read or sent.
 */
export interface MailMessage {
  id: string;
  subject: string;
  from: string;
  fromName: string;
  receivedAt: string;
  conversationId: string;
  text: string;
}

export interface MailClient {
  newMail(token: string, folder: string, since: string): Promise<MailMessage[]>;
  folder(token: string, name: string): Promise<string>;
  reply(token: string, messageId: string, text: string): Promise<void>;
}

const GRAPH = 'https://graph.microsoft.com/v1.0';
export const SUPER_AGENT_FOLDER = 'Super Agent';

export function graphMail(network: typeof fetch = fetch): MailClient {
  async function call(token: string, path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const response = await network(GRAPH + path, {
      ...init,
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', prefer: 'outlook.body-content-type="text"', ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 401) throw new AccountError('reauthorize', '这个邮箱需要重新登录授权。', 401);
    if (response.status === 202 || response.status === 204) return {};
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const error = data.error as { code?: string; message?: string } | undefined;
      throw new AccountError('graph_failed', `Microsoft 365 拒绝了请求：${error?.code ?? response.status}`, 502);
    }
    return data;
  }
  return {
    async newMail(token, folder, since) {
      const query = new URLSearchParams({
        $filter: `receivedDateTime ge ${since}`, $orderby: 'receivedDateTime asc', $top: '25',
        $select: 'id,subject,from,receivedDateTime,conversationId,body',
      });
      const data = await call(token, `/me/mailFolders/${encodeURIComponent(folder)}/messages?${query.toString()}`);
      const items = Array.isArray(data.value) ? data.value as Record<string, unknown>[] : [];
      return items.map((item) => {
        const from = (item.from as { emailAddress?: { address?: string; name?: string } } | undefined)?.emailAddress;
        const body = item.body as { content?: string } | undefined;
        return {
          id: String(item.id), subject: typeof item.subject === 'string' ? item.subject : '', from: from?.address ?? '', fromName: from?.name ?? '',
          receivedAt: String(item.receivedDateTime), conversationId: typeof item.conversationId === 'string' ? item.conversationId : String(item.id),
          text: (body?.content ?? '').replace(/\r\n/g, '\n').trim().slice(0, 8000),
        };
      });
    },
    async folder(token, name) {
      const found = await call(token, `/me/mailFolders?${new URLSearchParams({ $filter: `displayName eq '${name.replace(/'/g, "''")}'`, $select: 'id' }).toString()}`);
      const first = Array.isArray(found.value) ? (found.value as { id?: string }[])[0] : undefined;
      if (first?.id) return first.id;
      const made = await call(token, '/me/mailFolders', { method: 'POST', body: JSON.stringify({ displayName: name }) });
      if (typeof made.id !== 'string') throw new AccountError('graph_failed', `没能创建「${name}」文件夹。`, 502);
      return made.id;
    },
    async reply(token, messageId, text) {
      await call(token, `/me/messages/${encodeURIComponent(messageId)}/reply`, { method: 'POST', body: JSON.stringify({ comment: text }) });
    },
  };
}
