import { describe, expect, it } from "vitest";
import type { ChannelDTO } from "@puxibot/shared";
import { routineChannelsFor } from "./routineChannels";

const ch = (id: string, over: Partial<ChannelDTO> = {}): ChannelDTO => ({
  id,
  kind: "channel",
  name: id,
  section: null,
  topic: null,
  humansOnly: false,
  isPrivate: false,
  members: [],
  unread: 0,
  lastMessageAt: null,
  ...over,
});

describe("routineChannelsFor", () => {
  it("oferece canais abertos e os privados/DMs de que o agente é membro, nunca só de humanos", () => {
    const list = [
      ch("geral"),
      ch("humanos", { humansOnly: true }),
      ch("privado-sem", { isPrivate: true, members: [{ type: "user", id: "u1" }] }),
      ch("privado-com", { isPrivate: true, members: [{ type: "agent", id: "a1" }] }),
      ch("privado-humanos", { isPrivate: true, humansOnly: true, members: [{ type: "agent", id: "a1" }] }),
      ch("dm-a1", { kind: "dm", members: [{ type: "user", id: "u1" }, { type: "agent", id: "a1" }] }),
      ch("dm-a2", { kind: "dm", members: [{ type: "user", id: "u1" }, { type: "agent", id: "a2" }] }),
      ch("dm-pessoas", { kind: "dm", members: [{ type: "user", id: "u1" }, { type: "user", id: "u2" }] }),
    ];
    expect(routineChannelsFor(list, "a1").map((c) => c.id)).toEqual(["geral", "privado-com", "dm-a1"]);
  });
});
