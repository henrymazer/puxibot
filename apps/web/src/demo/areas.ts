/** Rotas das áreas da segunda leva no modo demonstração. Cada área fica no próprio arquivo. */
import type { DemoContext } from "./backend";
import { registerTasks } from "./areas/tasks";
import { registerWiki } from "./areas/wiki";
import { registerDrive } from "./areas/drive";
import { registerAutomation } from "./areas/automation";
import { registerMisc } from "./areas/misc";
import { registerNotify } from "./areas/notify";

export function registerAreaRoutes(ctx: DemoContext): void {
  registerTasks(ctx);
  registerWiki(ctx);
  registerDrive(ctx);
  registerAutomation(ctx);
  registerMisc(ctx);
  registerNotify(ctx);
}
