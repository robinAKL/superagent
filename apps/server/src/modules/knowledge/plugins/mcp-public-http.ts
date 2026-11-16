import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent } from 'undici';
import { KnowledgeError } from '../domain.js';

export function isPublicMcpAddress(address: string): boolean {
  // Azure's platform virtual IP is outside the usual private ranges.
  const ip = ipaddr.process(address);
  return ip.range() === 'unicast' && ip.toString() !== '168.63.129.16';
}

export function publicMcpEndpoint(value: unknown): URL {
  try {
    if (typeof value !== 'string' || value.length > 1000) throw Error();
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        host.endsWith('.') || host === 'localhost' || host.endsWith('.localhost') ||
        (isIP(host) ? !isPublicMcpAddress(host) : !host.includes('.'))) throw Error();
    return url;
  } catch {
    throw new KnowledgeError('mcp_invalid_url', '请输入公开可访问的 HTTPS MCP 地址。', 400);
  }
}

const publicDispatcher = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      lookup(hostname, { all: true, family: options.family }, (error, addresses) => {
        if (error || !addresses.length || addresses.some(entry => !isPublicMcpAddress(entry.address))) {
          callback(error ?? new Error('MCP DNS must resolve to public addresses.'), '', 0);
          return;
        }
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      });
    },
  },
});

export const publicMcpFetch: typeof fetch = (input, init) => {
  const endpoint = publicMcpEndpoint(input instanceof Request ? input.url : String(input));
  // The socket uses the vetted DNS result above while preserving the original TLS hostname.
  const options = { ...init, redirect: 'error' as const, dispatcher: publicDispatcher };
  return fetch(endpoint, options);
};
