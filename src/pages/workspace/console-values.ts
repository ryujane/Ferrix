import fallback from "./redis-commands.json";

export type CommandArgument = {
  name: string;
  type: string;
  display_text?: string;
  token?: string;
  optional?: boolean;
  multiple?: boolean;
  multiple_token?: boolean;
  arguments?: CommandArgument[];
};
export type ConsoleCommand = {
  name: string;
  summary?: string;
  arguments?: CommandArgument[];
};
export type Completion = {
  id: string;
  label: string;
  detail: string;
  value: string;
  start: number;
  end: number;
  kind: "command" | "keyword";
};
export const fallbackCommands = fallback as ConsoleCommand[];
const encoder = new TextEncoder();
type Token = {
  value: string;
  bytes: Uint8Array;
  start: number;
  end: number;
  quoted: boolean;
  complete: boolean;
};

function tokens(input: string, strict = false): Token[] {
  const result: Token[] = [];
  let at = 0;
  while (at < input.length) {
    if (/\s/.test(input[at])) {
      at++;
      continue;
    }
    const start = at,
      bytes: number[] = [];
    let quote = "",
      quoted = false,
      complete = true;
    while (at < input.length) {
      const c = input[at];
      if (!quote && /\s/.test(c)) break;
      if (c === quote) {
        quote = "";
        at++;
        continue;
      }
      if (!quote && (c === '"' || c === "'")) {
        quote = c;
        quoted = true;
        at++;
        continue;
      }
      if (c === "\\") {
        const next = input[at + 1];
        if (next === undefined) {
          complete = false;
          at++;
          break;
        }
        if (quote === "'" && next !== "'" && next !== "\\") {
          bytes.push(92);
          at++;
          continue;
        }
        if (
          quote === '"' &&
          next === "x" &&
          /^[\da-f]{2}$/i.test(input.slice(at + 2, at + 4))
        ) {
          bytes.push(parseInt(input.slice(at + 2, at + 4), 16));
          at += 4;
          continue;
        }
        const escaped: Record<string, number> = {
          n: 10,
          r: 13,
          t: 9,
          b: 8,
          a: 7,
        };
        if (quote === '"' && escaped[next] !== undefined) {
          bytes.push(escaped[next]);
          at += 2;
          continue;
        }
        const character = String.fromCodePoint(input.codePointAt(at + 1)!);
        bytes.push(...encoder.encode(character));
        at += character.length + 1;
        continue;
      }
      const character = String.fromCodePoint(input.codePointAt(at)!);
      bytes.push(...encoder.encode(character));
      at += character.length;
    }
    complete = complete && !quote;
    if (strict && !complete) throw new Error("Unclosed command argument");
    const binary = new Uint8Array(bytes);
    result.push({
      value: new TextDecoder().decode(binary),
      bytes: binary,
      start,
      end: at,
      quoted,
      complete,
    });
  }
  return result;
}
export const parseConsoleCommand = (input: string) =>
  tokens(input, true).map((token) => token.bytes);
export function consoleCommand(
  input: string,
  commands: ConsoleCommand[],
): ConsoleCommand | undefined {
  const words = tokens(input).map((token) => token.value.toUpperCase());
  return commands
    .filter((command) =>
      command.name.split(" ").every((word, i) => word === words[i]),
    )
    .sort((a, b) => b.name.length - a.name.length)[0];
}
function argumentSyntax(arg: CommandArgument): string {
  let value =
    arg.type === "oneof"
      ? (arg.arguments ?? []).map(argumentSyntax).join(" | ")
      : arg.type === "block"
        ? (arg.arguments ?? []).map(argumentSyntax).join(" ")
        : arg.type === "pure-token"
          ? ""
          : `<${arg.display_text ?? arg.name}>`;
  if (arg.token) value = [arg.token, value].filter(Boolean).join(" ");
  if (arg.multiple) value += " ...";
  return arg.optional ? `[${value}]` : value;
}
export const commandSyntax = (command?: ConsoleCommand) =>
  command
    ? [command.name, ...(command.arguments ?? []).map(argumentSyntax)].join(" ")
    : "";

type ArgumentScope = { optional?: boolean; repeated?: boolean };
type Edge = ArgumentScope & {
  to: number;
  literal?: string;
  argument?: CommandArgument;
};
type Node = {
  next: { to: number; guard?: bigint; add?: bigint }[];
  edges: Edge[];
};
type Grammar = { nodes: Node[]; start: number; end: number };
const grammars = new WeakMap<ConsoleCommand, Grammar>();
function grammar(command: ConsoleCommand): Grammar {
  const cached = grammars.get(command);
  if (cached) return cached;
  const nodes: Node[] = [],
    node = () => {
      nodes.push({ next: [], edges: [] });
      return nodes.length - 1;
    };
  let group = 0n;
  const link = (from: number, to: number, guard?: bigint, add?: bigint) =>
    nodes[from].next.push({ to, guard, add });
  function sequence(
    args: CommandArgument[],
    start: number,
    end: number,
    scope: ArgumentScope = {},
  ) {
    let from = start;
    for (let i = 0; i < args.length; ) {
      let last = i;
      while (last < args.length && args[last].optional) last++;
      if (last - i > 1) {
        // Redis accepts sibling options in any order, while each oneof remains exclusive.
        const hub = node(),
          after = node();
        link(from, hub);
        link(hub, after);
        for (const arg of args.slice(i, last)) {
          const begin = node(),
            done = node(),
            bit = arg.multiple ? 0n : 1n << group++;
          link(hub, begin, bit);
          argument({ ...arg, optional: false }, begin, done, arg, {
            ...scope,
            optional: true,
          });
          link(done, hub, undefined, bit);
        }
        from = after;
        i = last;
      } else {
        const to = node();
        argument(args[i], from, to, args[i], scope);
        from = to;
        i++;
      }
    }
    link(from, end);
  }
  function argument(
    arg: CommandArgument,
    start: number,
    end: number,
    source = arg,
    inherited: ArgumentScope = {},
  ) {
    const scope = {
      optional: inherited.optional || source.optional,
      repeated: inherited.repeated || source.multiple,
    };
    const content = node(),
      done = node();
    link(start, content);
    if (arg.optional) link(start, end);
    let from = content;
    if (arg.token) {
      from = node();
      nodes[content].edges.push({
        to: from,
        literal: arg.token,
        argument: source,
        ...scope,
      });
    }
    if (arg.type === "oneof")
      for (const child of arg.arguments ?? [])
        argument(child, from, done, child, scope);
    else if (arg.type === "block")
      sequence(arg.arguments ?? [], from, done, scope);
    else if (arg.type === "pure-token") link(from, done);
    else nodes[from].edges.push({ to: done, argument: source, ...scope });
    link(done, end);
    if (arg.multiple)
      link(
        done,
        arg.multiple_token || arg.type === "pure-token" ? content : from,
      );
  }
  const start = node(),
    end = node();
  sequence(command.arguments ?? [], start, end);
  const result = { nodes, start, end };
  grammars.set(command, result);
  return result;
}
function inspectArguments(
  command: ConsoleCommand,
  words: string[],
): { edges: Edge[]; complete: boolean } {
  const { nodes, start, end } = grammar(command);
  type Position = { node: number; used: bigint };
  function closure(seeds: Position[]) {
    const seen = new Set<string>(),
      pending: Position[] = [];
    function add(position: Position) {
      const key = `${position.node}:${position.used}`;
      if (!seen.has(key) && pending.length < 2048) {
        seen.add(key);
        pending.push(position);
      }
    }
    seeds.forEach(add);
    for (let i = 0; i < pending.length; i++)
      for (const edge of nodes[pending[i].node].next) {
        if (!edge.guard || !(pending[i].used & edge.guard))
          add({ node: edge.to, used: pending[i].used | (edge.add ?? 0n) });
      }
    return pending;
  }
  let active = closure([{ node: start, used: 0n }]);
  for (const word of words) {
    const next: Position[] = [];
    for (const position of active)
      for (const edge of nodes[position.node].edges) {
        if (
          edge.literal
            ? edge.literal.toUpperCase() === word.toUpperCase()
            : edge.argument?.type === "integer"
              ? /^-?\d+$/.test(word)
              : true
        )
          next.push({ node: edge.to, used: position.used });
      }
    active = closure(next);
    if (!active.length) break;
  }
  return {
    edges: active.flatMap((position) => nodes[position.node].edges),
    complete: active.some((position) => position.node === end),
  };
}
const expected = (command: ConsoleCommand, words: string[]) =>
  inspectArguments(command, words).edges;

export type ParameterHint = {
  commandName: string;
  mode: "command" | "argument" | "options" | "complete" | "unavailable";
  syntax: { text: string; active: boolean }[];
  parameters: {
    name: string;
    type: string;
    token?: string;
    repeated: boolean;
  }[];
  required: boolean;
};
export function consoleParameterHint(
  input: string,
  cursor: number,
  commands: ConsoleCommand[],
): ParameterHint | undefined {
  if (input.length > 8192) return undefined;
  const command = consoleCommand(input, commands);
  if (!command) return undefined;
  const before = tokens(input.slice(0, cursor));
  const trailing =
    cursor > 0 &&
    /\s/.test(input[cursor - 1]) &&
    (before[before.length - 1]?.complete ?? true);
  const current = trailing ? undefined : before.pop(),
    prefix = current?.value ?? "";
  const words = before.map((token) => token.value),
    commandLength = command.name.split(" ").length;
  const typingCommand =
    words.length < commandLength ||
    !command.name
      .split(" ")
      .every((word, index) => word === words[index]?.toUpperCase());
  const state = inspectArguments(command, words.slice(commandLength));
  let edges = typingCommand ? [] : state.edges;
  const matchingOptions = prefix
    ? edges.filter((edge) =>
        edge.literal?.toUpperCase().startsWith(prefix.toUpperCase()),
      )
    : [];
  const values = edges.filter((edge) => !edge.literal);
  // A typed option takes precedence over a free-form value at an ambiguous position.
  edges = matchingOptions.length
    ? matchingOptions
    : values.length
      ? values
      : edges.filter(
          (edge) =>
            !prefix ||
            edge.literal?.toUpperCase().startsWith(prefix.toUpperCase()),
        );
  const literal = edges.length > 0 && edges.every((edge) => !!edge.literal);
  const seen = new Set<string>();
  const parameters: ParameterHint["parameters"] = [];
  for (const edge of edges)
    if (edge.argument) {
      const name =
          edge.literal ?? edge.argument.display_text ?? edge.argument.name,
        type = edge.literal ? "pure-token" : edge.argument.type;
      const key = `${type}:${name}`;
      if (!seen.has(key)) {
        seen.add(key);
        parameters.push({
          name,
          type,
          token: edge.literal ? undefined : edge.argument.token,
          repeated: !!edge.repeated,
        });
      }
    }
  const syntax: ParameterHint["syntax"] = [
    { text: command.name, active: false },
  ];
  function part(text: string, arg?: CommandArgument, token = false) {
    syntax.push({
      text,
      active:
        !!arg &&
        edges.some((edge) => edge.argument === arg && !!edge.literal === token),
    });
  }
  function argument(arg: CommandArgument) {
    if (arg.optional) part("[");
    if (arg.token) {
      part(arg.token, arg, true);
      if (arg.type !== "pure-token") part(" ");
    }
    if (arg.type === "block" || arg.type === "oneof")
      (arg.arguments ?? []).forEach((child, index) => {
        if (index) part(arg.type === "oneof" ? " | " : " ");
        argument(child);
      });
    else if (arg.type !== "pure-token")
      part(`<${arg.display_text ?? arg.name}>`, arg);
    if (arg.multiple) part(" ...");
    if (arg.optional) part("]");
  }
  for (const arg of command.arguments ?? []) {
    part(" ");
    argument(arg);
  }
  const container = commands.some((item) =>
    item.name.startsWith(command.name + " "),
  );
  const noArguments =
    command.arguments?.length === 0 &&
    !container &&
    tokens(input).length === commandLength &&
    cursor === input.length;
  const mode =
    command.arguments === undefined
      ? "unavailable"
      : noArguments
        ? "complete"
        : typingCommand || container
          ? "command"
          : parameters.length
            ? literal
              ? "options"
              : "argument"
            : state.complete && !prefix
              ? "complete"
              : "unavailable";
  return {
    commandName: command.name,
    mode,
    syntax,
    parameters,
    required: literal ? edges.some((edge) => !edge.optional) : !state.complete,
  };
}
export function consoleCompletions(
  input: string,
  cursor: number,
  commands: ConsoleCommand[],
): Completion[] {
  if (input.length > 8192) return [];
  const before = tokens(input.slice(0, cursor));
  const trailing =
    cursor > 0 &&
    /\s/.test(input[cursor - 1]) &&
    (before[before.length - 1]?.complete ?? true);
  const current = trailing ? undefined : before.pop();
  const prefix = current?.value ?? "",
    start = current?.start ?? cursor;
  const completeToken = tokens(input).find((token) => token.start === start);
  const end = completeToken?.end ?? cursor;
  const words = before.map((token) => token.value),
    upper = words.map((word) => word.toUpperCase());
  const result: Completion[] = [],
    seen = new Set<string>();
  function add(
    label: string,
    kind: Completion["kind"],
    detail: string,
    value = label,
  ) {
    if (
      !label.toUpperCase().startsWith(prefix.toUpperCase()) ||
      seen.has(`${kind}:${label}`)
    )
      return;
    seen.add(`${kind}:${label}`);
    result.push({
      id: `${kind}:${label}`,
      label,
      detail,
      value,
      start,
      end,
      kind,
    });
  }
  for (const command of commands) {
    const parts = command.name.split(" ");
    if (
      upper.length < parts.length &&
      upper.every((word, i) => word === parts[i])
    )
      add(
        parts[upper.length],
        "command",
        command.summary ?? (upper.length ? command.name : ""),
      );
  }
  if (!result.length) {
    const command = consoleCommand(words.join(" "), commands);
    if (command)
      for (const edge of expected(
        command,
        words.slice(command.name.split(" ").length),
      )) {
        if (edge.literal)
          add(
            edge.literal,
            "keyword",
            edge.argument?.type === "pure-token"
              ? ""
              : edge.argument?.type === "block" ||
                  edge.argument?.type === "oneof"
                ? (edge.argument.arguments ?? []).map(argumentSyntax).join(" ")
                : `<${edge.argument?.display_text ?? edge.argument?.name ?? "value"}>`,
          );
      }
  }
  return result
    .sort(
      (a, b) =>
        Number(b.label.toUpperCase() === prefix.toUpperCase()) -
          Number(a.label.toUpperCase() === prefix.toUpperCase()) ||
        a.label.localeCompare(b.label),
    )
    .slice(0, 80);
}
export function insertCompletion(
  input: string,
  item: Completion,
): { value: string; cursor: number } {
  const suffix = input.slice(item.end),
    space = !suffix.startsWith(" ") ? " " : "";
  const value = input.slice(0, item.start) + item.value + space + suffix;
  return {
    value,
    cursor:
      item.start +
      item.value.length +
      (space ? 1 : suffix.startsWith(" ") ? 1 : 0),
  };
}
export function privateCommand(input: string): boolean {
  const words = tokens(input).map((token) => token.value.toUpperCase());
  return (
    words[0] === "AUTH" ||
    (words[0] === "HELLO" && words.includes("AUTH")) ||
    (words[0] === "ACL" && words[1] === "SETUSER") ||
    (words[0] === "CONFIG" && words[1] === "SET") ||
    (words[0] === "SENTINEL" && words[1] === "SET") ||
    (words[0] === "MIGRATE" && words.some((word) => word === "AUTH" || word === "AUTH2"))
  );
}
export function consoleDisplayCommand(input: string): string {
  return privateCommand(input)
    ? `${tokens(input)[0]?.value.toUpperCase() ?? ""} ••••`
    : input;
}
