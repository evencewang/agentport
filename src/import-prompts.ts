export interface PromptOption<Value> {
  value: Value;
  label: string;
  hint?: string;
}

export interface SelectPrompt<Value> {
  message: string;
  options: PromptOption<Value>[];
  initialValue?: Value;
}

export interface MultiSelectPrompt<Value> {
  message: string;
  options: PromptOption<Value>[];
  initialValues?: Value[];
  required?: boolean;
}

export interface TextPrompt {
  message: string;
  initialValue?: string;
  placeholder?: string;
  validate?: (value: string) => string | undefined;
}

export interface ConfirmPrompt {
  message: string;
  initialValue?: boolean;
}

export const PROMPT_CANCEL = Symbol("prompt-cancel");
export type PromptCancelled = typeof PROMPT_CANCEL;

export interface PromptAdapter {
  start: (title: string) => void;
  message: (text: string) => void;
  note: (text: string) => void;
  select: <Value>(prompt: SelectPrompt<Value>) => Promise<Value | PromptCancelled>;
  multiselect: <Value>(prompt: MultiSelectPrompt<Value>) => Promise<Value[] | PromptCancelled>;
  text: (prompt: TextPrompt) => Promise<string | PromptCancelled>;
  confirm: (prompt: ConfirmPrompt) => Promise<boolean | PromptCancelled>;
  cancel: (text: string) => void;
  finish: (text: string) => void;
}

export function isCancelled<T>(value: T | PromptCancelled): value is PromptCancelled {
  return value === PROMPT_CANCEL;
}

interface QueueAction {
  type: "select" | "multiselect" | "text" | "confirm";
  matcher?: (message: string) => boolean;
  value: unknown;
}

export interface MockPromptOptions {
  recordedMessages?: string[];
  recordedNotes?: string[];
}

export class MockPromptAdapter implements PromptAdapter {
  private readonly queue: QueueAction[] = [];
  public readonly notes: string[] = [];
  public readonly messages: string[] = [];
  public cancelled = false;
  public title = "";
  public lastFinish = "";

  enqueueSelect<Value>(value: Value | PromptCancelled, matcher?: (message: string) => boolean): void {
    this.queue.push({ type: "select", matcher, value });
  }

  enqueueMultiSelect<Value>(value: Value[] | PromptCancelled, matcher?: (message: string) => boolean): void {
    this.queue.push({ type: "multiselect", matcher, value });
  }

  enqueueText(value: string | PromptCancelled, matcher?: (message: string) => boolean): void {
    this.queue.push({ type: "text", matcher, value });
  }

  enqueueConfirm(value: boolean | PromptCancelled, matcher?: (message: string) => boolean): void {
    this.queue.push({ type: "confirm", matcher, value });
  }

  start(title: string): void {
    this.title = title;
  }

  message(text: string): void {
    this.messages.push(text);
  }

  note(text: string): void {
    this.notes.push(text);
  }

  async select<Value>(prompt: SelectPrompt<Value>): Promise<Value | PromptCancelled> {
    return this.dequeue("select", prompt.message) as Value | PromptCancelled;
  }

  async multiselect<Value>(prompt: MultiSelectPrompt<Value>): Promise<Value[] | PromptCancelled> {
    return this.dequeue("multiselect", prompt.message) as Value[] | PromptCancelled;
  }

  async text(prompt: TextPrompt): Promise<string | PromptCancelled> {
    return this.dequeue("text", prompt.message) as string | PromptCancelled;
  }

  async confirm(prompt: ConfirmPrompt): Promise<boolean | PromptCancelled> {
    return this.dequeue("confirm", prompt.message) as boolean | PromptCancelled;
  }

  cancel(text: string): void {
    this.cancelled = true;
    this.lastFinish = text;
  }

  finish(text: string): void {
    this.lastFinish = text;
  }

  private dequeue(type: QueueAction["type"], message: string): unknown {
    const index = this.queue.findIndex(
      (action) => action.type === type && (!action.matcher || action.matcher(message))
    );
    if (index === -1) {
      throw new Error(`MockPromptAdapter: unexpected ${type} prompt for "${message}".`);
    }
    const [action] = this.queue.splice(index, 1);
    return action!.value;
  }

  remaining(): QueueAction[] {
    return [...this.queue];
  }
}

export async function createClackPromptAdapter(): Promise<PromptAdapter> {
  const clack = await import("@clack/prompts");

  const wrap = <T>(value: T | symbol): T | PromptCancelled => {
    return clack.isCancel(value) ? PROMPT_CANCEL : (value as T);
  };

  return {
    start: (title) => clack.intro(title),
    message: (text) => clack.log.message(text),
    note: (text) => clack.note(text),
    select: async <Value>(prompt: SelectPrompt<Value>) => {
      const value = await clack.select({
        message: prompt.message,
        options: prompt.options as Array<{ value: unknown; label: string; hint?: string }>,
        ...(prompt.initialValue !== undefined ? { initialValue: prompt.initialValue } : {})
      });
      return wrap(value) as Value | PromptCancelled;
    },
    multiselect: async <Value>(prompt: MultiSelectPrompt<Value>) => {
      const value = await clack.multiselect({
        message: prompt.message,
        options: prompt.options as Array<{ value: unknown; label: string; hint?: string }>,
        ...(prompt.initialValues !== undefined ? { initialValues: prompt.initialValues } : {}),
        required: prompt.required ?? false
      });
      return wrap(value) as Value[] | PromptCancelled;
    },
    text: async (prompt) => {
      const validateFn = prompt.validate;
      const value = await clack.text({
        message: prompt.message,
        ...(prompt.initialValue !== undefined ? { initialValue: prompt.initialValue } : {}),
        ...(prompt.placeholder !== undefined ? { placeholder: prompt.placeholder } : {}),
        ...(validateFn
          ? {
              validate: (input: string | undefined) => validateFn(input ?? "")
            }
          : {})
      });
      return wrap(value);
    },
    confirm: async (prompt) => {
      const value = await clack.confirm({
        message: prompt.message,
        initialValue: prompt.initialValue ?? true
      });
      return wrap(value);
    },
    cancel: (text) => clack.cancel(text),
    finish: (text) => clack.outro(text)
  };
}
