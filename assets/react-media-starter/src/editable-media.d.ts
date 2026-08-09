type EditableMediaFrame = {seconds: number; generation: number};

type EditableMediaFrameError = {
  code: string;
  message: string;
  retryable?: boolean;
};

interface EditableMediaFrameProtocol {
  readonly duration: number;
  seek(seconds: number): Promise<{
    seconds: number;
    generation: number;
    wait_ms: number;
    tasks: Array<{label: string; elapsed_ms: number}>;
  }>;
  registerRenderer(
    id: string,
    renderer: (frame: EditableMediaFrame) => void | Promise<void>,
  ): void;
  deferFrame(options: {
    label: string;
    timeout_ms?: number;
    retryable?: boolean;
  }): string;
  resolveFrame(handle: string): void;
  rejectFrame(handle: string, error: EditableMediaFrameError): void;
}

interface Window {
  __hf: EditableMediaFrameProtocol;
}
