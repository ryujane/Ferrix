import { cleanup, signal } from "nsh";
import type {
  RedisPubSub,
  RedisPubSubMessage,
  RedisSession,
} from "ferrix/native";
import { t } from "../../i18n";
import { safeError } from "../../utils/errors";
import { display, encode, hex, text, unhex } from "./pubsub-values";

export const p = (key: string, values?: Record<string, unknown>) =>
  t(`pubsub.${key}`, values);
export type PubSubReceiver = Pick<
  RedisPubSub,
  | "subscribe"
  | "unsubscribe"
  | "drain"
  | "getInfo"
  | "clear"
  | "close"
  | "closeAndWait"
  | "dispose"
>;
export type PubSubSession = {
  openPubSub: () => Promise<PubSubReceiver>;
  publish: RedisSession["publish"];
};
export type Subscription = {
  id: string;
  name: string;
  pattern: boolean;
  count: number;
};
export type Message = RedisPubSubMessage & {
  channelName: string;
  payloadText: string;
  binary: boolean;
};

export function createPubSubState(session: PubSubSession) {
  const subscriptions = signal<Subscription[]>([]),
    messages = signal<Message[]>([]),
    selected = signal<string>(),
    channel = signal<string>();
  const busy = signal(false),
    publishing = signal(false),
    paused = signal(false),
    closed = signal(false),
    error = signal("");
  const received = signal("0"),
    dropped = signal("0"),
    queued = signal(0),
    evicted = signal(0),
    rate = signal(0),
    published = signal<string>();
  const target = signal(""),
    draft = signal(""),
    encoding = signal("utf8"),
    uncertain = signal(false);
  let receiver: PubSubReceiver | undefined,
    opening: Promise<PubSubReceiver> | undefined,
    disposed = false;
  let sampledAt = Date.now(),
    sampledCount = 0;
  function disposeReceiver() {
    receiver?.close();
    receiver?.dispose();
    receiver = undefined;
  }
  cleanup(() => {
    disposed = true;
    receiver?.close();
    receiver?.dispose();
  });

  async function ensureReceiver(): Promise<PubSubReceiver> {
    if (receiver) return receiver;
    if (!opening)
      opening = session
        .openPubSub()
        .then((next) => {
          if (disposed) {
            next.close();
            next.dispose();
            throw new Error("Disposed");
          }
          receiver = next;
          return next;
        })
        .finally(() => {
          opening = undefined;
        });
    return opening;
  }
  async function subscribe(name: string, pattern: boolean) {
    if (busy() || !name.length || closed()) return false;
    const id = `${pattern ? "p" : "s"}:${hex(encode(name))}`;
    if (subscriptions().some((item) => item.id === id)) {
      channel.set(id);
      return true;
    }
    busy.set(true);
    error.set("");
    try {
      await (await ensureReceiver()).subscribe(encode(name), pattern);
      if (disposed) return false;
      subscriptions.set([...subscriptions(), { id, name, pattern, count: 0 }]);
      if (!pattern) target.set(name);
      return true;
    } catch (cause) {
      if (!disposed) error.set(safeError(cause));
      return false;
    } finally {
      if (!disposed) busy.set(false);
    }
  }
  async function unsubscribe(item: Subscription) {
    if (busy() || closed() || !receiver) return;
    busy.set(true);
    error.set("");
    try {
      await receiver.unsubscribe(encode(item.name), item.pattern);
      if (disposed) return;
      subscriptions.set(subscriptions().filter((next) => next.id !== item.id));
      if (channel() === item.id) channel.set(undefined);
    } catch (cause) {
      if (!disposed) error.set(safeError(cause));
    } finally {
      if (!disposed) busy.set(false);
    }
  }
  function poll() {
    if (!receiver || disposed || busy()) return;
    const batch = paused()
      ? { ...receiver.getInfo(), messages: [] }
      : receiver.drain();
    queued.set(batch.queued);
    received.set(batch.received);
    dropped.set(batch.dropped);
    closed.set(batch.closed);
    if (batch.closed && batch.errorCode)
      error.set(`${p("connectionLost")} (${batch.errorCode})`);
    if (Date.now() - sampledAt >= 1000) {
      rate.set(
        Math.round(
          ((Number(batch.received) - sampledCount) * 1000) /
            (Date.now() - sampledAt),
        ),
      );
      sampledAt = Date.now();
      sampledCount = Number(batch.received);
    }
    if (!batch.messages.length) return;
    const incoming = batch.messages.map((message) => {
      const decoded = text(message.payload);
      return {
        ...message,
        channelName: display(message.channel),
        payloadText: decoded ?? hex(message.payload),
        binary: decoded === undefined,
      };
    });
    const counts = new Map<string, number>();
    for (const message of incoming) {
      const id = `${message.pattern ? "p" : "s"}:${hex(message.pattern ?? message.channel)}`;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    subscriptions.set(
      subscriptions().map((item) => ({
        ...item,
        count: item.count + (counts.get(item.id) ?? 0),
      })),
    );
    const next = [...messages(), ...incoming];
    let bytes = next.reduce(
        (sum, item) =>
          sum +
          item.channel.length +
          (item.pattern?.length ?? 0) +
          item.payload.length,
        0,
      ),
      removed = 0;
    while (next.length > 500 || bytes > 4 * 1024 * 1024) {
      const old = next.shift()!;
      bytes -=
        old.channel.length + (old.pattern?.length ?? 0) + old.payload.length;
      removed++;
    }
    evicted.set(evicted() + removed);
    messages.set(next);
    if (selected() && !next.some((item) => item.id === selected()))
      selected.set(undefined);
  }
  const timer = setInterval(poll, 100);
  cleanup(() => clearInterval(timer));
  async function reconnect() {
    if (busy()) return;
    busy.set(true);
    error.set("");
    const previous = receiver;
    receiver = undefined;
    messages.set([]);
    selected.set(undefined);
    received.set("0");
    dropped.set("0");
    evicted.set(0);
    sampledCount = 0;
    sampledAt = Date.now();
    try {
      if (previous) {
        try {
          await previous.closeAndWait();
        } finally {
          previous.dispose();
        }
      }
      if (disposed) return;
      const next = await ensureReceiver();
      for (const item of subscriptions())
        await next.subscribe(encode(item.name), item.pattern);
      if (!disposed) {
        closed.set(false);
        subscriptions.set(
          subscriptions().map((item) => ({ ...item, count: 0 })),
        );
      }
    } catch (cause) {
      disposeReceiver();
      if (!disposed) {
        closed.set(true);
        error.set(safeError(cause));
      }
    } finally {
      if (!disposed) busy.set(false);
    }
  }
  async function publish() {
    if (publishing() || !target().length || uncertain()) return;
    const payload = encoding() === "hex" ? unhex(draft()) : encode(draft());
    if (!payload) {
      error.set(p("invalidHex"));
      return;
    }
    publishing.set(true);
    error.set("");
    published.set(undefined);
    try {
      const result = await session.publish(encode(target()), payload);
      if (!disposed) published.set(result.receivers);
    } catch (cause) {
      if (!disposed) {
        uncertain.set(
          (cause as { code?: string })?.code === "WRITE_OUTCOME_UNKNOWN",
        );
        error.set(uncertain() ? p("unknownWrite") : safeError(cause));
      }
    } finally {
      if (!disposed) publishing.set(false);
    }
  }
  function load(message: Message) {
    if (publishing() || text(message.channel) === undefined) return;
    target.set(message.channelName);
    draft.set(message.payloadText);
    encoding.set(message.binary ? "hex" : "utf8");
    published.set(undefined);
  }
  return {
    subscriptions,
    messages,
    selected,
    channel,
    busy,
    publishing,
    paused,
    closed,
    error,
    received,
    dropped,
    queued,
    evicted,
    rate,
    published,
    target,
    draft,
    encoding,
    uncertain,
    subscribe,
    unsubscribe,
    reconnect,
    publish,
    load,
    poll,
    clear: () => {
      receiver?.clear();
      queued.set(0);
      messages.set([]);
      selected.set(undefined);
    },
    exportData: () =>
      JSON.stringify(
        {
          version: 1,
          received: received(),
          dropped: dropped(),
          evicted: evicted(),
          messages: messages().map((item) => ({
            id: item.id,
            timestampMs: item.timestampMs,
            channelHex: hex(item.channel),
            channel: item.channelName,
            patternHex: item.pattern ? hex(item.pattern) : null,
            payloadHex: hex(item.payload),
            payload: text(item.payload) ?? null,
          })),
        },
        null,
        2,
      ),
  };
}
export type PubSubState = ReturnType<typeof createPubSubState>;
