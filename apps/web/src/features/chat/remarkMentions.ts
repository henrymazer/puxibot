/** Plugin remark: destaca @menções em nós de texto (nunca dentro de código). */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

const RX = /(^|[^\w@])@([a-z0-9][a-z0-9_-]{1,31})\b/gi;

export function splitMentions(value: string, agentHandles?: Set<string>): MdNode[] {
  const out: MdNode[] = [];
  let last = 0;
  for (const m of value.matchAll(RX)) {
    const start = (m.index ?? 0) + m[1]!.length;
    if (start > last) out.push({ type: "text", value: value.slice(last, start) });
    const handle = m[2]!.toLowerCase();
    const isAgent = agentHandles?.has(handle) ?? false;
    out.push({
      type: "mention",
      data: { hName: "span", hProperties: { className: isAgent ? "tb-mention tb-mention-agent" : "tb-mention" } },
      children: [{ type: "text", value: `@${m[2]}` }],
    });
    last = start + 1 + m[2]!.length;
  }
  if (last === 0) return [{ type: "text", value }];
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

function walk(node: MdNode, agentHandles?: Set<string>) {
  if (!node.children) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && child.value && child.value.includes("@")) next.push(...splitMentions(child.value, agentHandles));
    else {
      if (child.type !== "code" && child.type !== "inlineCode" && child.type !== "link") walk(child, agentHandles);
      next.push(child);
    }
  }
  node.children = next;
}

export function remarkMentions(options: { agentHandles?: Set<string> } = {}) {
  return (tree: MdNode) => walk(tree, options.agentHandles);
}
