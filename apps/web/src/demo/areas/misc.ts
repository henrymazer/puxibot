/** Rotas avulsas do modo demonstração: time inicial do onboarding. */
import type { AgentDTO, ChannelDTO, StarterTeamResponse } from "@puxibot/shared";
import { pickStarterTemplate, STARTER_TEMPLATES } from "../../features/onboarding/starterTemplates";
import type { DemoContext } from "../backend";

export function registerMisc(ctx: DemoContext): void {
  const { db, on, emit, W } = ctx;

  on("POST", `${W}/starter-team`, async ({ m, body }) => {
    await ctx.sleep(500);
    const ws = db.workspaces.find((w) => w.id === m[1]) ?? db.workspaces[0]!;
    const business = (body.business as string | undefined) ?? ws.business ?? "";
    const tpl = STARTER_TEMPLATES.find((t) => t.key === business) ?? pickStarterTemplate(business);
    if (!ws.business && business) ws.business = business;
    const now = Date.now();
    let createdChannels = 0;
    let createdAgents = 0;

    const channelByName = (name: string): ChannelDTO | undefined =>
      db.channels.find((c) => c.kind === "channel" && (c.name === name || (name === "general" && c.name === "geral")));

    const channels: ChannelDTO[] = [];
    const needed = new Map(tpl.channels.map((c) => [c.name, c]));
    for (const ag of tpl.agents) for (const n of ag.channels) if (!needed.has(n)) needed.set(n, { name: n, section: "Time", topic: "" });
    for (const c of needed.values()) {
      let ch = channelByName(c.name);
      if (!ch) {
        ch = {
          id: ctx.id("ch"),
          kind: "channel",
          name: c.name,
          section: c.section,
          topic: c.topic || null,
          humansOnly: false,
          isPrivate: false,
          members: db.members.map((x) => ({ type: "user" as const, id: x.userId })),
          unread: 0,
          lastMessageAt: null,
        };
        db.channels.push(ch);
        createdChannels++;
      }
      channels.push(ch);
    }

    const agents: AgentDTO[] = [];
    for (const t of tpl.agents) {
      let agent = db.agents.find((x) => x.handle === t.handle);
      if (!agent) {
        agent = {
          id: ctx.id("agt"),
          handle: t.handle,
          name: t.name,
          role: t.role,
          description: t.description,
          instructions: `Você é ${t.name}, ${t.role.toLowerCase()} do time. ${t.description}`,
          avatarColor: t.avatarColor,
          avatarAccessory: null,
          sectorId: null,
          ownerUserId: db.user.id,
          isAssistant: false,
          accessMode: "workspace",
          allowedUserIds: [],
          agentsCanConsult: true,
          callableAgentsMode: "all",
          callableAgentIds: [],
          preferredCli: null,
          preferredModel: null,
          budgetTokensMonth: null,
          budgetRunsMonth: null,
          selfStartPolicy: "ask",
      trustMode: "ask",
      systemKind: null,
      learnSkills: true,
          maxConcurrentJobs: 2,
          maxPrsPerHour: 3,
          status: "active",
          toolPerms: { messages: "write", memory: "write", tasks: "write", wiki: "write", drive: "write", agents: "write" },
          skillIds: [],
          activity: "idle",
          createdAt: now,
          updatedAt: now,
        };
        db.agents.push(agent);
        createdAgents++;
      }
      agents.push(agent);
      emit({ type: "agent.upserted", agent: { ...agent } });
      for (const n of t.channels) {
        const ch = channelByName(n);
        if (ch && !ch.members.some((x) => x.type === "agent" && x.id === agent!.id)) ch.members.push({ type: "agent", id: agent.id });
      }
    }
    for (const ch of channels) emit({ type: "channel.upserted", channel: { ...ch, members: [...ch.members] } });
    const res: StarterTeamResponse = { template: tpl.key, agents, channels, createdAgents, createdChannels };
    return res;
  });
}
