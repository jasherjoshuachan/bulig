import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Call {
  method: string;
  params: Record<string, any>;
}

interface Pending {
  update_id: number;
  [key: string]: unknown;
}

type Fault = { kind: 'status'; status: number; body: unknown } | { kind: 'drop' };

/**
 * A stand-in for the Telegram Bot API on a local port. It keeps the real rules that matter here:
 * an update is delivered again until a later getUpdates call asks for a higher offset, and a long
 * poll waits for news. Faults can be queued per method to test retries.
 */
export class FakeTelegram {
  readonly calls: Call[] = [];
  readonly token: string;
  private server: Server;
  private updates: Pending[] = [];
  private nextUpdateId = 100;
  private nextMessageId = 1;
  private faults = new Map<string, Fault[]>();
  private sockets = new Set<import('node:net').Socket>();
  apiBase = '';

  constructor(token = 'fake-token-123') {
    this.token = token;
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.apiBase = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** A text message from a chat. */
  say(chatId: number, text: string): void {
    this.updates.push({ update_id: this.nextUpdateId++, message: { message_id: this.nextMessageId++, text, chat: { id: chatId } } });
  }

  /** A press on an inline button of a message the bot sent. */
  press(chatId: number, messageId: number, text: string, data: string, from: Record<string, string> = { username: 'jasher' }): void {
    this.updates.push({
      update_id: this.nextUpdateId++,
      callback_query: { id: `cb${this.nextUpdateId}`, data, from, message: { message_id: messageId, text, chat: { id: chatId } } },
    });
  }

  fail(method: string, fault: Fault): void {
    this.faults.set(method, [...(this.faults.get(method) ?? []), fault]);
  }

  of(method: string): Call[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** Text of every message sent to a chat, in order. */
  texts(chatId?: number): string[] {
    return this.of('sendMessage')
      .filter((c) => chatId === undefined || c.params.chat_id === chatId)
      .map((c) => String(c.params.text));
  }

  /** The id the fake gave the n-th sent message (they count up from 1 in send order across all sendMessage calls). */
  messageIdOf(index: number): number {
    return this.of('sendMessage').filter((c) => c.params.__id !== undefined)[index]!.params.__id;
  }

  private async handle(req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (!m || m[1] !== this.token) return send(401, { ok: false, error_code: 401, description: 'Unauthorized' });
    const method = m[2]!;
    const params = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    this.calls.push({ method, params });

    const fault = this.faults.get(method)?.shift();
    if (fault?.kind === 'drop') return void req.socket.destroy();
    if (fault?.kind === 'status') return send(fault.status, fault.body);

    if (method === 'getUpdates') {
      const offset: number = params.offset ?? 0;
      this.updates = this.updates.filter((u) => u.update_id >= offset);
      const deadline = Date.now() + Math.min(Number(params.timeout ?? 0) * 1000, 60);
      while (this.updates.length === 0 && Date.now() < deadline && !req.socket.destroyed) await new Promise((r) => setTimeout(r, 5));
      return send(200, { ok: true, result: [...this.updates] });
    }
    if (method === 'sendMessage') {
      const id = this.nextMessageId++;
      params.__id = id;
      return send(200, { ok: true, result: { message_id: id, chat: { id: params.chat_id }, text: params.text } });
    }
    return send(200, { ok: true, result: true });
  }
}

/** Wait until a condition holds. Fails the test with the message when it never does. */
export async function until(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
