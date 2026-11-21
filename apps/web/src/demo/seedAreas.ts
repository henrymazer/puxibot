/** Dados fictícios das áreas da segunda leva (tarefas, wiki, drive, automação). */
import type {
  ActorRef,
  ConnectorDTO,
  RoutineDTO,
  SkillDTO,
  TaskCommentDTO,
  TaskDTO,
  WikiPageDTO,
  WikiRevisionDTO,
} from "@puxibot/shared";
import type { DemoDb } from "./backend";
import { seedTasks } from "./areas/tasks";
import { seedWiki } from "./areas/wiki";
import { seedAutomation } from "./areas/automation";

export interface AreaDb {
  tasks: TaskDTO[];
  taskComments: TaskCommentDTO[];
  taskSeq: number;
  wikiPages: WikiPageDTO[];
  wikiRevisions: WikiRevisionDTO[];
  wikiReads: { pageId: string; reader: ActorRef; at: number }[];
  routines: RoutineDTO[];
  skills: SkillDTO[];
  /** Segredos ficam só aqui (a API nunca devolve). */
  connectors: (ConnectorDTO & { secretHeaders: Record<string, string>; secretEnv: Record<string, string> })[];
  telegram: { linkCode: string | null; linked: boolean };
}

export function seedAreas(base: DemoDb): AreaDb {
  return {
    ...seedTasks(base),
    ...seedWiki(base),
    ...seedAutomation(base),
    telegram: { linkCode: null, linked: false },
  };
}
