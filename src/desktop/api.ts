import type {
  CreateTaskInput, UpdateTaskInput, TaskView, HistoryDay, DailyHistory, DailyEntry, DailyEntryInput,
} from '../core/domain/model.js';

export interface DesktopWindowState {
  collapsed: boolean;
  pinned: boolean;
  demo: boolean;
  today: string;
  timeZone: string;
}

/** 渲染层可访问的完整接口。业务修改携带用户看到的事件版本。 */
export interface DesktopApi {
  journalList(date: string): Promise<DailyEntry[]>;
  journalCreate(input: DailyEntryInput): Promise<DailyEntry>;
  journalUpdate(id: string, input: DailyEntryInput, revision: number): Promise<DailyEntry>;
  journalRemove(id: string, revision: number): Promise<DailyEntry>;
  list(): Promise<TaskView[]>;
  reorder(ids: string[]): Promise<void>;
  create(input: CreateTaskInput): Promise<TaskView>;
  update(id: string, patch: UpdateTaskInput, revision: number): Promise<TaskView>;
  complete(id: string, revision: number): Promise<TaskView>;
  reopen(id: string, revision: number): Promise<TaskView>;
  remove(id: string, revision: number): Promise<TaskView>;
  days(): Promise<HistoryDay[]>;
  day(date: string): Promise<DailyHistory>;
  windowState(): Promise<DesktopWindowState>;
  setCollapsed(collapsed: boolean): Promise<DesktopWindowState>;
  setPinned(pinned: boolean): Promise<DesktopWindowState>;
  hide(): Promise<void>;
  onChange(callback: () => void): () => void;
}

declare global {
  interface Window { planner: DesktopApi }
}
