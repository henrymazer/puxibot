import { CalendarClock } from "lucide-react";
import { PageHeader } from "../shell/PageHeader";
import { RoutineList } from "./RoutineList";

export function RoutinesPage() {
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <PageHeader title="Rotinas" icon={<CalendarClock className="size-5" />} subtitle="Trabalhos agendados dos agentes" />
      <div className="tb-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:p-6">
          <RoutineList showAgent />
        </div>
      </div>
    </div>
  );
}
